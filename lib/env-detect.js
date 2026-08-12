/**
 * Shared machinery for "does this project populate the environment before the
 * SDK constructs?", so each writer's `detectEnvLoader` is a short list of
 * language facts rather than its own copy of the file reading and grepping.
 *
 * A LEAF module: every writer imports it, so it must not import the registry.
 * See `lib/sdk-line-spec.js` for the other half of why that matters.
 *
 * The answer shape is `{ mode, evidence }`, and `mode` is read only through
 * `envLoaderHasKey` - anything other than `'none'` means an env var reference
 * is safe in the init line.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export { envLoaderHasKey } from './sdk-line-spec.js';

/** `{ mode: 'none' }` with a reason, the answer when nothing matched. */
export function noEnvLoader(evidence = 'no env loader detected') {
  return { mode: 'none', evidence };
}

/**
 * Concatenate whichever of `files` exist under `dir`.
 *
 * One string rather than a parsed manifest because every caller only asks
 * "is this dependency named anywhere in here" - and the manifest formats
 * involved (requirements.txt, pyproject.toml, Gemfile, go.mod) would each need
 * a different parser to answer the same question.
 */
export function readManifests(dir, files) {
  let declared = '';
  for (const file of files) {
    try {
      declared += `${fs.readFileSync(path.join(dir, file), 'utf8')}\n`;
    } catch {
      // Absent or unreadable manifests are just silence, not an error.
    }
  }
  return declared;
}

/**
 * First `[dep, evidence]` pair whose dependency is declared in `declared`.
 *
 * Bounded by non-word/non-dash characters so `dotenv` does not match
 * `dotenv-rails` (and vice versa) - the two mean different things to Ruby.
 */
export function firstDeclaredDep(declared, pairs) {
  for (const [dep, evidence] of pairs) {
    if (new RegExp(`(^|[^\\w-])${dep}([^\\w-]|$)`, 'im').test(declared)) {
      return { mode: 'dotenv', evidence };
    }
  }
  return null;
}

/**
 * Grep the source tree for a loader call a manifest would not show, e.g. a
 * dependency that arrived as a framework extra.
 *
 * Excludes vendored trees by path fragment rather than by `--exclude-dir` so
 * one list covers every language's vendor directory. Returns `null` on no
 * match or any failure - a missing grep must not fail the run.
 */
export function grepForLoader(dir, { pattern, globs, ignore = [], describe }) {
  const includes = globs.map((g) => `--include="${g}"`).join(' ');
  try {
    const out = execSync(`grep -rE "${pattern}" ${includes} -l . 2>/dev/null || true`, {
      cwd: dir,
      encoding: 'utf8',
    });
    const skip = ['node_modules', ...ignore];
    const hits = out
      .trim()
      .split('\n')
      .filter((f) => f && !skip.some((s) => f.includes(s)))
      .map((f) => f.replace(/^\.\//, ''));
    if (hits.length > 0) return { mode: 'dotenv', evidence: describe(hits[0]) };
  } catch {
    // No grep, unreadable tree - treat as "found nothing".
  }
  return null;
}

/** Does `dir` contain any of `files`? Used for framework-shape evidence. */
export function anyFileExists(dir, files) {
  return files.some((rel) => {
    try {
      return fs.existsSync(path.join(dir, rel));
    } catch {
      return false;
    }
  });
}
