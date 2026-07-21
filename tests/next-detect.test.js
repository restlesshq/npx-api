import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  detectNext,
  isNextMiddlewareFile,
  isNextFramework,
  findNextConfigFile,
  findRestlessConfigFile,
  resolveNextVersion,
  nextAutoWrapSupport,
  nextPluginWiringStatus,
} from '../lib/next-detect.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'next-detect-')));
}

// Write a file, creating parent dirs. Path is relative to `dir`.
function put(dir, rel, content = '') {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const APP_ROUTE = `export async function GET(req) { return Response.json({}); }
export async function POST(req) { return Response.json({}, { status: 201 }); }`;

describe('isNextFramework', () => {
  it('matches the many spellings of Next', () => {
    for (const s of ['next', 'Next.js', 'nextjs', 'Next 16', 'NEXT']) {
      expect(isNextFramework(s)).toBe(true);
    }
  });
  it('does not match unrelated frameworks or empty input', () => {
    for (const s of ['express', 'fastify', 'koa', '', null, undefined, 'nextcloud-ish']) {
      expect(isNextFramework(s)).toBe(false);
    }
  });
});

describe('isNextMiddlewareFile', () => {
  it('flags middleware/proxy at the root and under src/', () => {
    for (const rel of ['middleware.ts', 'proxy.ts', 'middleware.js', 'proxy.tsx',
      path.join('src', 'middleware.ts'), path.join('src', 'proxy.js')]) {
      expect(isNextMiddlewareFile(rel)).toBe(true);
    }
  });
  it('does not flag route files or nested middleware-named files', () => {
    for (const rel of [
      path.join('app', 'pets', 'route.ts'),
      path.join('lib', 'restless.ts'),
      path.join('app', 'middleware.ts'), // Next does not honor a nested one
      path.join('src', 'lib', 'proxy.ts'),
    ]) {
      expect(isNextMiddlewareFile(rel)).toBe(false);
    }
  });
});

describe('detectNext', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('detects an App Router project with a Next 16 proxy.ts middleware', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(dir, path.join('app', 'pets', 'route.ts'), APP_ROUTE);
    put(dir, path.join('app', 'orders', '[id]', 'route.ts'), APP_ROUTE);
    put(dir, 'proxy.ts', 'export function proxy(req) {}'); // Next 16 middleware

    const info = detectNext(dir);
    expect(info.isNext).toBe(true);
    expect(info.hasNextDep).toBe(true);
    expect(info.router).toBe('app');
    expect(info.appRouteFiles).toEqual([
      path.join('app', 'orders', '[id]', 'route.ts'),
      path.join('app', 'pets', 'route.ts'),
    ]);
    expect(info.routeHandlerFiles).toEqual(info.appRouteFiles);
    expect(info.middlewareFiles).toEqual(['proxy.ts']);
    expect(info.moduleSystem).toBe('esm');
  });

  it('handles src/app layout and a src/middleware.ts', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    put(dir, path.join('src', 'app', 'api', 'route.ts'), APP_ROUTE);
    put(dir, path.join('src', 'middleware.ts'), 'export function middleware(req) {}');

    const info = detectNext(dir);
    expect(info.router).toBe('app');
    expect(info.appRouteFiles).toEqual([path.join('src', 'app', 'api', 'route.ts')]);
    expect(info.middlewareFiles).toEqual([path.join('src', 'middleware.ts')]);
  });

  it('detects a Pages Router API project', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '14.0.0' } }));
    put(dir, path.join('pages', 'api', 'pets.ts'), 'export default function h(req, res) {}');
    put(dir, path.join('pages', 'api', '_middleware.ts'), 'export default function h() {}'); // private, ignored
    put(dir, path.join('pages', 'index.tsx'), 'export default function Home() {}'); // not an api route

    const info = detectNext(dir);
    expect(info.router).toBe('pages');
    expect(info.pagesApiFiles).toEqual([path.join('pages', 'api', 'pets.ts')]);
    expect(info.routeHandlerFiles).toEqual([path.join('pages', 'api', 'pets.ts')]);
    expect(info.appRouteFiles).toEqual([]);
  });

  it('prefers App Router when a project mixes both routers', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    put(dir, path.join('app', 'pets', 'route.ts'), APP_ROUTE);
    put(dir, path.join('pages', 'api', 'legacy.ts'), 'export default function h(req, res) {}');

    const info = detectNext(dir);
    expect(info.router).toBe('app');
    expect(info.routeHandlerFiles).toEqual([path.join('app', 'pets', 'route.ts')]);
  });

  it('reports isNext with no route handlers when only a proxy.ts exists', () => {
    // A Next project that has middleware but nothing to wrap - the installer
    // must fail rather than fall back to wiring the middleware.
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(dir, 'proxy.ts', 'export function proxy(req) {}');

    const info = detectNext(dir);
    expect(info.isNext).toBe(true);
    expect(info.router).toBe(null);
    expect(info.routeHandlerFiles).toEqual([]);
    expect(info.middlewareFiles).toEqual(['proxy.ts']);
  });

  it('is not Next for a plain Express project', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { express: '4.0.0' } }));
    put(dir, 'index.js', "const app = require('express')();");

    const info = detectNext(dir);
    expect(info.isNext).toBe(false);
    expect(info.router).toBe(null);
    expect(info.routeHandlerFiles).toEqual([]);
    expect(info.middlewareFiles).toEqual([]);
  });

  it('ignores route files buried in node_modules / .next', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    put(dir, path.join('app', 'pets', 'route.ts'), APP_ROUTE);
    put(dir, path.join('node_modules', 'somepkg', 'app', 'x', 'route.ts'), APP_ROUTE);
    put(dir, path.join('.next', 'server', 'app', 'y', 'route.ts'), APP_ROUTE);

    const info = detectNext(dir);
    expect(info.appRouteFiles).toEqual([path.join('app', 'pets', 'route.ts')]);
  });
});

