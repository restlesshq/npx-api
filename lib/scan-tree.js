/**
 * The tree walk and package-scoring pass the per-language endpoint scanners
 * share.
 *
 * `find-endpoints-{python,ruby,go}.js` each carried their own copy of both.
 * `walk` was byte-identical apart from a two-line file-classification
 * predicate, and the ~75-line scan orchestration differed only in which
 * manifest parser and route matcher it called. What is genuinely per-language -
 * `IGNORE_DIRS`, `isFrameworkDep`, `STRONG_MARKERS`, the route regexes - stays
 * in those files, because that is data about a language and not an algorithm.
 *
 * `find-endpoints.js` (JavaScript) deliberately does NOT use this. It has three
 * real behavioural differences - file-based App Router routes, a signal filter
 * that requires a strong marker rather than any marker, and no synthetic root
 * package - and adding three knobs to cover them would cost more clarity than
 * the sharing buys, on the one language that has all the users.
 *
 * A LEAF module: only fs and path.
 */

import fs from 'fs';
import path from 'path';

/** Skip minified bundles and vendored fixtures rather than reading them. */
export const MAX_FILE_SIZE = 2 * 1024 * 1024;
export const MAX_DEPTH = 10;

/**
 * Directories no language wants to walk into. Each scanner spreads this and
 * adds its own ecosystem's vendor dirs.
 */
export const COMMON_IGNORE_DIRS = ['.git', '.restless', 'node_modules'];

/**
 * Collect source files and manifests under `rootDir`.
 *
 * Symlinks are skipped outright: following them risks walking out of the repo
 * entirely, and a symlinked source tree is not where a project's routes live.
 */
export function walkSourceTree(rootDir, { ignoreDirs, isManifest, isSource, maxDepth = MAX_DEPTH }) {
  const sourceFiles = [];
  const manifestPaths = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (isManifest(entry.name)) manifestPaths.push(full);
        else if (isSource(entry.name)) sourceFiles.push(full);
      }
    }
  }

  walk(rootDir, 0);
  return { sourceFiles, manifestPaths };
}

/**
 * Walk the tree, match routes, and score each package's framework signals.
 *
 * Returns the shape every scanner returns, which is what lets `scanFor` merge
 * results from several languages without knowing how many ran:
 *
 *   { endpoints, filesWithEndpoints, scannedFileCount, frameworkSignals }
 */
export function scanTree(rootDir, {
  ignoreDirs,
  isManifest,
  isSource,
  readManifest,
  scanContent,
  strongMarkers = [],
  weakMarkers = [],
  isFrameworkDep = () => false,
  isOasGenDep = () => false,
  maxDepth = MAX_DEPTH,
  maxFileSize = MAX_FILE_SIZE,
}) {
  const { sourceFiles, manifestPaths } = walkSourceTree(rootDir, {
    ignoreDirs, isManifest, isSource, maxDepth,
  });

  // One package record per directory holding a manifest. Several manifests can
  // share a directory - `pyproject.toml` + `requirements.txt`, a Gemfile next
  // to a gemspec - so MERGE rather than creating two packages that split one
  // project's signals, or letting whichever the walk reached last win. The
  // first name found sticks, because the manifest that carries a project name
  // (pyproject.toml, a gemspec) is the authoritative one and a lockfile-style
  // sibling has none.
  const byDir = new Map();
  for (const abs of manifestPaths) {
    const absDir = path.dirname(abs);
    const meta = readManifest(abs);
    const existing = byDir.get(absDir);
    if (existing) {
      existing.deps = [...new Set([...existing.deps, ...meta.deps])];
      existing.name = existing.name || meta.name;
      continue;
    }
    byDir.set(absDir, {
      absDir,
      package: path.relative(rootDir, absDir) || '.',
      name: meta.name,
      deps: meta.deps,
      strong: new Set(),
      weak: new Set(),
      endpointCount: 0,
    });
  }
  // A repo with no manifest still has source worth scanning: `test-apis/python`
  // carries no requirements.txt because its fixtures load the SDK by relative
  // path, and plenty of real services keep dependencies somewhere this walk
  // cannot see. Without this the markers would have nowhere to land.
  if (byDir.size === 0) {
    byDir.set(rootDir, {
      absDir: rootDir, package: '.', name: null, deps: [],
      strong: new Set(), weak: new Set(), endpointCount: 0,
    });
  }

  const packages = [...byDir.values()];
  // Deepest first, so the nearest-ancestor lookup wins in a monorepo.
  const byDepth = [...packages].sort((a, b) => b.absDir.length - a.absDir.length);
  const ownerOf = (file) =>
    byDepth.find((p) => file === p.absDir || file.startsWith(p.absDir + path.sep)) || null;

  const endpoints = [];
  const filesWithEndpoints = new Set();

  for (const file of sourceFiles) {
    let content;
    try {
      if (fs.statSync(file).size > maxFileSize) continue;
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
      for (const [re, label] of strongMarkers) {
        if (!owner.strong.has(label) && re.test(content)) owner.strong.add(label);
      }
      for (const [re, label] of weakMarkers) {
        if (!owner.weak.has(label) && re.test(content)) owner.weak.add(label);
      }
    }
  }

  const frameworkSignals = packages
    .map((p) => ({
      package: p.package,
      name: p.name,
      frameworkDeps: p.deps.filter(isFrameworkDep).sort(),
      oasGenDeps: p.deps.filter(isOasGenDep).sort(),
      // Strong markers first, then weak.
      sourceMarkers: [...p.strong, ...p.weak],
      endpointCount: p.endpointCount,
    }))
    .filter((p) => p.frameworkDeps.length > 0 || p.sourceMarkers.length > 0)
    .sort((a, b) => a.package.localeCompare(b.package));

  return {
    endpoints,
    filesWithEndpoints: [...filesWithEndpoints],
    scannedFileCount: sourceFiles.length,
    frameworkSignals,
  };
}
