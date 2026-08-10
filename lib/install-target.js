import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getSdkWriter } from './sdk-writers/index.js';
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
 * Walk up from `packageDir` looking for the hoisted SDK package.
 *
 * Workspaces matter: `npm install <pkg>` inside `packages/<workspace>/`
 * typically hoists to the repo root's `node_modules/`, not the workspace's
 * own. Checking only `packageDir/node_modules` produced a false "install
 * failed" for every monorepo user. Also defends against broken symlinks (a
 * leftover `npm link`) by requiring the package.json to be readable.
 */
function resolveInstalledNodeSdk(packageDir) {
  const names = [['@restlessai', 'sdk'], ['restlessai']];
  let dir = path.resolve(packageDir);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of names) {
      const pkgJson = path.join(dir, 'node_modules', ...name, 'package.json');
      try {
        fs.accessSync(pkgJson, fs.constants.R_OK);
        return pkgJson;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Python interpreters to try, best first.
 *
 * A project-local virtualenv wins over whatever `python3` resolves to on
 * PATH, because that is the interpreter the user's server will actually run
 * under - checking the system one would report "not installed" for a
 * correctly installed venv, or worse, "installed" when the venv lacks it.
 * `VIRTUAL_ENV` covers an already-activated shell.
 */
function pythonCandidates(dir) {
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  const out = [];
  for (const venv of ['.venv', 'venv', 'env']) {
    out.push(path.join(dir, venv, bin, exe));
  }
  if (process.env.VIRTUAL_ENV) out.push(path.join(process.env.VIRTUAL_ENV, bin, exe));
  out.push('python3', 'python');
  return out;
}

/**
 * Ask a Python interpreter whether it can import the SDK, and where from.
 *
 * Asking the interpreter rather than looking for a directory is what makes
 * this work for every install shape at once: a registry install, `pip install
 * -e ../python-sdk`, a `.pth` file, a vendored copy on PYTHONPATH, poetry,
 * uv, pipenv. That matters twice over - it is how we develop against the
 * unpublished SDK today, and it is how plenty of real users work in
 * monorepos - so it is not scaffolding that gets thrown away at publish.
 */
function resolveInstalledPythonSdk(packageDir) {
  for (const python of pythonCandidates(packageDir)) {
    if (python.includes(path.sep) && !fs.existsSync(python)) continue;
    try {
      const out = execFileSync(
        python,
        ['-c', 'import restless, sys; sys.stdout.write(restless.__file__ or "")'],
        { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 },
      ).trim();
      if (out) {
        debug.log('install-target.python-sdk', { python, module: out });
        return out;
      }
    } catch {
      // Wrong interpreter, no venv, or the import failed. Try the next.
    }
  }
  return null;
}

/**
 * Is the gem available to THIS project?
 *
 * `bundle list` first, because a Ruby app runs under Bundler and the answer
 * that matters is what the project's Gemfile resolves - a globally installed
 * gem that Bundler does not load is not usable, and a `path:` or `git:` gem
 * that is not globally installed is. That mirrors why the Python check asks
 * an interpreter rather than looking for a directory: it makes the registry,
 * path and git cases answer the same question the same way, which is how we
 * develop against the unpublished SDK.
 *
 * Falls back to `gem list` for a script with no Gemfile.
 */
function resolveInstalledRubySdk(packageDir) {
  const gem = 'restless-sdk';
  const attempts = [
    ['bundle', ['list', gem]],
    ['bundle', ['show', gem]],
    ['gem', ['list', '-i', gem]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, {
        cwd: packageDir, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
      }).trim();
      // `gem list -i` prints "false" and exits 1 when absent; belt and braces.
      if (out && !/^false$/i.test(out)) {
        debug.log('install-target.ruby-sdk', { cmd, out: out.split('\n')[0] });
        return out.split('\n')[0];
      }
    } catch {
      // Not installed, no bundler, or no Gemfile here. Try the next.
    }
  }
  return null;
}

/**
 * Path proving the SDK is importable from `packageDir`, or null.
 * The path itself is only for diagnostics; callers want the boolean.
 */
export function resolveInstalledSdk(packageDir, language) {
  const { language: canonical } = getSdkWriter(language).descriptor;
  if (canonical === 'python') return resolveInstalledPythonSdk(packageDir);
  if (canonical === 'ruby') return resolveInstalledRubySdk(packageDir);
  return resolveInstalledNodeSdk(packageDir);
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
 * The Node and Python paths fail for completely different reasons, and a
 * message naming `node_modules` on a Python repo sends people the wrong way.
 */
export function describeMissingSdk(packageDir, language) {
  const { language: canonical, packageSpecifier } = getSdkWriter(language).descriptor;
  if (canonical === 'python') {
    return [
      `Tried importing \`restless\` with the interpreters under ${packageDir}`,
      `(.venv, venv, $VIRTUAL_ENV, then python3) - none of them could.`,
      `If your project uses a virtualenv we didn't find, activate it and re-run.`,
    ];
  }
  if (canonical === 'ruby') {
    return [
      `Asked bundler and rubygems for \`${packageSpecifier}\` in ${packageDir} -`,
      `neither has it. If the gem is in your Gemfile, run \`bundle install\` first.`,
    ];
  }
  return [
    `Tried to find ${packageSpecifier} walking up from ${packageDir} - nothing`,
    `readable in any node_modules.`,
  ];
}
