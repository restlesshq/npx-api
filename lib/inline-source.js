/**
 * Handing the model source code in the prompt instead of making it fetch
 * the files one at a time.
 *
 * Measured on a 42-file Express fixture (`~/.restless/debug`, 2026-09-01):
 * a 2,241-char prompt reached its first turn in 4.6s and a 45,269-char
 * prompt reached its first turn in 4.9s. A 20x larger prompt cost 0.3s.
 * Over the same run, 42 `Read` turns cost ~3.6s each - 150s in total - to
 * deliver 37KB of text that prefills for free.
 *
 * So the round trip is the expense, not the token count, and any file we
 * can name deterministically should arrive with the prompt. `scanCodebase`
 * already names the route files in about a millisecond.
 *
 * This is a hint, never a replacement: the model keeps its `Read` tool, the
 * block says which files were left out, and a caller that inlines nothing
 * still works exactly as before.
 */
import fs from 'fs';
import path from 'path';
import { scanFor } from './scanners.js';
import * as timings from './timings.js';

/**
 * Total inlined source. Sized to be generous for a normal service (the
 * Express fixture's whole route + schema + controller + service tree is
 * 37KB) while still refusing to paste a monorepo into a prompt.
 */
export const DEFAULT_BUDGET_BYTES = 160_000;

/**
 * Per-file ceiling. A single file this big is a bundle, a lockfile or a
 * generated client, and it would eat the budget that twenty real route
 * files need.
 */
export const MAX_FILE_BYTES = 48_000;

/**
 * Files whose NAME says they describe request/response shapes. Checked
 * after the route files and their imports, so these only pull in what the
 * first two passes missed. Deliberately name-based: it is the one signal
 * that reads the same in every language we support.
 */
const SHAPE_NAME = /(schema|schemas|model|models|serializer|serializers|dto|dtos|type|types|entity|entities|validator|validators|params|contract|contracts)\b/i;

/** Relative imports, the forms that appear across our supported languages. */
const RELATIVE_IMPORT = [
  // JS / TS: import x from './y', export * from '../y', require('./y')
  /(?:from|require\s*\(|import)\s*['"](\.[^'"]+)['"]/g,
  // Python: from .y import x / from ..pkg.y import x
  /from\s+(\.[\w.]*)\s+import\s/g,
  // Ruby: require_relative 'y'
  /require_relative\s+['"]([^'"]+)['"]/g,
];

/** Extensions we are willing to paste into a prompt, by language family. */
const SOURCE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go',
]);

function isSourceFile(rel) {
  return SOURCE_EXT.has(path.extname(rel).toLowerCase());
}

/**
 * Resolve one relative import specifier to a repo-relative file, trying the
 * extensions and index forms each language uses. Returns null when nothing
 * on disk matches - a bare-module import, a path alias, a generated file.
 */
function resolveImport(fromRel, spec, rootDir) {
  // Python's `from .foo import x` / `from ..pkg.foo import x`: leading dots
  // are directory hops, remaining dots are separators.
  let candidate;
  if (/^\.+[\w.]*$/.test(spec) && spec.includes('.') && !spec.startsWith('./') && !spec.startsWith('../')) {
    const dots = spec.match(/^\.+/)[0].length;
    const rest = spec.slice(dots).replace(/\./g, path.sep);
    candidate = path.join(path.dirname(fromRel), '../'.repeat(dots - 1), rest);
  } else {
    candidate = path.join(path.dirname(fromRel), spec);
  }

  const tries = [
    candidate,
    ...[...SOURCE_EXT].map((ext) => candidate + ext),
    ...[...SOURCE_EXT].map((ext) => path.join(candidate, 'index' + ext)),
    ...[...SOURCE_EXT].map((ext) => path.join(candidate, '__init__' + ext)),
  ];
  for (const t of tries) {
    const rel = path.normalize(t);
    // Never climb out of the tree we were asked to read.
    if (rel.startsWith('..')) continue;
    try {
      if (fs.statSync(path.join(rootDir, rel)).isFile()) return rel;
    } catch {}
  }
  return null;
}

