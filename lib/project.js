import { execSync } from 'child_process';
import path from 'path';

/**
 * Find the git root directory. Used as a hard ceiling so we never write
 * `.restless/` outside the repo the user is in. Falls back to cwd if not in a
 * git repo.
 */
export function findGitRoot(from) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: from,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root;
  } catch {
    return from;
  }
}

/**
 * Resolve the key directories:
 * - packageDir: where the user ran the command (scopes AI analysis).
 * - rootDir:    where `.restless/` lives. Always the git root.
 * - gitRoot:    the absolute git root. Hard ceiling for every fs write
 *               and every AI tool call - the CLI never crosses it.
 *
 * `rootDir` used to be the nearest ancestor holding a `package.json`, which
 * meant the same repo got a different `.restless/` depending on which
 * directory you happened to run from: repo root from the top, and
 * `packages/api/.restless/` from inside a workspace. One repo is one place -
 * the settings file lists its APIs by `rootDir`, the SDK walks up from the
 * process cwd to find it, and it's committed with the code. So it goes at
 * the git root, always.
 *
 * Which package to install into is a separate question, answered separately
 * (`resolveOwningDir` in install-target.js walks down to the API's own
 * manifest). Outside a repo, `findGitRoot` falls back to cwd.
 */
export function resolveProjectDirs(cwd) {
  const packageDir = cwd;
  const gitRoot = path.resolve(findGitRoot(cwd));
  return { packageDir, rootDir: gitRoot, gitRoot };
}

/**
 * Get the relative path from the git root to the package dir.
 * Returns '.' if they're the same.
 */
export function relativePackagePath(rootDir, packageDir) {
  const rel = path.relative(rootDir, packageDir);
  return rel || '.';
}

/**
 * Whether git ignores `file`. Exists because `api key` writes a live
 * credential into `.env`, and "is that file about to end up in a commit?"
 * is a fact the caller (human or agent) needs handed to them, not one they
 * should have to derive.
 *
 * Returns true (ignored), false (tracked-or-trackable), or null when the
 * question doesn't apply (not a git repo, git missing).
 */
export function isGitIgnored(file, cwd) {
  try {
    execSync(`git check-ignore -q -- ${JSON.stringify(file)}`, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    // check-ignore exits 1 for "not ignored"; anything else (128 = not a
    // repo, ENOENT = no git) means the question has no answer here.
    return err?.status === 1 ? false : null;
  }
}
