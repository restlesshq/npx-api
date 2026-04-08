import { execSync } from 'child_process';
import path from 'path';

/**
 * Find the git root directory (where .api/ should live).
 * Falls back to cwd if not in a git repo.
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
 * Resolve the two key directories:
 * - packageDir: where the user ran the command (scopes AI analysis)
 * - rootDir: git root (where .api/ lives)
 */
export function resolveProjectDirs(cwd) {
  const packageDir = cwd;
  const rootDir = findGitRoot(cwd);
  return { packageDir, rootDir };
}

/**
 * Get the relative path from the git root to the package dir.
 * Returns '.' if they're the same.
 */
export function relativePackagePath(rootDir, packageDir) {
  const rel = path.relative(rootDir, packageDir);
  return rel || '.';
}