describe('findNextConfigFile / findRestlessConfigFile', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('finds each supported Next config name at the root', () => {
    for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      const d = tmp();
      put(d, name, 'export default {};');
      expect(findNextConfigFile(d)).toBe(name);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('finds each restless.config name from the SDK discovery set', () => {
    for (const name of ['restless.config.ts', 'restless.config.mjs', 'restless.config.js']) {
      const d = tmp();
      put(d, name, 'export default {};');
      expect(findRestlessConfigFile(d)).toBe(name);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns null when the files are absent or not at the root', () => {
    put(dir, path.join('config', 'next.config.js'), 'export default {};'); // nested - Next ignores it
    expect(findNextConfigFile(dir)).toBe(null);
    expect(findRestlessConfigFile(dir)).toBe(null);
  });
});

describe('resolveNextVersion', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('prefers the installed node_modules/next version', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '^15.0.0' } }));
    put(dir, path.join('node_modules', 'next', 'package.json'), JSON.stringify({ version: '15.4.2' }));
    expect(resolveNextVersion(dir)).toBe('15.4.2');
  });

  it('walks up to a hoisted monorepo install', () => {
    put(dir, path.join('node_modules', 'next', 'package.json'), JSON.stringify({ version: '16.1.0' }));
    const workspace = path.join(dir, 'packages', 'api');
    fs.mkdirSync(workspace, { recursive: true });
    put(dir, path.join('packages', 'api', 'package.json'), JSON.stringify({ dependencies: { next: '*' } }));
    expect(resolveNextVersion(workspace)).toBe('16.1.0');
  });

  it('falls back to the declared dependency range', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14.2.0' } }));
    expect(resolveNextVersion(dir)).toBe('^14.2.0');
  });

  it('returns null when nothing declares Next', () => {
    put(dir, 'package.json', JSON.stringify({ dependencies: { express: '4.0.0' } }));
    expect(resolveNextVersion(dir)).toBe(null);
  });
});

