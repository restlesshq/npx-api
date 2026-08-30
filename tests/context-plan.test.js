import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPlan, operationsFromOas, FILES_PER_BATCH, MAX_BATCHES } from '../lib/context-plan.js';

/**
 * The planner is what turned an unbounded "go find the API" into a short list
 * of files. These tests pin the two properties that matter: the spec decides
 * WHAT is in scope, and the run is always bounded.
 */

describe('operationsFromOas', () => {
  it('lists every method on every path', () => {
    const ops = operationsFromOas({
      paths: {
        '/pets': { get: {}, post: {} },
        '/pets/{id}': { get: {}, delete: {} },
      },
    });
    expect(ops.sort()).toEqual([
      'DELETE /pets/{id}',
      'GET /pets',
      'GET /pets/{id}',
      'POST /pets',
    ]);
  });

  it('ignores non-method keys sitting beside the operations', () => {
    const ops = operationsFromOas({
      paths: { '/pets': { get: {}, parameters: [], summary: 'Pets' } },
    });
    expect(ops).toEqual(['GET /pets']);
  });

  it('survives a spec with no paths', () => {
    expect(operationsFromOas({})).toEqual([]);
    expect(operationsFromOas(null)).toEqual([]);
  });
});

describe('buildPlan', () => {
  let dir;

  // A tiny Next-style repo: three public routes the spec knows about, one
  // internal route it does not, and a middleware file.
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-plan-'));
    const write = (rel, body) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    write('package.json', JSON.stringify({ name: 'petstore', dependencies: { next: '15.0.0' } }));
    write('src/app/api/v1/pets/route.ts', 'export async function GET() {}\nexport async function POST() {}\n');
    write('src/app/api/v1/pets/[id]/route.ts', 'export async function GET() {}\n');
    write('src/app/api/internal/admin/route.ts', 'export async function POST() {}\n');
    write('src/lib/auth.ts', 'export function checkAuth() {}\n');
    write('.restless/openapi.json', JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/api/v1/pets': { get: {}, post: {} },
        '/api/v1/pets/{id}': { get: {} },
      },
    }));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('plans from the local spec and maps each operation to its file', () => {
    const plan = buildPlan({ rootDir: dir, oasFile: '.restless/openapi.json' });
    expect(plan.strategy).toBe('oas');
    expect(plan.specSource).toBe('local');
    expect(plan.coverage.operations).toBe(3);
    expect(plan.coverage.mappedOperations).toBe(3);
    expect(plan.unmappedOperations).toEqual([]);
  });

  it('leaves out routes the spec does not publish', () => {
    // The whole reason the spec is the spine: a blind scan of restlesshq/app
    // finds 235 routes, of which 201 are internal. Documenting those is worse
    // than documenting nothing.
    const plan = buildPlan({ rootDir: dir, oasFile: '.restless/openapi.json' });
    const planned = plan.batches.flatMap((b) => b.files);
    expect(planned.some((f) => f.includes('internal/admin'))).toBe(false);
    expect(plan.coverage.endpointsFound).toBeGreaterThan(plan.coverage.mappedOperations);
  });

  it('falls back to the project spec when the repo has no local copy', () => {
    // The normal case in a docs or SDK repo, which has no `.restless/`.
    const plan = buildPlan({
      rootDir: dir,
      oasFile: '',
      serverOperations: ['GET /api/v1/pets'],
    });
    expect(plan.specSource).toBe('project');
    expect(plan.coverage.mappedOperations).toBe(1);
  });

  it('falls back to the scan when there is no spec at all', () => {
    const plan = buildPlan({ rootDir: dir, oasFile: '' });
    expect(plan.strategy).toBe('scanner');
    // Without a spec it cannot tell public from internal, so the internal
    // route is in scope. That is the weaker mode, and the reason a spec wins.
    const planned = plan.batches.flatMap((b) => b.files);
    expect(planned.some((f) => f.includes('internal/admin'))).toBe(true);
  });

  it('adds a cross-cutting pass that does not re-read the route files', () => {
    const plan = buildPlan({ rootDir: dir, oasFile: '.restless/openapi.json' });
    expect(plan.crossCutting?.files).toContain('src/lib/auth.ts');
    const routeFiles = new Set(plan.batches.flatMap((b) => b.files));
    for (const f of plan.crossCutting.files) expect(routeFiles.has(f)).toBe(false);
  });

  it('narrows to changed files and drops the cross-cutting pass', () => {
    const plan = buildPlan({
      rootDir: dir,
      oasFile: '.restless/openapi.json',
      changedFiles: ['src/app/api/v1/pets/route.ts'],
    });
    expect(plan.batches.flatMap((b) => b.files)).toEqual(['src/app/api/v1/pets/route.ts']);
    // Middleware that did not change has nothing new to say.
    expect(plan.crossCutting).toBeNull();
  });

  it('plans nothing when no changed file serves the API', () => {
    const plan = buildPlan({
      rootDir: dir,
      oasFile: '.restless/openapi.json',
      changedFiles: ['README.md'],
    });
    expect(plan.batches).toEqual([]);
  });

  it('groups files into batches of a known size', () => {
    const plan = buildPlan({ rootDir: dir, oasFile: '.restless/openapi.json' });
    for (const b of plan.batches) expect(b.files.length).toBeLessThanOrEqual(FILES_PER_BATCH);
  });

  it('never exceeds the batch ceiling, and says so when it bites', () => {
    // A monorepo must not silently turn one command into a hundred model
    // calls, and a run that read half the repo must not look like a full one.
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-plan-big-'));
    try {
      fs.writeFileSync(path.join(big, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
      const paths = {};
      const total = FILES_PER_BATCH * MAX_BATCHES + 20;
      for (let i = 0; i < total; i++) {
        const rel = `src/app/api/r${i}/route.ts`;
        fs.mkdirSync(path.join(big, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(big, rel), 'export async function GET() {}\n');
        paths[`/api/r${i}`] = { get: {} };
      }
      fs.mkdirSync(path.join(big, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(big, '.restless/openapi.json'), JSON.stringify({ paths }));

      const plan = buildPlan({ rootDir: big, oasFile: '.restless/openapi.json' });
      expect(plan.batches.length).toBe(MAX_BATCHES);
      expect(plan.coverage.filesSkipped).toBe(20);
    } finally {
      fs.rmSync(big, { recursive: true, force: true });
    }
  });

  it('uses a file inventory when there are no routes to anchor to', () => {
    // A docs repo: exactly what this command exists to reach, and the scanner
    // has nothing to say about it.
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-plan-docs-'));
    try {
      fs.writeFileSync(path.join(docs, 'guide.md'), '# Guide\n');
      fs.writeFileSync(path.join(docs, 'auth.md'), '# Auth\n');
      const plan = buildPlan({ rootDir: docs, oasFile: '' });
      expect(plan.strategy).toBe('inventory');
      expect(plan.batches.flatMap((b) => b.files).sort()).toEqual(['auth.md', 'guide.md']);
    } finally {
      fs.rmSync(docs, { recursive: true, force: true });
    }
  });
});
