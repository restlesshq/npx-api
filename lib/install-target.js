import fs from 'fs';
import path from 'path';
import { getSdkWriter } from './sdk-writers/index.js';
import { createProbeBudget } from './sdk-probe.js';
import * as debug from './debug.js';

/**
 * Where the SDK gets installed, and whether it is already there.
 *
 * Both questions used to have one hardcoded JavaScript answer each, in more
 * than one place: `resolveInstallDir` in install-sdk.js and `resolveApiDir` in
 * prepare-account.js were the same `package.json` walk copy-pasted, and
 * `resolveInstalledSdk` walked `node_modules`. On a Python repo the first
 * silently returned the repo root (so `.env` and the dependency landed in the
 * wrong place) and the second was permanently false, which surfaced as
 * "@restlessai/sdk isn't reachable from any node_modules" - a message with
 * nothing to do with the actual problem.
 *
 * Both of those call sites now come straight here. There is deliberately no
 * `resolveInstallDir` / `resolveApiDir` pair wrapping this: the dependency and
 * the `.env` that feeds it have to land in the same directory, and two
 * separately-named entry points are what let them drift in the first place.
 *
 * Nothing in this file branches on a language. Every per-language answer - how
 * to prove the SDK is importable, what to say when it isn't, which manifests
 * mark a project root - comes off the writer, so adding a language means adding
 * a writer and nothing else. It used to be two four-branch if-chains keyed on
 * `descriptor.language`, which is the registry's job done a second time by
 * hand, in a file the registry does not check.
 */

/**
 * The directory that owns the API: the nearest ancestor of `apiRootDir`
 * holding one of the language's manifests, bounded by `packageDir`.
 *
 * In a monorepo the API might live under `services/api/` with its own
 * `pyproject.toml`; installing at the repo root would put the dependency in
 * the wrong project. Falls back to `packageDir` when nothing matches, which
 * is the old behaviour and is right for a single-project repo with no
 * manifest at all.
 */
export function resolveOwningDir(packageDir, apiRootDir, language) {
  if (!apiRootDir || apiRootDir === '.') return packageDir;
  const { manifests } = getSdkWriter(language).descriptor;
  let dir = path.resolve(packageDir, apiRootDir);
  const stop = path.resolve(packageDir);
  while (dir.startsWith(stop)) {
    if (manifests.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageDir;
}

/**
 * Path proving the SDK is importable from `packageDir`, or null.
 * The path itself is only for diagnostics; callers want the boolean.
 *
 * The budget is created here rather than inside each writer so it bounds the
 * whole question for one language, however many probes that language needs -
 * which is what the user experiences while the spinner is up.
 */
export function resolveInstalledSdk(packageDir, language) {
  const writer = getSdkWriter(language);
  const found = writer.resolveInstalled(packageDir, { budget: createProbeBudget() });
  debug.log('install-target.resolve', {
    language: writer.descriptor.language,
    packageDir,
    found: found || null,
  });
  return found;
}

export function isSdkInstalled(packageDir, language) {
  return resolveInstalledSdk(packageDir, language) !== null;
}

/** The command that installs the SDK for this language. */
export function installCommandFor(language) {
  return getSdkWriter(language).descriptor.installCommand;
}

/**
 * Human-readable reason an install looks absent, for the failure message.
 * Every language fails for a different reason, and a message naming
 * `node_modules` on a Python repo sends people the wrong way.
 */
export function describeMissingSdk(packageDir, language) {
  return getSdkWriter(language).describeMissing(packageDir);
}
