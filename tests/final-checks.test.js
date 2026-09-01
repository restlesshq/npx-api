import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeOwnerId, ownerIdLooksRisky, runChecks } from '../steps/final-checks.js';
import { setGitRoot } from '../lib/pathGuard.js';
import { generate } from '../lib/sdk-writers/javascript.js';

describe('analyzeOwnerId', () => {
  describe('critical: raw secrets', () => {
    it('flags a bare `key` variable', () => {
      expect(analyzeOwnerId('key').severity).toBe('critical');
    });
    it('flags Authorization header reads', () => {
      expect(analyzeOwnerId("req.headers['authorization']").severity).toBe('critical');
      expect(analyzeOwnerId('req.headers.authorization').severity).toBe('critical');
    });
    it('flags X-API-Key / X-Auth-Token header reads', () => {
      expect(analyzeOwnerId("req.headers['x-api-key']").severity).toBe('critical');
      expect(analyzeOwnerId("req.headers['x-auth-token']").severity).toBe('critical');
    });
    it('flags variables named token / apiKey / secret / password', () => {
      expect(analyzeOwnerId('token').severity).toBe('critical');
      expect(analyzeOwnerId('apiKey').severity).toBe('critical');
      expect(analyzeOwnerId('SECRET_VALUE').severity).toBe('critical');
      expect(analyzeOwnerId('password').severity).toBe('critical');
    });
  });

  describe('critical: user-controlled input', () => {
    it('flags req.body reads', () => {
      const r = analyzeOwnerId('req.body.tenantId');
      expect(r.severity).toBe('critical');
      expect(r.reason).toMatch(/request body/);
    });
    it('flags req.query reads', () => {
      expect(analyzeOwnerId("req.query['workspace']").severity).toBe('critical');
      expect(analyzeOwnerId('req.query.org').severity).toBe('critical');
    });
    it('flags cookie reads', () => {
      expect(analyzeOwnerId('req.cookies.session').severity).toBe('critical');
      expect(analyzeOwnerId('req.cookie.org').severity).toBe('critical');
      expect(analyzeOwnerId('ctx.cookies.tenant').severity).toBe('critical');
    });
  });

  describe('critical: literal placeholder strings', () => {
    it("flags 'anonymous'", () => {
      const r = analyzeOwnerId("'anonymous'");
      expect(r.severity).toBe('critical');
      expect(r.reason).toMatch(/fake-groups/);
    });
    it('flags other dummy strings (none / unknown / guest / etc.)', () => {
      expect(analyzeOwnerId("'none'").severity).toBe('critical');
      expect(analyzeOwnerId('"unknown"').severity).toBe('critical');
      expect(analyzeOwnerId("'guest'").severity).toBe('critical');
      expect(analyzeOwnerId("'default'").severity).toBe('critical');
      expect(analyzeOwnerId("'null'").severity).toBe('critical');
    });
    it('is case-insensitive', () => {
      expect(analyzeOwnerId("'Anonymous'").severity).toBe('critical');
      expect(analyzeOwnerId('"ANONYMOUS"').severity).toBe('critical');
    });
    it('still approves a real hardcoded id like a fixed company slug', () => {
      // The placeholder check is whitelist-based; arbitrary strings are fine.
      expect(analyzeOwnerId('"acme-corp"').severity).toBe('ok');
      expect(analyzeOwnerId("'workspace-42'").severity).toBe('ok');
    });
  });

  describe('critical: sentinel placeholder', () => {
    it("flags 'NEEDS_CONFIGURATION'", () => {
      expect(analyzeOwnerId("'NEEDS_CONFIGURATION'").severity).toBe('critical');
      expect(analyzeOwnerId('"NEEDS_CONFIGURATION"').severity).toBe('critical');
      expect(analyzeOwnerId("  'NEEDS_CONFIGURATION'  ").severity).toBe('critical');
    });
  });

  describe('critical: nothing set', () => {
    it('flags null / empty / undefined', () => {
      expect(analyzeOwnerId(null).severity).toBe('critical');
      expect(analyzeOwnerId('').severity).toBe('critical');
      expect(analyzeOwnerId(undefined).severity).toBe('critical');
    });
  });

  describe('warning: raw header reads', () => {
    it('flags non-auth-looking headers as spoofable', () => {
      const r = analyzeOwnerId("req.headers['x-workspace-id']");
      expect(r.severity).toBe('warning');
      expect(r.reason).toMatch(/trusted proxy/);
    });
    it('flags ctx.headers and ctx.request.headers (Koa)', () => {
      expect(analyzeOwnerId("ctx.headers['x-tenant-id']").severity).toBe('warning');
      expect(analyzeOwnerId("ctx.request.headers['x-tenant-id']").severity).toBe('warning');
    });
    it('flags c.req.header() (Hono)', () => {
      expect(analyzeOwnerId("c.req.header('x-tenant-id')").severity).toBe('warning');
    });
  });

  describe('warning: mutable-looking field names', () => {
    it('flags .email', () => {
      const r = analyzeOwnerId('user.email');
      expect(r.severity).toBe('warning');
      expect(r.reason).toMatch(/\.email/);
    });
    it('flags .username / .name / .slug / .handle / .display_name', () => {
      expect(analyzeOwnerId('user.username').severity).toBe('warning');
      expect(analyzeOwnerId('user.name').severity).toBe('warning');
      expect(analyzeOwnerId('workspace.slug').severity).toBe('warning');
      expect(analyzeOwnerId('user.handle').severity).toBe('warning');
      expect(analyzeOwnerId('user.display_name').severity).toBe('warning');
    });
  });

  describe('ok', () => {
    it('approves restless.mask(...), which is hashed and safe to send', () => {
      expect(analyzeOwnerId('restless.mask(key)').severity).toBe('ok');
      expect(analyzeOwnerId('mask(extractApiKey(req))').severity).toBe('ok');
    });
    it('approves stable internal id expressions', () => {
      expect(analyzeOwnerId('user.id').severity).toBe('ok');
      expect(analyzeOwnerId('user.workspaceId').severity).toBe('ok');
      expect(analyzeOwnerId('req.user.workspace.id').severity).toBe('ok');
      expect(analyzeOwnerId('"fixed-org-slug"').severity).toBe('ok');
      expect(analyzeOwnerId('jwtClaims.sub').severity).toBe('ok');
    });
  });
});

