import fs from 'fs';
import path from 'path';
import { parseOas } from './oas-parse.js';
import { scanFor } from './scanners.js';
import { walkSourceTree, COMMON_IGNORE_DIRS } from './scan-tree.js';

/**
 * Deciding what the extraction should read, before any model runs.
 *
 * The first real run of `context` spent 27 Reads and 2 Globs working out where
 * the API was, hit the turn cap, and returned nothing. Every one of those
 * turns was spent on a question we can answer deterministically in under a
 * second, and the answer it was heading towards was the wrong one anyway: a
 * blind read of `restlesshq/app` finds 235 route handlers, of which 201 are
 * internal dashboard endpoints no external developer can call.
 *
 * So the model is told where to look, and the plan comes from three sources in
 * descending order of authority:
 *
 *   1. The OpenAPI spec (`.restless/openapi.json`, else the project's copy on
 *      the server). This is the API's own account of its public surface, so it
 *      decides WHAT is worth documenting. On `restlesshq/app` it cuts 235
 *      candidate endpoints to the 34 that are actually published.
 *   2. The deterministic endpoint scanners `init` already uses. They decide
 *      WHERE each operation lives - the spec knows `GET /api/v1/projects` is
 *      public, only the scan knows it is served by `.../projects/route.ts`.
 *   3. A plain file walk, when there is neither. A docs repo or a client SDK
 *      has no routes to find, and those are exactly the repos this command
 *      exists to reach.
 *
 * The scan is a SEED, never the truth. It reports 34 endpoints in the CLI repo
 * (which serves none) and only 6 in the ingest server (which serves more), so
 * it is used to narrow attention and is never allowed to define scope on its
 * own when a spec is available.
 */

/** Files per extraction batch. Roughly one read per file, plus room to think. */
export const FILES_PER_BATCH = 7;

/**
 * Ceiling on batches, so a monorepo cannot quietly turn one command into a
 * hundred model calls. Coverage is reported when it bites, rather than being
 * silently trimmed - a run that read half the repo must not look like a run
 * that read all of it.
 */
export const MAX_BATCHES = 12;

/** Shared files worth one pass of their own. */
const MAX_CROSS_CUTTING_FILES = 8;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.java', '.kt', '.php', '.cs', '.rs',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx']);

/**
 * The concerns that never live in a route handler and explain half the
 * surprises a caller hits: how auth works, how paging works, what an error
 * body looks like, what the limits are. A batch of these is where broad
 * context and most use cases come from.
 */
const CROSS_CUTTING_PATTERNS = [
  /middleware/i, /\bauth/i, /session/i, /permission/i, /ratelimit|rate-limit|throttl/i,
  /paginat|cursor/i, /error|exception/i, /valida/i, /serial/i, /webhook/i, /idempot/i,
];

/** `:id` (route style) to `{id}` (OAS style), so the two can be compared. */
function normPath(p) {
  return p.replace(/:(\w+)/g, '{$1}').replace(/\/+$/, '') || '/';
}

function opKey(method, p) {
  return `${String(method).toUpperCase()} ${normPath(p)}`;
}

/** Every operation in a spec, as "METHOD /path" strings. */
export function operationsFromOas(oas) {
  const out = [];
  const paths = oas?.paths;
  if (!paths || typeof paths !== 'object') return out;
  for (const [p, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const m of HTTP_METHODS) {
      if (ops[m]) out.push(opKey(m, p));
    }
  }
  return out;
}

/** The local spec `init` wrote, if this repo has one. */
function loadLocalOas(rootDir, oasFile) {
  if (!oasFile) return null;
  const abs = path.join(rootDir, oasFile);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = parseOas(raw, abs.endsWith('.json') ? 'json' : 'yaml');
    return parsed.ok ? parsed.oas : null;
  } catch {
    return null;
  }
}

/** Chunk a list into batches of `size`. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Shared files worth reading once, found by name rather than by content so
 * this stays cheap. Route files are excluded: they are already covered by the
 * endpoint batches, and re-reading them here would just buy duplicates.
 */
function findCrossCuttingFiles(rootDir, exclude) {
  let files;
  try {
    ({ sourceFiles: files } = walkSourceTree(rootDir, {
      ignoreDirs: new Set([
        ...COMMON_IGNORE_DIRS,
        'dist', 'build', 'vendor', '.next', 'coverage',
        // Nothing here describes the shipped API: fixtures and generators
        // match these name patterns constantly and are never the answer.
        '__tests__', 'tests', 'test', 'fixtures', 'mocks', '__mocks__', 'synth', 'scripts',
      ]),
      isManifest: () => false,
      isSource: (name) =>
        CODE_EXTENSIONS.has(path.extname(name)) &&
        !/\.(test|spec)\./.test(name) &&
        // Type declarations restate shapes without explaining any behaviour.
        !name.endsWith('.d.ts'),
    }));
  } catch {
    return [];
  }

  const scored = [];
  for (const abs of files) {
    const rel = path.relative(rootDir, abs);
    if (exclude.has(rel)) continue;
    const hits = CROSS_CUTTING_PATTERNS.filter((re) => re.test(rel)).length;
    if (hits > 0) scored.push({ rel, hits, depth: rel.split(path.sep).length });
  }
  // Most on-topic first, then shallowest: a top-level `middleware.ts` is more
  // likely to be the real one than something buried six directories down.
  scored.sort((a, b) => b.hits - a.hits || a.depth - b.depth || a.rel.localeCompare(b.rel));
  return scored.slice(0, MAX_CROSS_CUTTING_FILES).map((s) => s.rel);
}

