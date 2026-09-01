import fs from 'fs';
import path from 'path';
import * as timings from './timings.js';

/**
 * Deterministic endpoint + framework discovery for Node/TS codebases.
 *
 * Walks a directory ONCE, reads each JS/TS source file ONCE, and extracts
 * two things from every file:
 *   1. Route hits: call-expression routes (`app.get('/x')`) and NestJS
 *      decorators via regex, plus Next.js file-based routes (App Router
 *      `route.ts`, Pages Router `pages/api/**`) whose path lives in the file
 *      path rather than a call expression - so the regex can't see them.
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

// Exported so `lib/detect-stack.js` walks the same tree we do. It keeps its
// own superset (foreign vendor dirs like `.venv`, `vendor/`) because a
// manifest buried in an installed dependency isn't evidence about the project.
export const IGNORE_DIRS = new Set([
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

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// A Next.js App Router route handler file is literally named `route.<ext>`.
// The URL path comes from the *directory* the file sits in, not from any
// call expression - which is exactly why FN_PATTERN/DECOR_PATTERN can't see
// these routes and a Next.js app surfaces zero endpoints from them.
const APP_ROUTE_FILE = /^route\.(js|jsx|ts|tsx|mjs|cjs)$/;

// Turn one filesystem segment into a URL path part, applying Next.js dynamic
// conventions: `[id]` -> `{id}`, `[...slug]`/`[[...slug]]` -> `{slug}`.
function segmentToUrlPart(seg) {
  const optionalCatchAll = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) return `{${optionalCatchAll[1]}}`;
  const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `{${catchAll[1]}}`;
  const dynamic = seg.match(/^\[(.+)\]$/);
  if (dynamic) return `{${dynamic[1]}}`;
  return seg;
}

// Build a URL path from the folder segments between the routing root (`app`
// or `pages`) and the route file. Drops the segments that don't contribute
// to the URL - route groups `(marketing)`, interception markers `(.)`, and
// parallel slots `@modal` - and returns null when the route is opted out of
// routing entirely by a private `_folder`.
function segmentsToUrlPath(segments) {
  const parts = [];
  for (const seg of segments) {
    if (seg.startsWith('_')) return null; // private folder - not routable
    if (/^\(.*\)$/.test(seg)) continue; // route group / interception marker
    if (seg.startsWith('@')) continue; // parallel route slot
    parts.push(segmentToUrlPart(seg));
  }
  return '/' + parts.join('/');
}

// Which HTTP methods a Next.js App Router `route.<ext>` actually exports.
// Covers the three shapes Next accepts: `export function GET`, `export const
// GET =`, and re-exports `export { GET, handler as POST }`.
function routeHandlerMethods(content) {
  const methods = new Set();
  for (const m of content.matchAll(
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  )) {
    methods.add(m[1]);
  }
  for (const m of content.matchAll(
    /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  )) {
    methods.add(m[1]);
  }
  for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const exported = part.trim().split(/\s+as\s+/).pop().trim();
      if (HTTP_METHODS.includes(exported)) methods.add(exported);
    }
  }
  return [...methods];
}

// Detect Next.js file-based routes (App Router `route.<ext>` and Pages Router
// `pages/api/**`). These live in the file path, so they're enumerated
// deterministically from the tree rather than by matching call expressions.
// Returns route hits shaped like scanContent's, with `style: 'file'`.
function detectFileRoutes(rel, content) {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  const ext = path.extname(base);
  if (!SOURCE_EXTS.has(ext)) return [];

  // App Router: a `route.<ext>` under the rightmost `app/` directory. Using
  // the rightmost `app` handles `app/`, `src/app/`, and `apps/web/app/`.
  if (APP_ROUTE_FILE.test(base)) {
    const appIdx = parts.lastIndexOf('app');
    if (appIdx !== -1) {
      const urlPath = segmentsToUrlPath(parts.slice(appIdx + 1, parts.length - 1));
      if (urlPath !== null) {
        // Next requires a route handler to export at least one method. If our
        // regex misses an exotic form, keep the path in the list (as GET) so
        // it still counts toward coverage rather than silently vanishing.
        let methods = routeHandlerMethods(content);
        if (methods.length === 0) methods = ['GET'];
        return methods.map((method) => ({ method, path: urlPath, file: rel, style: 'file' }));
      }
    }
  }

  // Pages Router API routes: every file under `pages/api/**` is an endpoint
  // (a single default-exported handler serving all methods, so the method is
  // recorded as GET - a placeholder for the checklist, not a real constraint).
  const pagesIdx = parts.lastIndexOf('pages');
  if (pagesIdx !== -1 && parts[pagesIdx + 1] === 'api') {
    if (base.startsWith('_')) return []; // _middleware, _app, ... aren't endpoints
    const dirSegs = parts.slice(pagesIdx + 1, parts.length - 1); // includes 'api'
    const nameNoExt = base.slice(0, base.length - ext.length);
    const fileSegs = nameNoExt === 'index' ? [] : [nameNoExt];
    const urlPath = segmentsToUrlPath([...dirSegs, ...fileSegs]);
    if (urlPath !== null) return [{ method: 'GET', path: urlPath, file: rel, style: 'file' }];
  }

  return [];
}

// Dependencies (from package.json) that identify an HTTP framework.
//
// This list is for LABELLING a framework we can actually wire, so it stays
// narrow. `lib/detect-stack.js` deliberately keeps a WIDER list for deciding
// whether a repo is Node at all - do not merge the two.
export function isFrameworkDep(name) {
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
  const endWalkSpan = timings.start('walk: scan-codebase', { kind: timings.KINDS.SCAN });
  const sourceFiles = [];
  const packageJsons = [];
  walk(rootDir, sourceFiles, packageJsons, 0);
  endWalkSpan({ files: sourceFiles.length, manifests: packageJsons.length });

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
    // Call-expression routes (Express/Fastify/Nest) plus file-based routes
    // (Next.js App/Pages Router), which the regex patterns can't see.
    const hits = [...scanContent(content, rel), ...detectFileRoutes(rel, content)];
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
