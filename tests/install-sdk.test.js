import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { inlineKeyIntoSource, nextWiringStatus } from '../steps/install-sdk.js';
import { detectNext, nextPluginWiringStatus } from '../lib/next-detect.js';
import { setGitRoot } from '../lib/pathGuard.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-sdk-')));
}

describe('inlineKeyIntoSource', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
    // Configure the path guard so the safeWriteFileSync calls inside
    // inlineKeyIntoSource don't reject our tmp dir.
    setGitRoot(dir);
  });
  afterEach(() => {
    setGitRoot(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces process.env.RESTLESS_KEY in files that import the SDK', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `// TODO: move this out of the codebase before committing\nconst restless = require('@restlessai/sdk')("rdme_abc");\n`,
    );
  });

  it('prefixes the SDK init line with a TODO comment', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "  const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    inlineKeyIntoSource(dir, 'rdme_abc');
    const out = fs.readFileSync(file, 'utf8');
    // Comment matches the indent of the SDK init line.
    expect(out).toContain('  // TODO: move this out of the codebase before committing\n');
    expect(out).toContain('  const restless = require(\'@restlessai/sdk\')("rdme_abc");');
  });

  it('does not double-add the TODO comment on re-runs', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(
      file,
      '// TODO: move this out of the codebase before committing\n' +
        "const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n",
    );
    inlineKeyIntoSource(dir, 'rdme_new');
    const out = fs.readFileSync(file, 'utf8');
    // Only one TODO line, not two.
    const matches = out.match(/TODO: move this out of the codebase/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('handles ESM import + separate call', () => {
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(file, "import restless from '@restlessai/sdk';\nconst r = restless(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_xyz');
    expect(touched).toEqual(['server.mjs']);
    expect(fs.readFileSync(file, 'utf8')).toContain('restless("rdme_xyz")');
  });

  it('properly JSON-escapes weird characters in the key', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    inlineKeyIntoSource(dir, 'has"double-quote');
    const out = fs.readFileSync(file, 'utf8');
    // JSON.stringify wraps in double quotes and escapes the inner quote.
    expect(out).toContain('"has\\"double-quote"');
  });

  it('does not touch files that do not import the SDK', () => {
    const sdkFile = path.join(dir, 'index.js');
    const otherFile = path.join(dir, 'unrelated.js');
    fs.writeFileSync(sdkFile, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    fs.writeFileSync(otherFile, 'const x = process.env.RESTLESS_KEY;\n');
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    // unrelated file should be untouched.
    expect(fs.readFileSync(otherFile, 'utf8')).toBe('const x = process.env.RESTLESS_KEY;\n');
  });

  it('skips files inside node_modules', () => {
    const nm = path.join(dir, 'node_modules', '@restlessai', 'sdk');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.js'), "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
  });

  it('returns an empty list when no SDK files exist', () => {
    fs.writeFileSync(path.join(dir, 'index.js'), "console.log('hi');\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
  });

  it('skips files that import the SDK but do not reference process.env.RESTLESS_KEY', () => {
    const file = path.join(dir, 'index.js');
    // Already inlined or using a different env approach.
    const original = "require('@restlessai/sdk')('rdme_existing');\n";
    fs.writeFileSync(file, original);
    const touched = inlineKeyIntoSource(dir, 'rdme_new');
    expect(touched).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('injects the key into a bare immediate-call site (no placeholder)', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, 'const restless = require("@restlessai/sdk")();\n');
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain('// TODO: move this out of the codebase before committing\n');
    expect(out).toContain('const restless = require("@restlessai/sdk")("rdme_abc");');
  });

  it('injects the key into an ESM bare-call site (no placeholder)', () => {
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(file, "import restless from '@restlessai/sdk';\nconst r = restless();\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_xyz');
    expect(touched).toEqual(['server.mjs']);
    expect(fs.readFileSync(file, 'utf8')).toContain('const r = restless("rdme_xyz");');
  });

  it('injects the key into a CJS named-import bare-call site', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "const factory = require('@restlessai/sdk');\nconst r = factory();\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    expect(fs.readFileSync(file, 'utf8')).toContain('const r = factory("rdme_abc");');
  });

  it('is idempotent when the literal key is already present', () => {
    const file = path.join(dir, 'index.js');
    const original =
      '// TODO: move this out of the codebase before committing\n' +
      'const restless = require("@restlessai/sdk")("rdme_abc");\n';
    fs.writeFileSync(file, original);
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('handles multiple files in one pass', () => {
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const a = path.join(dir, 'index.js');
    const b = path.join(sub, 'app.ts');
    fs.writeFileSync(a, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    fs.writeFileSync(b, "import restless from '@restlessai/sdk';\nrestless(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched.sort()).toEqual(['index.js', 'src/app.ts'].sort());
    expect(fs.readFileSync(a, 'utf8')).toContain('"rdme_abc"');
    expect(fs.readFileSync(b, 'utf8')).toContain('"rdme_abc"');
  });
});

// Regression for the Next.js App Router crash: setup used to wire the SDK
// into Next's middleware file (`proxy.ts`), producing an install that throws
// PageSignatureError (E394) on every request. Correct wiring wraps route
// handlers via `@restlessai/sdk/next` and never touches middleware. Runtime
// E394 cannot be exercised without a Next dev server, but it is *structurally*
// impossible when no middleware file carries the SDK - which is exactly what
// `nextWiringStatus` gates on. These tests assert that gate against fixtures.
describe('nextWiringStatus (Next.js App Router wiring gate)', () => {
  let dir;

  function put(rel, content = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  // A fresh Next 16 App Router app: app/ route handlers + a src/proxy.ts
  // middleware (the file the buggy installer used to clobber).
  function scaffoldAppRouter() {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(
      path.join('app', 'pets', 'route.ts'),
      `export async function GET(req) { return Response.json([]); }
export async function POST(req) { return Response.json({}, { status: 201 }); }`,
    );
    put(path.join('src', 'proxy.ts'), 'export function proxy(req) { return; }');
  }

  beforeEach(() => { dir = tmp(); setGitRoot(dir); });
  afterEach(() => { setGitRoot(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes when handlers are wrapped via @restlessai/sdk/next and middleware is untouched', () => {
    scaffoldAppRouter();
    const proxyBefore = fs.readFileSync(path.join(dir, 'src', 'proxy.ts'), 'utf8');

    // Correct wiring: a shared client module + route files that wrap handlers.
    put(
      path.join('lib', 'restless.ts'),
      `import restless from '@restlessai/sdk/next';
export const client = restless(process.env.RESTLESS_KEY);
export const wrap = client.setup(async (req) => ({ apiKey: client.mask(req.headers.get('authorization')) }));`,
    );
    put(
      path.join('app', 'pets', 'route.ts'),
      `import { wrap } from '@/lib/restless';
async function getPets(req) { return Response.json([]); }
async function createPet(req) { return Response.json({}, { status: 201 }); }
export const GET = wrap(getPets);
export const POST = wrap(createPet);`,
    );

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');

    expect(status.ok).toBe(true);
    // (b) route handlers are wrapped: the handler-side wiring is the lib module.
    expect(status.wiredHandlerSide).toContain(path.join('lib', 'restless.ts'));
    // (a) no middleware file is wired...
    expect(status.wiredMiddleware).toEqual([]);
    // ...and the proxy.ts file on disk is byte-for-byte unchanged.
    expect(fs.readFileSync(path.join(dir, 'src', 'proxy.ts'), 'utf8')).toBe(proxyBefore);
    // Generated code imports the /next adapter and the env ref, not a literal.
    const lib = fs.readFileSync(path.join(dir, 'lib', 'restless.ts'), 'utf8');
    expect(lib).toContain("@restlessai/sdk/next");
    expect(lib).toContain('process.env.RESTLESS_KEY');
  });

  it('fails when the SDK is wired into the Next middleware/proxy file (the bug)', () => {
    scaffoldAppRouter();
    // Reproduce the buggy install: SDK dropped into src/proxy.ts.
    put(
      path.join('src', 'proxy.ts'),
      `import restless from '@restlessai/sdk';
const sdk = restless('rstlss_literalkey');
const restlessMiddleware = sdk.setup(async (req) => ({ apiKey: sdk.mask(req.headers.get('authorization')) }));
export async function proxy(req) { await restlessMiddleware(req); }`,
    );

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');

    expect(status.ok).toBe(false);
    expect(status.wiredMiddleware).toEqual([path.join('src', 'proxy.ts')]);
    expect(status.wiredHandlerSide).toEqual([]);
  });

  it('fails when nothing has been wired yet', () => {
    scaffoldAppRouter();
    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    expect(status.ok).toBe(false);
    expect(status.wired).toEqual([]);
  });
});

// The plugin-style wiring (withRestless + restless.config) has no factory
// call, so it is deliberately INVISIBLE to nextWiringStatus - the composed
// gate in installSdk pairs that status (for the middleware guard and manual
// wraps) with nextPluginWiringStatus (for the plugin files). These tests pin
// the interplay.
describe('nextWiringStatus vs the plugin wiring', () => {
  let dir;

  function put(rel, content = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeEach(() => { dir = tmp(); setGitRoot(dir); });
  afterEach(() => { setGitRoot(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('a pure plugin install has zero factory wirings but a passing plugin status', () => {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(path.join('app', 'pets', 'route.ts'), 'export async function GET() { return Response.json([]); }');
    put('next.config.mjs', `import { withRestless } from '@restlessai/sdk/next';
export default withRestless({});`);
    put('restless.config.ts', `import { defineConfig, mask } from '@restlessai/sdk/next';
export default defineConfig({ setup: async (req) => ({ apiKey: mask(req.headers.get('authorization')) }) });`);

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    // Invisible to the factory-call gate...
    expect(status.wired).toEqual([]);
    expect(status.wiredMiddleware).toEqual([]);
    // ...but fully wired per the plugin gate.
    expect(nextPluginWiringStatus(dir).ok).toBe(true);
  });

  it('a middleware mis-wiring is still caught alongside a plugin install', () => {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(path.join('app', 'pets', 'route.ts'), 'export async function GET() { return Response.json([]); }');
    put('next.config.mjs', `import { withRestless } from '@restlessai/sdk/next';
export default withRestless({});`);
    put('restless.config.ts', `import { defineConfig } from '@restlessai/sdk/next';
export default defineConfig({ setup: async () => ({}) });`);
    // A stray factory wiring in the middleware file - the crash case.
    put(path.join('src', 'proxy.ts'), `import restless from '@restlessai/sdk/next';
const sdk = restless(process.env.RESTLESS_KEY);
export async function proxy(req) { return sdk.setup(() => ({}))(req); }`);

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    expect(status.wiredMiddleware).toEqual([path.join('src', 'proxy.ts')]);
    // Plugin status alone says ok - which is exactly why the composed gate
    // in installSdk must ALSO require zero middleware wirings.
    expect(nextPluginWiringStatus(dir).ok).toBe(true);
  });
});
