import { execSync } from 'child_process';
import fs from 'fs';
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
 * Resolve the three key directories:
 * - packageDir: where the user ran the command (scopes AI analysis).
 * - rootDir:    where `.restless/` should live - the closest ancestor with a
 *               `package.json`, capped at the git root so we never escape
 *               the repo. Falls back to the git root if no `package.json`
 *               is found between cwd and git root.
 * - gitRoot:    the absolute git root. Hard ceiling for every fs write
 *               and every AI tool call - the CLI never crosses it.
 */
export function resolveProjectDirs(cwd) {
  const packageDir = cwd;
  const gitRoot = path.resolve(findGitRoot(cwd));

  let dir = path.resolve(cwd);
  let rootDir = gitRoot;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      rootDir = dir;
      break;
    }
    if (dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { packageDir, rootDir, gitRoot };
}

/**
 * Get the relative path from the git root to the package dir.
 * Returns '.' if they're the same.
 */
export function relativePackagePath(rootDir, packageDir) {
  const rel = path.relative(rootDir, packageDir);
  return rel || '.';
}
