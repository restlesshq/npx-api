import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectIdLooksRisky, runChecks } from '../steps/final-checks.js';
import { setGitRoot } from '../lib/pathGuard.js';
import { generate, BLOCK_START, BLOCK_END } from '../lib/sdk-writers/javascript.js';

describe('projectIdLooksRisky', () => {
  it('flags a raw key variable', () => {
    expect(projectIdLooksRisky('key')).toBe(true);
  });

  it('flags an Authorization header read', () => {
    expect(projectIdLooksRisky("req.headers['authorization']")).toBe(true);
    expect(projectIdLooksRisky('req.headers.authorization')).toBe(true);
  });

  it('flags X-API-Key / X-Auth-Token header reads', () => {
    expect(projectIdLooksRisky("req.headers['x-api-key']")).toBe(true);
    expect(projectIdLooksRisky("req.headers['x-auth-token']")).toBe(true);
  });

  it('flags variables named token / apiKey / secret / password', () => {
    expect(projectIdLooksRisky('token')).toBe(true);
    expect(projectIdLooksRisky('apiKey')).toBe(true);
    expect(projectIdLooksRisky('SECRET_VALUE')).toBe(true);
    expect(projectIdLooksRisky('password')).toBe(true);
  });

  it('approves restless.mask(key) — that is hashed, safe to send', () => {
    expect(projectIdLooksRisky('restless.mask(key)')).toBe(false);
    expect(projectIdLooksRisky('mask(extractApiKey(req))')).toBe(false);
  });

  it('approves stable internal ids', () => {
    expect(projectIdLooksRisky('user.id')).toBe(false);
    expect(projectIdLooksRisky('user.workspace.id')).toBe(false);
    expect(projectIdLooksRisky('"fixed-org-slug"')).toBe(false);
  });

  it('handles non-string / empty input safely', () => {
    expect(projectIdLooksRisky(null)).toBe(false);
    expect(projectIdLooksRisky('')).toBe(false);
    expect(projectIdLooksRisky(undefined)).toBe(false);
  });
});

describe('runChecks', () => {
  let dir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'final-checks-')));
    setGitRoot(dir);
    fs.mkdirSync(path.join(dir, '.api'));
    fs.writeFileSync(path.join(dir, '.api', 'settings.json'), JSON.stringify({ apis: [{ rootDir: '.', redact: { headers: ['x-api-key'] } }] }));
  });
  afterEach(() => {
    setGitRoot(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(overrides = {}) {
    return {
      packageDir: dir, rootDir: dir, apiRootDir: '.', installDir: dir, apiDir: dir,
      language: 'javascript', framework: 'express', aiTool: 'Claude Code',
      envLoader: { mode: 'none', evidence: 'none' },
      apiKey: null, projectId: null, setupKey: null,
      keyDelivery: 'manual', envFile: null, envRelative: null,
      ...overrides,
    };
  }

  function writeSource(content) {
    fs.writeFileSync(path.join(dir, 'index.js'), content);
  }

  it('reports "no-source" when no SDK is wired in', () => {
    const rows = runChecks(ctxFor());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('no-source');
    expect(rows[0].ok).toBe(false);
  });

  it('reports unwrapped-block when SDK is imported without sentinels', () => {
    writeSource("const r = require('@restlessai/sdk')();\n");
    const rows = runChecks(ctxFor());
    expect(rows.find((r) => r.kind === 'unwrapped-block')).toBeDefined();
  });

  it('flags init-form mismatch and exposes a fix function', () => {
    // Write a sentinel block in env-ref form, but ctx says inline.
    const block = generate(
      { keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } },
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' },
    );
    writeSource(`const express = require('express');\nconst app = express();\n${block}`);
    const ctx = ctxFor({ keyDelivery: 'inline', apiKey: 'rdme_abc' });
    const rows = runChecks(ctx);
    const initRow = rows.find((r) => r.kind === 'init-form');
    expect(initRow.ok).toBe(false);
    expect(typeof initRow.fix).toBe('function');
  });

  it('passes init-form check when block matches ctx (inline)', () => {
    const ctx = ctxFor({ keyDelivery: 'inline', apiKey: 'rdme_abc' });
    const block = generate(ctx, { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' });
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctx);
    const initRow = rows.find((r) => r.kind === 'init-form');
    expect(initRow.ok).toBe(true);
    expect(initRow.fix).toBeFalsy();
  });

  it('flags missing credential and missing project.id when callback is empty', () => {
    const block = `${BLOCK_START}\nconst sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({})));\n${BLOCK_END}\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    expect(rows.find((r) => r.kind === 'credential').ok).toBe(false);
    expect(rows.find((r) => r.kind === 'project-id').ok).toBe(false);
  });

  it('flags risky project.id (raw secret)', () => {
    const block = `${BLOCK_START}\nconst sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({\n  apiKey: sdk.mask(auth),\n  project: { id: req.headers.authorization },\n})));\n${BLOCK_END}\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    const idRow = rows.find((r) => r.kind === 'project-id');
    expect(idRow.ok).toBe(false);
  });

  it('approves a sentinel block with sane fields', () => {
    const ctx = ctxFor({ keyDelivery: 'manual' });
    const block = generate(ctx, {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: "req.headers['x-api-key']", projectIdExpr: 'workspace.id',
    });
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctx);
    expect(rows.find((r) => r.kind === 'init-form').ok).toBe(true);
    expect(rows.find((r) => r.kind === 'credential').ok).toBe(true);
    expect(rows.find((r) => r.kind === 'project-id').ok).toBe(true);
  });

  it('flags missing .gitignore coverage and exposes a fix', () => {
    const block = generate(ctxFor(), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    writeSource(`const app = require('express')();\n${block}`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    const rows = runChecks(ctxFor());
    const gi = rows.find((r) => r.kind === 'gitignore');
    expect(gi.ok).toBe(false);
    expect(typeof gi.fix).toBe('function');
    gi.fix();
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');
  });

  it('canonicalize fix actually rewrites the init line', () => {
    const block = generate(
      { keyDelivery: 'manual', envLoader: { mode: 'none' } },
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' },
    );
    writeSource(`const app = require('express')();\n${block}`);
    const ctx = ctxFor({ keyDelivery: 'inline', apiKey: 'rdme_abc' });
    const rows = runChecks(ctx);
    const init = rows.find((r) => r.kind === 'init-form');
    expect(init.ok).toBe(false);
    init.fix();
    const after = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    expect(after).toContain('"rdme_abc"');
    expect(after).toContain('TODO: move this out of the codebase');
  });
});
