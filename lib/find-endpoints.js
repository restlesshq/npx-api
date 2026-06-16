import fs from 'fs';
import path from 'path';

/**
 * Deterministic endpoint + framework discovery for Node/TS codebases.
 *
 * Walks a directory ONCE, reads each JS/TS source file ONCE, and extracts
 * two things from every file:
 *   1. Route/decorator hits (the same patterns the LLM prompt uses).
 *   2. Framework signals (imports/calls that reveal which HTTP framework
 *      a package actually uses), aggregated per package.json.
 *
 * Framework signals exist because the route regex only catches INLINE
 * string-literal routes like `app.get('/x')`. Fastify/Nest commonly
 * declare routes indirectly - route modules registered via
 * `fastify.register(fn, { prefix })`, helpers like `getAPIs(instance, '/')`
 * that bind the method to a variable path internally, `fastify.route({
 * method, url })`, schema/contract-driven routes - none of which the
 * regex sees. A package can therefore have a real API and surface ZERO
 * endpoints. Without a separate framework signal, the LLM mislabels such
 * a package (e.g. a Fastify API fronted by an Express host shim reads as
 * "Express"). The per-package signals give the LLM the framework truth
 * deterministically instead of asking it to re-derive it with tool calls.
 *
 * Skips the obvious noise dirs (`node_modules`, `dist`, etc.) so the scan
 * stays fast.
 */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.restless',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.vercel',
  '.turbo',
  '.cache',
  '.svelte-kit',
  '.parcel-cache',
]);

const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.tsx', '.jsx']);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB - skip minified bundles / fixtures
const MAX_DEPTH = 10;

// Function-style: `app.get(...)`, `router.post(...)`, `fastify.delete(...)`,
// `api.route(...)`. The leading negative lookbehind via `(^|[^.\w])` stops
// us from matching member paths like `something.app.get`.
const FN_PATTERN =
  /(?:^|[^.\w])(app|router|fastify|api|server|instance)\.(get|post|put|delete|patch|all|route)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Decorator-style: NestJS `@Get('/pets')`, `@Controller('/v1')`.