/** A readable inventory for a repo with no API in it (docs, SDK, frontend). */
function buildInventory(rootDir) {
  try {
    const { sourceFiles } = walkSourceTree(rootDir, {
      ignoreDirs: new Set([...COMMON_IGNORE_DIRS, 'dist', 'build', 'vendor', '.next', 'coverage']),
      isManifest: () => false,
      isSource: (name) => {
        const ext = path.extname(name);
        return (DOC_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) && !/\.(test|spec)\./.test(name);
      },
    });
    // Docs first: in a repo with no routes, prose about the API is worth more
    // than its source, and it is the reason a docs repo is worth indexing.
    return sourceFiles
      .map((abs) => path.relative(rootDir, abs))
      .sort((a, b) => {
        const ad = DOC_EXTENSIONS.has(path.extname(a)) ? 0 : 1;
        const bd = DOC_EXTENSIONS.has(path.extname(b)) ? 0 : 1;
        return ad - bd || a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

/**
 * Work out what this run should read.
 *
 * `serverOperations` is the project's spec as the dashboard has it, used when
 * the repo carries no local copy - which is the normal case in the repos this
 * command is aimed at, since a docs repo has no `.restless/` of its own.
 *
 * `changedFiles` narrows everything to an incremental run: batches keep only
 * files that actually moved, and a batch left with nothing is dropped.
 *
 * Returns a plan the caller can execute without re-deriving any of it.
 */
export function buildPlan({
  rootDir,
  oasFile = '',
  serverOperations = [],
  languages = ['javascript'],
  changedFiles = null,
}) {
  const localOas = loadLocalOas(rootDir, oasFile);
  const operations = localOas ? operationsFromOas(localOas) : [...serverOperations].map((o) => opKey(...String(o).split(/\s+/)));
  const specSource = localOas ? 'local' : (serverOperations.length ? 'project' : 'none');

  let scan = { endpoints: [], filesWithEndpoints: [], scannedFileCount: 0, frameworkSignals: [] };
  try {
    scan = scanFor(rootDir, languages);
  } catch {
    // A scanner that throws leaves us with the spec and the file walk, which
    // is degraded but still a plan. Never take the run down over it.
  }

  // Which file serves which operation. Several operations commonly share one
  // file (a route module handling GET and POST), which is exactly why batching
  // is by FILE and not by operation: reading it twice would buy nothing.
  const fileForOp = new Map();
  for (const e of scan.endpoints) {
    const key = opKey(e.method, e.path);
    if (!fileForOp.has(key)) fileForOp.set(key, e.file);
  }

  const opsForFile = new Map();
  const unmappedOperations = [];
  for (const op of operations) {
    const file = fileForOp.get(op);
    if (!file) {
      unmappedOperations.push(op);
      continue;
    }
    if (!opsForFile.has(file)) opsForFile.set(file, []);
    opsForFile.get(file).push(op);
  }

  // With no spec at all, the scan is all we have, so every route file it found
  // is in scope. This is the weaker mode: it cannot tell a public endpoint from
  // an internal one, which is precisely what the spec is for.
  let strategy = 'oas';
  if (operations.length === 0) {
    strategy = scan.filesWithEndpoints.length > 0 ? 'scanner' : 'inventory';
    if (strategy === 'scanner') {
      for (const e of scan.endpoints) {
        if (!opsForFile.has(e.file)) opsForFile.set(e.file, []);
        opsForFile.get(e.file).push(opKey(e.method, e.path));
      }
    }
  }

  let plannedFiles = [...opsForFile.keys()];

  // Inventory mode: no routes to anchor to, so hand over a file list and let
  // the model choose. Still bounded, still batched.
  if (strategy === 'inventory') {
    plannedFiles = buildInventory(rootDir);
  }

  // Incremental: keep only what moved. An operation whose file did not change
  // has already been considered by an earlier run.
  let changedOnly = false;
  if (Array.isArray(changedFiles)) {
    const moved = new Set(changedFiles);
    const before = plannedFiles.length;
    plannedFiles = plannedFiles.filter((f) => moved.has(f));
    changedOnly = plannedFiles.length !== before;
  }

  // Most operations first: if the batch ceiling bites, spend it on the files
  // carrying the most of the public API.
  plannedFiles.sort(
    (a, b) => (opsForFile.get(b)?.length || 0) - (opsForFile.get(a)?.length || 0) || a.localeCompare(b),
  );

  const allBatches = chunk(plannedFiles, FILES_PER_BATCH);
  const batches = allBatches.slice(0, MAX_BATCHES).map((files, i) => ({
    label: `${i + 1}/${Math.min(allBatches.length, MAX_BATCHES)}`,
    files,
    operations: files.flatMap((f) => opsForFile.get(f) || []),
  }));
  const skippedFiles = plannedFiles.length - batches.reduce((n, b) => n + b.files.length, 0);

  // The cross-cutting pass is about the whole API, so an incremental run skips
  // it: middleware that did not change has nothing new to say.
  const covered = new Set(plannedFiles);
  const crossCuttingFiles = changedOnly || strategy === 'inventory'
    ? []
    : findCrossCuttingFiles(rootDir, covered);

  return {
    strategy,
    specSource,
    batches,
    crossCutting: crossCuttingFiles.length
      ? { label: 'shared', files: crossCuttingFiles, operations: [] }
      : null,
    unmappedOperations,
    coverage: {
      operations: operations.length,
      mappedOperations: operations.length - unmappedOperations.length,
      routeFilesFound: scan.filesWithEndpoints.length,
      endpointsFound: scan.endpoints.length,
      scannedFileCount: scan.scannedFileCount,
      filesPlanned: plannedFiles.length,
      filesSkipped: Math.max(0, skippedFiles),
    },
  };
}
