import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectNext, isNextMiddlewareFile, isNextFramework } from '../lib/next-detect.js';

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
