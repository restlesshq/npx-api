import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanCodebase, findEndpoints, findFrameworkSignals } from '../lib/find-endpoints.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-endpoints-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('scanCodebase', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches inline string-literal routes (Express)', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'app', dependencies: { express: '^4' } }));
    write(
      dir,
      'src/server.js',
      `const app = express();\napp.get('/pets', h);\napp.post('/pets', h);\napp.get('/pets/:id', h);\n`,
    );
    const { endpoints } = findEndpoints(dir);
    const sigs = endpoints.map((e) => `${e.method} ${e.path}`);
    expect(sigs).toEqual(['GET /pets', 'POST /pets', 'GET /pets/:id']);
  });

  it('skips non-literal (variable) paths', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'app', dependencies: { fastify: '^4' } }));
    // `fastify.get(path, ...)` binds the method to a variable - exactly the
    // pattern the regex cannot see, and the reason framework signals exist.
    write(dir, 'src/op.js', `function getAPIs(fastify, path) {\n  fastify.get(path, { schema });\n}\n`);
    const { endpoints } = findEndpoints(dir);
    expect(endpoints).toEqual([]);
  });

  it('reports per-package framework signals in a mixed monorepo', () => {
    // Root: an Express host shim that forwards into Fastify.
    write(dir, 'package.json', JSON.stringify({ name: 'root', dependencies: { express: '^4' } }));
    write(
      dir,
      'packages/core-server/package.json',
      JSON.stringify({ name: '@x/core-server', dependencies: { express: '^4' } }),
    );
    write(dir, 'packages/core-server/src/index.ts', `const app = express();\napp.use(routes);\n`);

    // The real API: Fastify, route modules + variable paths (zero inline routes),
    // fronted by an Express router that delegates via fastify.routing.
    write(
      dir,
      'packages/api/package.json',
      JSON.stringify({
        name: '@x/api',
        dependencies: { fastify: '^4', '@fastify/swagger': '^8', express: '^4' },
      }),
    );
    write(
      dir,
      'packages/api/src/index.ts',
      `import type { FastifyInstance } from 'fastify';\n` +
        `const fastify = fastifyModule({ logger: true });\n` +
        `const router = express.Router();\n` +
        `router.use((req, res) => fastify.routing(req, res));\n` +
        `fastify.addHook('onRequest', h);\n`,
    );
    write(
      dir,
      'packages/api/src/routes/apis/routes.ts',
      `export default async function routes(fastify) {\n` +
        `  fastify.register(async instance => {\n` +
        `    getAPIs(instance, '/');\n` +
        `  }, { prefix: '/apis' });\n` +
        `}\n`,
    );

    // A plain Express dashboard package with real inline routes.
    write(
      dir,
      'packages/dash/package.json',
      JSON.stringify({ name: '@x/dash', dependencies: { express: '^4' } }),
    );
    write(dir, 'packages/dash/src/routes.ts', `const router = express.Router();\nrouter.get('/home', h);\n`);

    const signals = findFrameworkSignals(dir);
    const byPkg = Object.fromEntries(signals.map((s) => [s.package, s]));

    // The Fastify API is correctly flagged, despite matching 0 inline routes.
    const api = byPkg['packages/api'];
    expect(api).toBeDefined();
    expect(api.name).toBe('@x/api');
    expect(api.frameworkDeps).toContain('fastify');
    expect(api.frameworkDeps).toContain('@fastify/swagger');
    expect(api.oasGenDeps).toEqual(['@fastify/swagger']);
    expect(api.endpointCount).toBe(0);
    expect(api.sourceMarkers).toContain('fastify()');
    expect(api.sourceMarkers).toContain('FastifyInstance');
    // The Express-shim-into-Fastify tell.
    expect(api.sourceMarkers).toContain('fastify.routing()');

    // The Express dashboard shows its real inline routes.
    expect(byPkg['packages/dash'].endpointCount).toBe(1);
    expect(byPkg['packages/dash'].frameworkDeps).toEqual(['express']);
  });

  it('omits packages with no framework signal', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'root' }));
    write(
      dir,
      'packages/utils/package.json',
      JSON.stringify({ name: '@x/utils', dependencies: { lodash: '^4' } }),
    );
    write(dir, 'packages/utils/src/index.ts', `export const noop = () => {};\n`);
    expect(findFrameworkSignals(dir)).toEqual([]);
  });

  it('ignores node_modules', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'app', dependencies: { express: '^4' } }));
    write(dir, 'src/server.js', `const app = express();\napp.get('/real', h);\n`);
    write(dir, 'node_modules/evil/index.js', `app.get('/should-not-appear', h);\n`);
    write(dir, 'node_modules/evil/package.json', JSON.stringify({ name: 'evil', dependencies: { fastify: '^4' } }));
    const { endpoints, frameworkSignals } = scanCodebase(dir);
    expect(endpoints.map((e) => e.path)).toEqual(['/real']);
    expect(frameworkSignals.map((s) => s.package)).toEqual(['.']);
  });
});