describe('nextAutoWrapSupport', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function scaffold(version, scripts = {}) {
    put(dir, 'package.json', JSON.stringify({ dependencies: { next: '*' }, scripts }));
    put(dir, path.join('node_modules', 'next', 'package.json'), JSON.stringify({ version }));
  }

  it('supports a modern Next on webpack', () => {
    scaffold('15.4.2');
    expect(nextAutoWrapSupport(dir)).toEqual({ supported: true, version: '15.4.2', reason: null });
  });

  it('supports Next 16 with Turbopack scripts', () => {
    scaffold('16.0.0', { build: 'next build --turbopack' });
    expect(nextAutoWrapSupport(dir).supported).toBe(true);
  });

  it('rejects Next older than 13.4 (webpack auto-wrap floor)', () => {
    scaffold('13.2.0');
    const support = nextAutoWrapSupport(dir);
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/13\.4/);
  });

  it('rejects Turbopack builds on Next older than 15.3', () => {
    scaffold('15.1.0', { dev: 'next dev --turbopack' });
    const support = nextAutoWrapSupport(dir);
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/Turbopack/);
  });

  it('honors the old --turbo flag spelling too', () => {
    scaffold('14.2.0', { dev: 'next dev --turbo' });
    expect(nextAutoWrapSupport(dir).supported).toBe(false);
  });

  it('allows webpack builds on 14.x when no script uses Turbopack', () => {
    scaffold('14.2.0', { dev: 'next dev', build: 'next build' });
    expect(nextAutoWrapSupport(dir).supported).toBe(true);
  });

  it('assumes a modern release when the version is unknowable', () => {
    // No package.json at all - detection elsewhere already corroborated Next.
    expect(nextAutoWrapSupport(dir)).toEqual({ supported: true, version: null, reason: null });
  });
});

describe('nextPluginWiringStatus', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const WRAPPED_CONFIG = `import { withRestless } from '@restlessai/sdk/next';
const nextConfig = { reactStrictMode: true };
export default withRestless(nextConfig);`;

  const CAPTURE_CONFIG = `import { defineConfig, mask } from '@restlessai/sdk/next';
export default defineConfig({
  setup: async (req) => ({ apiKey: mask(req.headers.get('authorization')) }),
});`;

  it('is ok when both plugin files are wired', () => {
    put(dir, 'next.config.mjs', WRAPPED_CONFIG);
    put(dir, 'restless.config.ts', CAPTURE_CONFIG);
    const status = nextPluginWiringStatus(dir);
    expect(status).toEqual({
      nextConfigFile: 'next.config.mjs',
      restlessConfigFile: 'restless.config.ts',
      hasWithRestless: true,
      hasDefineConfig: true,
      ok: true,
    });
  });

  it('recognizes the CommonJS require form', () => {
    put(dir, 'next.config.js', `const { withRestless } = require('@restlessai/sdk/next');
module.exports = withRestless({ reactStrictMode: true });`);
    put(dir, 'restless.config.js', `const { defineConfig, mask } = require('@restlessai/sdk/next');
module.exports = defineConfig({ setup: async (req) => ({ apiKey: mask(null) }) });`);
    expect(nextPluginWiringStatus(dir).ok).toBe(true);
  });

  it('is not ok with withRestless alone (zero-config mode)', () => {
    put(dir, 'next.config.mjs', WRAPPED_CONFIG);
    const status = nextPluginWiringStatus(dir);
    expect(status.hasWithRestless).toBe(true);
    expect(status.hasDefineConfig).toBe(false);
    expect(status.ok).toBe(false);
  });

  it('is not ok with a restless.config alone', () => {
    put(dir, 'next.config.mjs', 'export default { reactStrictMode: true };');
    put(dir, 'restless.config.ts', CAPTURE_CONFIG);
    const status = nextPluginWiringStatus(dir);
    expect(status.hasWithRestless).toBe(false);
    expect(status.hasDefineConfig).toBe(true);
    expect(status.ok).toBe(false);
  });

  it('requires the import AND the call, not a stray mention', () => {
    put(dir, 'next.config.mjs', `// TODO: add withRestless from '@restlessai/sdk/next'
export default {};`);
    put(dir, 'restless.config.ts', `import { defineConfig } from '@restlessai/sdk/next';
// defineConfig never called`);
    const status = nextPluginWiringStatus(dir);
    expect(status.hasWithRestless).toBe(false);
    expect(status.hasDefineConfig).toBe(false);
  });
});
