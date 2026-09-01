import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const runAI = vi.fn();
vi.mock('../lib/ai.js', async () => {
  const actual = await vi.importActual('../lib/ai.js');
  return { ...actual, runAI: (...args) => runAI(...args) };
});

import { generateOasWithAi } from '../steps/generate-oas.js';

let dir;

function write(rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A fixture big enough that planSpecGroups agrees to split it. */
function bigApi() {
  write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
  for (const [file, n] of [['project', 6], ['task', 6], ['user', 4], ['auth', 3], ['stats', 3]]) {
    const routes = Array.from({ length: n }, (_, i) => `router.get('/${file}${i}', h);`).join('\n');
    write(`src/routes/${file}.routes.js`, routes);
  }
}

/** What a well-behaved worker writes: a fragment, not a whole spec. */
function fragmentFor(partFile, tag) {
  fs.mkdirSync(path.dirname(partFile), { recursive: true });
  fs.writeFileSync(partFile, JSON.stringify({
    paths: { [`/api/${tag}`]: { get: { responses: { 200: { description: 'ok' } } } } },
    components: { schemas: { [`${tag}Thing`]: { type: 'object' } }, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    tags: [{ name: tag }],
  }));
}

function partFileFrom(prompt) {
  const m = /\*\*(\/[^\s*]+\.json)\*\*/.exec(prompt) || /([^\s`"']+\.tmp-oas-parts[^\s`"']*\.json)/.exec(prompt);
  return m ? m[1] : null;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-parallel-'));
  const { setGitRoot } = await import('../lib/pathGuard.js');
  setGitRoot(dir);
  runAI.mockReset();
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
});

function gen(extra = {}) {
  return generateOasWithAi({
    rootDir: dir, packageDir: dir, apiRootDir: '.', name: 'Big API', setSpinner() {}, ...extra,
  });
}

describe('parallel spec generation', () => {
  it('fans out one call per group and merges the fragments', async () => {
    bigApi();
    const calls = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      calls.push(opts.label);
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
    expect(res.parallel).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((l) => l.startsWith('generate-oas-part:'))).toBe(true);

    const spec = JSON.parse(fs.readFileSync(res.oasFullPath, 'utf8'));
    // One path per group, all merged, with the shell's document fields.
    expect(Object.keys(spec.paths)).toHaveLength(calls.length);
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('Big API');
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['bearerAuth']);
  });

  it('marks the concurrent workers as background so the timing tree stays sane', async () => {
    bigApi();
    const flags = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      flags.push(opts.background);
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    await gen();
    expect(flags.every((f) => f === true)).toBe(true);
  });

  it('gives each worker a no-op spinner so they cannot fight over one line', async () => {
    bigApi();
    const spinners = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      spinners.push(typeof opts.setSpinner);
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    await gen();
    expect(spinners.every((t) => t === 'function')).toBe(true);
  });

  it('leaves no fragment files behind in the committed .restless directory', async () => {
    bigApi();
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    const res = await gen();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, '.restless', '.tmp-oas-parts'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.restless'))).toEqual(['openapi.json']);
  });

  it('scopes each worker to only its own route files', async () => {
    bigApi();
    const prompts = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      prompts.push(prompt);
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    await gen();
    // Every route file appears in exactly one worker's "you own these" list.
    for (const file of ['project', 'task', 'user', 'auth', 'stats']) {
      const owners = prompts.filter((p) => p.includes(`- \`src/routes/${file}.routes.js\``));
      expect(owners).toHaveLength(1);
    }
  });

  it('falls back to a single pass when a worker writes nothing', async () => {
    // Merging what arrived would ship a spec silently missing a group, and
    // for call-expression routes nothing downstream would notice.
    bigApi();
    let n = 0;
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const isPart = String(opts.label || '').startsWith('generate-oas-part:');
      if (isPart) {
        n += 1;
        // First worker silently fails.
        if (n === 1) return '';
        const pf = partFileFrom(prompt);
        if (pf) fragmentFor(pf, opts.label.split(':')[1]);
        return '';
      }
      // The single-pass fallback.
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify({
        openapi: '3.0.0', info: { title: 'fallback', version: '1' },
        paths: { '/whole': { get: { responses: { 200: { description: 'ok' } } } } },
      }));
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
    expect(res.parallel).toBeUndefined();
    const spec = JSON.parse(fs.readFileSync(res.oasFullPath, 'utf8'));
    expect(spec.info.title).toBe('fallback');
  });

  it('falls back when a worker writes unparseable JSON', async () => {
    bigApi();
    let n = 0;
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const isPart = String(opts.label || '').startsWith('generate-oas-part:');
      if (isPart) {
        n += 1;
        const pf = partFileFrom(prompt);
        if (pf) {
          fs.mkdirSync(path.dirname(pf), { recursive: true });
          if (n === 1) fs.writeFileSync(pf, '{"paths": broken');
          else fragmentFor(pf, opts.label.split(':')[1]);
        }
        return '';
      }
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify({
        openapi: '3.0.0', info: { title: 'fallback', version: '1' },
        paths: { '/whole': { get: { responses: { 200: { description: 'ok' } } } } },
      }));
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(res.oasFullPath, 'utf8')).info.title).toBe('fallback');
  });

  it('does not split a small API', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
    write('src/routes/only.js', "router.get('/a', h);\nrouter.get('/b', h);");

    const labels = [];
    runAI.mockImplementation(async (_p, _cwd, opts) => {
      labels.push(opts.label);
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify({
        openapi: '3.0.0', info: { title: 'small', version: '1' },
        paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } },
      }));
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
    expect(labels).toEqual(['generate-oas']);
  });

  it('does not split when the user asked for native generation', async () => {
    bigApi();
    const labels = [];
    runAI.mockImplementation(async (_p, _cwd, opts) => {
      labels.push(opts.label);
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify({
        openapi: '3.0.0', info: { title: 'native', version: '1' },
        paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } },
      }));
      return '';
    });

    await gen({ preferNative: true, framework: 'Fastify' });
    expect(labels).toEqual(['generate-oas']);
  });

  it('reports progress in endpoints, not in internal group counts', async () => {
    // How many requests the work was split across is an implementation
    // detail; what the user is waiting on is their API being described.
    bigApi();
    const details = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    await gen({ setSpinner: (s) => { if (s && s.detail) details.push(s.detail); } });

    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(d).toMatch(/^\d+ of 22 endpoints$/);
    // Starts at nothing written and ends with everything written.
    expect(details[0]).toBe('0 of 22 endpoints');
    expect(details[details.length - 1]).toBe('22 of 22 endpoints');
    // No mechanics leaking into the copy.
    expect(details.join(' ')).not.toMatch(/parallel|section|group/i);
  });

  it('clears the spinner on the way out, so the next prompt stands alone', async () => {
    // Each worker gets a no-op spinner so they cannot fight over the line,
    // which left nothing to turn the real one off - the stale line then sat
    // under the base-URL question with its clock still running.
    bigApi();
    const seen = [];
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    await gen({ setSpinner: (s) => seen.push(s) });
    expect(seen[seen.length - 1]).toBe('');
  });

  it('clears the spinner even when the parallel run fails', async () => {
    bigApi();
    const seen = [];
    let n = 0;
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      if (String(opts.label || '').startsWith('generate-oas-part:')) {
        n += 1;
        if (n === 1) return '';
        const pf = partFileFrom(prompt);
        if (pf) fragmentFor(pf, opts.label.split(':')[1]);
        return '';
      }
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify({
        openapi: '3.0.0', info: { title: 'fallback', version: '1' },
        paths: { '/whole': { get: { responses: { 200: { description: 'ok' } } } } },
      }));
      return '';
    });
    await gen({ setSpinner: (s) => seen.push(s) });
    expect(seen).toContain('');
  });

  it('re-indents the merged spec for the committed file', async () => {
    bigApi();
    runAI.mockImplementation(async (prompt, _cwd, opts) => {
      const pf = partFileFrom(prompt);
      if (pf) fragmentFor(pf, opts.label.split(':')[1]);
      return '';
    });
    const res = await gen();
    expect(fs.readFileSync(res.oasFullPath, 'utf8')).toContain('\n  "openapi"');
  });
});