function readIfReasonable(rootDir, rel) {
  try {
    const abs = path.join(rootDir, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Rank the files worth inlining, most useful first.
 *
 * Three passes, in priority order:
 *   1. the route files themselves - the endpoints are literally in them;
 *   2. whatever those files import by relative path, followed `hops` deep,
 *      which is where request/response shapes and handlers actually live;
 *   3. anything left whose name says it describes a shape.
 *
 * Ordering matters more than the cutoff: the budget is spent from the top,
 * so a repo too big to inline still gets its route files in.
 *
 * `hops` defaults to 2 because one hop stops short of real files: on the
 * Express fixture, `common.schema.js` is imported BY the per-resource
 * schemas and the services are imported by the controllers, so both sit two
 * hops from a route file. Going deeper is safe precisely because the budget
 * is spent in priority order - a wrong guess at depth 2 costs tokens that
 * are nearly free, while a missing schema costs the model a round trip.
 */
export function rankSourceFiles(rootDir, { seedFiles = [], extraFiles = [], hops = 2 } = {}) {
  const seen = new Set();
  const ranked = [];
  const add = (rel) => {
    const norm = path.normalize(rel);
    if (seen.has(norm) || !isSourceFile(norm)) return;
    seen.add(norm);
    ranked.push(norm);
  };

  for (const rel of seedFiles) add(rel);

  // Pass 2: follow relative imports outward, breadth-first, so files closer
  // to a route file are ranked (and therefore budgeted) ahead of files
  // reached only through several hops.
  let frontier = [...ranked];
  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const next = [];
    for (const rel of frontier) {
      const content = readIfReasonable(rootDir, rel);
      if (!content) continue;
      for (const pattern of RELATIVE_IMPORT) {
        for (const m of content.matchAll(pattern)) {
          const resolved = resolveImport(rel, m[1], rootDir);
          if (resolved && !seen.has(resolved)) {
            add(resolved);
            next.push(resolved);
          }
        }
      }
    }
    frontier = next;
  }

  // Pass 3: explicitly offered files, shape-named ones first.
  const extras = [...extraFiles].filter((f) => isSourceFile(f));
  for (const rel of extras.filter((f) => SHAPE_NAME.test(path.basename(f)))) add(rel);
  for (const rel of extras) add(rel);

  return ranked;
}

/**
 * Build the prompt block.
 *
 * Returns `{ block, included, omitted, bytes }`. `block` is `''` when there
 * was nothing to inline, so a prompt can interpolate it unconditionally and
 * the no-seed case renders exactly the prompt that shipped before.
 */
export function buildSourceBlock(rootDir, {
  seedFiles = [],
  extraFiles = [],
  hops,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  heading = 'Source files (already read for you)',
} = {}) {
  const endSpan = timings.start('inline: read source for prompt', { kind: timings.KINDS.SCAN });
  try {
    const ranked = rankSourceFiles(rootDir, { seedFiles, extraFiles, hops });
    const parts = [];
    const included = [];
    const omitted = [];
    let bytes = 0;

    for (const rel of ranked) {
      const content = readIfReasonable(rootDir, rel);
      if (content === null) { omitted.push(rel); continue; }
      if (bytes + content.length > budgetBytes) { omitted.push(rel); continue; }
      bytes += content.length;
      included.push(rel);
      // Fenced with the file path on the header line. A language tag would
      // have to be guessed per extension and buys nothing here - the model
      // is reading paths, not syntax highlighting.
      parts.push(`### ${rel}\n\n\`\`\`\n${content.replace(/\s+$/, '')}\n\`\`\``);
    }

    if (!included.length) return { block: '', included, omitted, bytes: 0 };

    const lines = [
      `## ${heading}`,
      '',
      `The ${included.length} file${included.length === 1 ? '' : 's'} below ${included.length === 1 ? 'is' : 'are'} reproduced in full, straight from disk. **Do not re-read ${included.length === 1 ? 'it' : 'them'} with the Read tool** - you already have the contents, and every tool call costs the user several seconds.`,
    ];
    if (omitted.length) {
      lines.push(
        '',
        `Not included (read these yourself only if you actually need them): ${omitted.slice(0, 25).join(', ')}${omitted.length > 25 ? `, and ${omitted.length - 25} more` : ''}.`,
      );
    }
    lines.push('', ...parts);

    return { block: lines.join('\n'), included, omitted, bytes };
  } finally {
    endSpan();
  }
}

/**
 * The common case: inline the API's route files and what they import.
 *
 * `languages` routes to the right deterministic scanner via `scanFor`, so a
 * Django or Rails API gets its own route files rather than nothing. A
 * scanner that finds no routes yields an empty block and the model explores
 * as it always did.
 */
export function buildApiSourceBlock(apiDir, { languages = ['javascript'], extraFiles = [], hops, budgetBytes } = {}) {
  let scan;
  try {
    scan = scanFor(apiDir, languages);
  } catch {
    return { block: '', included: [], omitted: [], bytes: 0 };
  }
  return buildSourceBlock(apiDir, {
    seedFiles: scan.filesWithEndpoints,
    extraFiles,
    hops,
    budgetBytes,
  });
}

/**
 * The conventional server entry filenames, at the root and one level deep.
 *
 * `setup-sdk` has to EDIT the entry file, so it needs that file in hand more
 * than it needs any route file. The list mirrors the names
 * `prompts/setup-sdk.md` already tells the model to try, so the prompt and
 * the prefill agree on what "the entry file" means.
 */
const ENTRY_BASENAMES = ['server', 'index', 'app', 'main', 'application', 'wsgi', 'asgi'];
const ENTRY_DIRS = ['.', 'src', 'app', 'lib', 'server', 'api', 'config'];

export function findEntryCandidates(dir) {
  const found = [];
  for (const sub of ENTRY_DIRS) {
    for (const base of ENTRY_BASENAMES) {
      for (const ext of SOURCE_EXT) {
        const rel = path.normalize(path.join(sub, base + ext));
        if (rel.startsWith('..')) continue;
        try {
          if (fs.statSync(path.join(dir, rel)).isFile()) found.push(rel);
        } catch {}
      }
    }
  }
  return found;
}

/**
 * Source block for the wiring step: entry-file candidates first, then the
 * route files and their imports.
 *
 * The priority is deliberately the reverse of `buildApiSourceBlock`'s. Spec
 * generation cares most about routes; wiring cares most about the file it is
 * about to edit, and would rather lose a route file to the budget than the
 * entry point.
 */
export function buildWiringSourceBlock(installDir, { languages = ['javascript'], extraFiles = [], budgetBytes } = {}) {
  let routeFiles = [];
  try {
    routeFiles = scanFor(installDir, languages).filesWithEndpoints;
  } catch {}
  return buildSourceBlock(installDir, {
    seedFiles: [...findEntryCandidates(installDir), ...extraFiles],
    extraFiles: routeFiles,
    // One hop is right here: the entry file's own imports show the app
    // construction and existing middleware order, which is all the wiring
    // decision needs. Two hops would pull in the whole service layer for a
    // step that never looks at it.
    hops: 1,
    budgetBytes,
  });
}