describe('ownerIdLooksRisky (back-compat shim)', () => {
  it('returns true for anything non-ok', () => {
    expect(ownerIdLooksRisky('req.body.tenant')).toBe(true);
    expect(ownerIdLooksRisky('user.email')).toBe(true);
    expect(ownerIdLooksRisky("'NEEDS_CONFIGURATION'")).toBe(true);
  });
  it('returns false for ok', () => {
    expect(ownerIdLooksRisky('user.id')).toBe(false);
  });
});

describe('runChecks', () => {
  let dir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'final-checks-')));
    setGitRoot(dir);
    fs.mkdirSync(path.join(dir, '.restless'));
    fs.writeFileSync(path.join(dir, '.restless', 'settings.json'), JSON.stringify({ apis: [{ rootDir: '.', redact: { headers: ['x-api-key'] } }] }));
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

  it('flags missing credential and missing owner.id when callback is empty', () => {
    const block = `const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({})));\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    expect(rows.find((r) => r.kind === 'credential').ok).toBe(false);
    expect(rows.find((r) => r.kind === 'owner-id').ok).toBe(false);
  });

  it('returns only an old-api row when the file uses the OLD 2-arg setup', () => {
    // Don't trust the rest of the checks against a broken block; surface
    // the API shape problem first so the repair flow rewrites it before
    // any downstream check runs.
    const block = `import restless from '@restlessai/sdk';
restless.setup(app, (req) => ({
  apiKey: restless.mask(req.headers.authorization),
  owner: { id: req.user.workspaceId },
}));`;
    writeSource(`const app = express();\n${block}`);
    const rows = runChecks(ctxFor());
    // The old-api row should be the ONLY row produced. Downstream checks
    // would be reading from a broken block.
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('old-api');
    expect(rows[0].ok).toBe(false);
    expect(rows[0].severity).toBe('critical');
  });

  it('flags risky owner.id (raw secret)', () => {
    const block = `const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({\n  apiKey: sdk.mask(auth),\n  owner: { id: req.headers.authorization },\n})));\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    const idRow = rows.find((r) => r.kind === 'owner-id');
    expect(idRow.ok).toBe(false);
  });

  it("flags the 'NEEDS_CONFIGURATION' placeholder so the repair flow fires", () => {
    const block = `const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({\n  apiKey: sdk.mask(auth),\n  owner: { id: 'NEEDS_CONFIGURATION' },\n})));\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    const idRow = rows.find((r) => r.kind === 'owner-id');
    expect(idRow.ok).toBe(false);
  });

  it("surfaces an 'unverified' severity when a CONFIRM marker precedes an otherwise-ok owner.id", () => {
    const block = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  // RESTLESS_OWNER_ID_CONFIRM: JSON-key id; no formal schema to confirm.
  owner: { id: user.id },
})));
`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    const idRow = rows.find((r) => r.kind === 'owner-id');
    expect(idRow.severity).toBe('unverified');
    expect(idRow.ok).toBe(false);
    expect(idRow.detail).toMatch(/JSON-key id/);
  });

  it("lets static 'critical' beat the CONFIRM marker (security signal wins)", () => {
    // If the AI somehow leaves both a marker AND a clearly unsafe value,
    // the security signal should win.
    const block = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  // RESTLESS_OWNER_ID_CONFIRM: not sure.
  owner: { id: req.body.tenantId },
})));
`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    const idRow = rows.find((r) => r.kind === 'owner-id');
    expect(idRow.severity).toBe('critical');
  });

  it('also reads legacy `project: { id }` so a pre-rename block does not regress', () => {
    const block = `const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup((req) => ({\n  apiKey: sdk.mask(auth),\n  project: { id: workspace.id },\n})));\n`;
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctxFor());
    expect(rows.find((r) => r.kind === 'owner-id').ok).toBe(true);
  });

  it('approves a sentinel block with sane fields', () => {
    const ctx = ctxFor({ keyDelivery: 'manual' });
    const block = generate(ctx, {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: "req.headers['x-api-key']", ownerIdExpr: 'workspace.id',
    });
    writeSource(`const app = require('express')();\n${block}`);
    const rows = runChecks(ctx);
    expect(rows.find((r) => r.kind === 'init-form').ok).toBe(true);
    expect(rows.find((r) => r.kind === 'credential').ok).toBe(true);
    expect(rows.find((r) => r.kind === 'owner-id').ok).toBe(true);
  });

  it('flags missing .gitignore coverage and exposes a fix when we created .env', () => {
    const block = generate(ctxFor(), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    writeSource(`const app = require('express')();\n${block}`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    const rows = runChecks(ctxFor({ createdEnvFile: true }));
    const gi = rows.find((r) => r.kind === 'gitignore');
    expect(gi.ok).toBe(false);
    expect(typeof gi.fix).toBe('function');
    gi.fix();
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');
  });

  it('skips the .gitignore check when we did not create the .env file', () => {
    const block = generate(ctxFor(), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    writeSource(`const app = require('express')();\n${block}`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    const rows = runChecks(ctxFor());
    expect(rows.find((r) => r.kind === 'gitignore')).toBeUndefined();
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

// The Next.js plugin wiring (withRestless in next.config.* + defineConfig in
// restless.config.*) has no SDK init line and no `.setup(` call site, so
// runChecks must swap the init-form / old-api checks for the plugin-file
// checks while keeping the credential / owner.id / gitignore / redact rows.
describe('runChecks (Next.js plugin wiring)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'final-checks-next-')));
    setGitRoot(dir);
    fs.mkdirSync(path.join(dir, '.restless'));
    fs.writeFileSync(path.join(dir, '.restless', 'settings.json'), JSON.stringify({ apis: [{ rootDir: '.' }] }));
  });
  afterEach(() => {
    setGitRoot(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(overrides = {}) {
    return {
      packageDir: dir, rootDir: dir, apiRootDir: '.', installDir: dir, apiDir: dir,
      language: 'typescript', framework: 'Next.js', aiTool: 'Claude Code',
      envLoader: { mode: 'none', evidence: 'none' },
      apiKey: null, projectId: null, setupKey: null,
      keyDelivery: 'env', envFile: null, envRelative: null,
      ...overrides,
    };
  }

  const WRAPPED_CONFIG = `import { withRestless } from '@restlessai/sdk/next';
export default withRestless({ reactStrictMode: true });`;

  function captureConfig(ownerIdExpr = "'workspace-1'") {
    return `import { defineConfig, mask } from '@restlessai/sdk/next';
export default defineConfig({
  setup: async (req) => ({
    apiKey: mask(req.headers.get('authorization')?.slice(7)),
    owner: { id: ${ownerIdExpr}, enrich: async () => ({}) },
  }),
});`;
  }

  it('passes every check on a fully wired plugin install', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), WRAPPED_CONFIG);
    fs.writeFileSync(path.join(dir, 'restless.config.ts'), captureConfig());
    const rows = runChecks(ctxFor());
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['next-plugin'].ok).toBe(true);
    expect(byKind['capture-config'].ok).toBe(true);
    expect(byKind['credential'].ok).toBe(true);
    expect(byKind['owner-id'].ok).toBe(true);
    expect(byKind['redact'].ok).toBe(true);
    // No classic-wiring rows: there is no init line to check and no
    // `.setup(` call site for the old-api guard to misread.
    expect(byKind['init-form']).toBeUndefined();
    expect(byKind['old-api']).toBeUndefined();
    expect(byKind['no-source']).toBeUndefined();
  });

  it('flags zero-config mode (withRestless without a restless.config)', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), WRAPPED_CONFIG);
    const rows = runChecks(ctxFor());
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['next-plugin'].ok).toBe(true);
    expect(byKind['capture-config'].ok).toBe(false);
    // Without a capture config there is no callback to read fields from.
    expect(byKind['credential']).toBeUndefined();
    expect(byKind['owner-id']).toBeUndefined();
  });

  it('flags a restless.config whose next.config lost the withRestless wrap', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), 'export default { reactStrictMode: true };');
    fs.writeFileSync(path.join(dir, 'restless.config.ts'), captureConfig());
    const rows = runChecks(ctxFor());
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['next-plugin'].ok).toBe(false);
    expect(byKind['capture-config'].ok).toBe(true);
    // The callback still gets read so owner/credential state is visible.
    expect(byKind['credential'].ok).toBe(true);
  });

  it('runs the owner.id security analysis against the capture config', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), WRAPPED_CONFIG);
    fs.writeFileSync(path.join(dir, 'restless.config.ts'), captureConfig('req.query.tenant'));
    const rows = runChecks(ctxFor());
    const owner = rows.find((r) => r.kind === 'owner-id');
    expect(owner.ok).toBe(false);
    expect(owner.severity).toBe('critical');
  });

  it('keeps the gitignore check for the env-delivered key', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), WRAPPED_CONFIG);
    fs.writeFileSync(path.join(dir, 'restless.config.ts'), captureConfig());
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    const rows = runChecks(ctxFor({ createdEnvFile: true }));
    const gi = rows.find((r) => r.kind === 'gitignore');
    expect(gi.ok).toBe(false);
    expect(typeof gi.fix).toBe('function');
  });
});

// ── Concurrent wiring review ─────────────────────────────────────────────
// `startWiringReview` overlaps the read-only AI review with `verifyOwnerId`,
// which can rewrite the `owner.id` line - so the result is only usable while
// the reviewed bytes are still the bytes on disk.
describe('startWiringReview', () => {
  let dir;
  const WIRED = [
    "import restless from '@restlessai/sdk';",
    "const sdk = restless(process.env.RESTLESS_KEY);",
    "app.use(sdk.setup((req) => ({",
    "  apiKey: sdk.mask(req.headers.authorization),",
    "  owner: { id: req.user.id },",
    "})));",
  ].join('\n');

  function ctxFor() {
    return {
      packageDir: dir, rootDir: dir, apiRootDir: '.', installDir: dir, apiDir: dir,
      language: 'javascript', framework: 'express', aiTool: 'Claude Code',
      envLoader: { mode: 'none', evidence: 'none' },
      apiKey: null, projectId: null, setupKey: null,
      keyDelivery: 'manual', envFile: null, envRelative: null,
    };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-review-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4' } }));
    fs.writeFileSync(path.join(dir, 'app.js'), WIRED);
    const { setGitRoot } = await import('../lib/pathGuard.js');
    setGitRoot(dir);
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const okReview = async () => JSON.stringify({
    checks: [{ id: 'order', ok: true, note: '' }, { id: 'mounted', ok: true, note: '' }],
  });

  it('starts the review and snapshots the file it read', async () => {
    const { startWiringReview } = await import('../steps/final-checks.js');
    const pending = startWiringReview({ ctx: ctxFor(), runner: okReview });
    expect(pending).not.toBeNull();
    expect(pending.snapshot).toBe(WIRED);
    expect(path.basename(pending.sourceFile)).toBe('app.js');
    await expect(pending.promise).resolves.toMatchObject({ snapshot: WIRED });
  });

  it('never opens a standalone spinner that would tear up the plan frame', async () => {
    // Passing no setSpinner makes runAI start its own stdout spinner.
    const { startWiringReview } = await import('../steps/final-checks.js');
    let sawSetSpinner = false;
    const runner = async (_p, _cwd, opts) => {
      sawSetSpinner = typeof opts.setSpinner === 'function';
      return okReview();
    };
    await startWiringReview({ ctx: ctxFor(), runner }).promise;
    expect(sawSetSpinner).toBe(true);
  });

  it('returns null when nothing is wired yet', async () => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const app = 1;');
    const { startWiringReview } = await import('../steps/final-checks.js');
    expect(startWiringReview({ ctx: ctxFor(), runner: okReview })).toBeNull();
  });

  it('resolves rather than rejecting when the review throws', async () => {
    // A background pass must never be able to take the install down.
    // `runAiChecks` already degrades a failure to one informational row, so
    // that is what comes back - the install carries on either way.
    const { startWiringReview } = await import('../steps/final-checks.js');
    const boom = async () => { throw new Error('nope'); };
    const settled = await startWiringReview({ ctx: ctxFor(), runner: boom }).promise;
    expect(settled.rows).toEqual([
      expect.objectContaining({ kind: 'ai-review', informational: true, ok: true }),
    ]);
  });

  it('feeds its rows into finalChecks without a second AI call', async () => {
    const { startWiringReview, default: finalChecks } = await import('../steps/final-checks.js');
    let calls = 0;
    const counting = async () => { calls++; return okReview(); };
    const pending = startWiringReview({ ctx: ctxFor(), runner: counting });
    await pending.promise;

    const messages = [];
    await finalChecks({
      ctx: ctxFor(),
      update: ({ message }) => { if (message) messages.push(message.join('\n')); },
      setSpinner() {},
      pendingReview: pending,
    });
    expect(calls).toBe(1);
  });

  it('discards the early review when the file changed underneath it', async () => {
    // The real case: `verifyOwnerId` writes a RESTLESS_OWNER_ID_CONFIRM
    // comment into the block while the review is in flight. Every check
    // still passes, but the reviewed bytes are no longer the bytes on disk,
    // so the early result is thrown away and the review runs again.
    const { startWiringReview, default: finalChecks } = await import('../steps/final-checks.js');
    let calls = 0;
    const counting = async () => { calls++; return okReview(); };
    const pending = startWiringReview({ ctx: ctxFor(), runner: counting });
    await pending.promise;
    expect(calls).toBe(1);

    fs.writeFileSync(
      path.join(dir, 'app.js'),
      WIRED.replace(
        '  owner: { id: req.user.id },',
        '  // RESTLESS_OWNER_ID_CONFIRM: could not confirm req.user.id is immutable\n  owner: { id: req.user.id },',
      ),
    );

    await finalChecks({
      ctx: ctxFor(),
      update() {},
      setSpinner() {},
      pendingReview: pending,
      aiRunner: counting,
    });
    expect(calls).toBe(2);
  });
});
