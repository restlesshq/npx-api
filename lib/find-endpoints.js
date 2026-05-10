import fs from 'fs';
import path from 'path';

/**
 * Deterministic endpoint discovery for Node/TS codebases.
 *
 * Walks a directory, greps JS/TS source for the same route and decorator
 * patterns the LLM prompt uses, returns structured results. Skips the
 * obvious noise dirs (`node_modules`, `dist`, `build`, etc.) so the scan
 * stays fast.
 *
 * This exists because the LLM used to run the grep itself, which burned
 * tool calls and occasionally omitted matches on retries. Running the grep
 * locally is O(tens of ms) on typical repos and gives the LLM authoritative
 * input instead of asking it to rediscover the same data every run.
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

function walk(dir, out, depth) {
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
      walk(full, out, depth + 1);
    } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function scanFile(filePath, rootDir) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (stat.size > MAX_FILE_SIZE) return [];

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const rel = path.relative(rootDir, filePath);
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

/**
 * Find endpoints in a directory.
 *
 * Returns:
 *   {
 *     endpoints: [{ method, path, file, style }],
 *     filesWithEndpoints: string[],
 *     scannedFileCount: number,
 *   }
 *
 * `endpoints[].method` is uppercase (`GET`, `POST`, ...). For NestJS
 * decorators the method comes from the decorator name (`GET` for `@Get`,
 * `CONTROLLER` for `@Controller` - a base path, not a real method).
 * `path` is the literal string passed to the decorator or router call.
 */
export function findEndpoints(rootDir) {
  const files = [];
  walk(rootDir, files, 0);

  const endpoints = [];
  const filesWithEndpoints = new Set();

  for (const file of files) {
    const hits = scanFile(file, rootDir);
    if (hits.length === 0) continue;
    endpoints.push(...hits);
    filesWithEndpoints.add(hits[0].file);
  }

  return {
    endpoints,
    filesWithEndpoints: [...filesWithEndpoints],
    scannedFileCount: files.length,
  };
}
