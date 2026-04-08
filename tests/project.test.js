import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { findGitRoot, resolveProjectDirs, relativePackagePath } from '../lib/project.js';

describe('findGitRoot', () => {
  it('finds the git root when inside a git repo', () => {
    // Create a temp git repo to test with
    const tmpDir = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    const subDir = path.join(tmpDir, 'packages', 'api');
    execSync(`mkdir -p "${subDir}"`);

    const root = findGitRoot(subDir);
    expect(root).toBe(tmpDir);

    execSync(`rm -rf "${tmpDir}"`);
  });

  it('returns cwd if not in a git repo', () => {
    const root = findGitRoot('/tmp');
    expect(root).toBe('/tmp');
  });
});

describe('resolveProjectDirs', () => {
  it('returns packageDir as the given cwd', () => {
    const { packageDir } = resolveProjectDirs('/some/path');
    expect(packageDir).toBe('/some/path');
  });

  it('returns rootDir as the git root', () => {
    const { rootDir } = resolveProjectDirs(process.cwd());
    // rootDir should be an ancestor of cwd
    expect(process.cwd().startsWith(rootDir)).toBe(true);
  });

  it('packageDir and rootDir differ when run from a subdirectory', () => {
    const cwd = process.cwd(); // api/
    const { packageDir, rootDir } = resolveProjectDirs(cwd);
    // If we're in a subdirectory of the git root, they should differ
    if (cwd !== rootDir) {
      expect(packageDir).not.toBe(rootDir);
    }
  });
});

describe('relativePackagePath', () => {
  it('returns . when rootDir and packageDir are the same', () => {
    expect(relativePackagePath('/foo', '/foo')).toBe('.');
  });

  it('returns relative path from root to package', () => {
    expect(relativePackagePath('/foo', '/foo/packages/api')).toBe('packages/api');
  });
});