const DECOR_PATTERN =
  /@(Get|Post|Put|Delete|Patch|All|Options|Head|Controller)\s*\(\s*['"`]([^'"`]*)['"`]/g;

// Dependencies (from package.json) that identify an HTTP framework.
function isFrameworkDep(name) {
  return (
    /^(express|fastify|koa|hono|next|restify|connect|hapi)$/.test(name) ||
    /^@fastify\//.test(name) ||
    /^@koa\//.test(name) ||
    /^@nestjs\//.test(name) ||
    /^@hapi\//.test(name) ||
    /^fastify-/.test(name)
  );
}

// Dependencies that let a framework GENERATE an OpenAPI spec natively.
// Mirrors the "OAS generation support" list in prompts/detect-endpoints.md.
const OAS_GEN_DEPS = new Set([
  '@fastify/swagger',
  '@nestjs/swagger',
  'swagger-jsdoc',
  'tsoa',
  'express-openapi',
]);

// Source markers that reveal the framework actually handling requests.
// "Strong" markers (constructing/typing a server) are enough on their own
// to flag a package as framework-bearing; "weak" markers (`.register`,
// `.addHook` - common but not exclusive to one framework) are only shown
// for packages already flagged, to avoid pulling in unrelated packages.
const STRONG_MARKERS = [
  [/\bfastify(?:Module)?\s*\(/, 'fastify()'],
  [/\bFastifyInstance\b/, 'FastifyInstance'],
  [/\bfastify\.routing\s*\(/, 'fastify.routing()'],
  [/\bexpress\s*\(\s*\)/, 'express()'],
  [/\bexpress\.Router\s*\(/, 'express.Router()'],
  [/\bnew\s+Koa\s*\(/, 'new Koa()'],
  [/\bnew\s+Hono\s*\(/, 'new Hono()'],
  [/@Controller\s*\(/, '@Controller()'],
];
const WEAK_MARKERS = [
  [/\.register\s*\(/, '.register()'],
  [/\.addHook\s*\(/, '.addHook()'],
];

function walk(dir, sourceFiles, packageJsons, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // don't follow symlinks (loops + perf)
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(full, sourceFiles, packageJsons, depth + 1);
    } else if (entry.isFile()) {
      if (entry.name === 'package.json') packageJsons.push(full);
      else if (SOURCE_EXTS.has(path.extname(entry.name))) sourceFiles.push(full);
    }
  }
}

function scanContent(content, rel) {
  const hits = [];

  for (const m of content.matchAll(FN_PATTERN)) {
    const method = m[2].toUpperCase();
    const routePath = m[3];
    if (!routePath.startsWith('/')) continue; // skip dynamic values / false positives
    hits.push({ method, path: routePath, file: rel, style: 'function' });
  }

  for (const m of content.matchAll(DECOR_PATTERN)) {
    const decorator = m[1];
    const routePath = m[2];
    hits.push({
      method: decorator.toUpperCase(),
      path: routePath,
      file: rel,
      style: 'decorator',
    });
  }

  return hits;
}

function readPackageJson(abs) {
  try {
    const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const depNames = Object.keys(deps);
    return {
      name: pkg.name || null,
      frameworkDeps: depNames.filter(isFrameworkDep).sort(),
      oasGenDeps: depNames.filter((d) => OAS_GEN_DEPS.has(d)).sort(),
    };
  } catch {
    return { name: null, frameworkDeps: [], oasGenDeps: [] };
  }
}

/**
 * Single-pass scan of a codebase. Walks once, reads each source file once,
 * and returns both endpoint hits and per-package framework signals.
 *
 * Returns:
 *   {
 *     endpoints: [{ method, path, file, style }],
 *     filesWithEndpoints: string[],
 *     scannedFileCount: number,
 *     frameworkSignals: [{
 *       package,        // dir relative to rootDir ('.' for root)
 *       name,           // package.json "name" or null
 *       frameworkDeps,  // framework deps declared in this package.json
 *       oasGenDeps,     // OAS-generation-capable deps (@fastify/swagger, ...)
 *       sourceMarkers,  // framework calls/types found in this package's source
 *       endpointCount,  // inline routes the regex matched inside this package
 *     }],
 *   }
 *
 * `frameworkSignals` only includes packages that show a framework signal
 * (a framework dependency OR a strong source marker), so it's a short,
 * high-signal list even in a large monorepo.
 */
export function scanCodebase(rootDir) {
  const sourceFiles = [];
  const packageJsons = [];
  walk(rootDir, sourceFiles, packageJsons, 0);

  // Build package records, keyed by absolute dir. Sorted by path length
  // descending so the nearest-ancestor lookup picks the deepest match.
  const packages = packageJsons.map((abs) => {
    const absDir = path.dirname(abs);
    const meta = readPackageJson(abs);
    return {
      absDir,
      package: path.relative(rootDir, absDir) || '.',
      name: meta.name,
      frameworkDeps: meta.frameworkDeps,
      oasGenDeps: meta.oasGenDeps,
      strong: new Set(),
      weak: new Set(),
      endpointCount: 0,
    };
  });
  const byDepth = [...packages].sort((a, b) => b.absDir.length - a.absDir.length);
  const ownerOf = (file) =>
    byDepth.find(
      (p) => file === p.absDir || file.startsWith(p.absDir + path.sep),
    ) || null;

  const endpoints = [];
  const filesWithEndpoints = new Set();

  for (const file of sourceFiles) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(rootDir, file);
    const hits = scanContent(content, rel);
    const owner = ownerOf(file);

    if (hits.length > 0) {
      endpoints.push(...hits);
      filesWithEndpoints.add(rel);
      if (owner) owner.endpointCount += hits.length;
    }

    if (owner) {
      for (const [re, label] of STRONG_MARKERS) {
        if (!owner.strong.has(label) && re.test(content)) owner.strong.add(label);
      }
      for (const [re, label] of WEAK_MARKERS) {
        if (!owner.weak.has(label) && re.test(content)) owner.weak.add(label);
      }
    }
  }

  const frameworkSignals = packages
    .filter((p) => p.frameworkDeps.length > 0 || p.strong.size > 0)
    .map((p) => ({
      package: p.package,
      name: p.name,
      frameworkDeps: p.frameworkDeps,
      oasGenDeps: p.oasGenDeps,
      // Strong markers first, then weak - weak only ride along on packages
      // already flagged framework-bearing.
      sourceMarkers: [...p.strong, ...p.weak],
      endpointCount: p.endpointCount,
    }))
    .sort((a, b) => a.package.localeCompare(b.package));

  return {
    endpoints,
    filesWithEndpoints: [...filesWithEndpoints],
    scannedFileCount: sourceFiles.length,
    frameworkSignals,
  };
}

/**
 * Find endpoints in a directory. Thin wrapper over `scanCodebase` kept for
 * callers that only want the route list.
 *
 * `endpoints[].method` is uppercase (`GET`, `POST`, ...). For NestJS
 * decorators the method comes from the decorator name (`GET` for `@Get`,
 * `CONTROLLER` for `@Controller` - a base path, not a real method).
 * `path` is the literal string passed to the decorator or router call.
 */
export function findEndpoints(rootDir) {
  const { endpoints, filesWithEndpoints, scannedFileCount } = scanCodebase(rootDir);
  return { endpoints, filesWithEndpoints, scannedFileCount };
}

/**
 * Per-package framework signals. Thin wrapper over `scanCodebase` for
 * callers that only want the framework breakdown.
 */
export function findFrameworkSignals(rootDir) {
  return scanCodebase(rootDir).frameworkSignals;
}
