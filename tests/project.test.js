import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { findGitRoot, resolveProjectDirs, relativePackagePath, isGitIgnored } from '../lib/project.js';

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

  // One repo, one `.restless/`. Running from a workspace package used to put
  // it next to that package's package.json, so the same repo ended up with a
  // different settings file depending on where you invoked the CLI.
  it('puts rootDir at the git root even when cwd is a package with its own package.json', () => {
    const monorepo = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    execSync('git init', { cwd: monorepo, stdio: 'pipe' });
    const sub = path.join(monorepo, 'packages', 'sub');
    execSync(`mkdir -p "${sub}"`);
    fs.writeFileSync(path.join(sub, 'package.json'), '{}');

    const { packageDir, rootDir } = resolveProjectDirs(sub);
    expect(packageDir).toBe(sub);
    expect(rootDir).toBe(monorepo);

    execSync(`rm -rf "${monorepo}"`);
  });

  it('resolves to the same rootDir from anywhere in the repo', () => {
    const monorepo = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    execSync('git init', { cwd: monorepo, stdio: 'pipe' });
    const pkg = path.join(monorepo, 'packages', 'app');
    const leaf = path.join(pkg, 'src', 'routes');
    execSync(`mkdir -p "${leaf}"`);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(monorepo, 'package.json'), '{}');

    for (const from of [monorepo, pkg, leaf]) {
      expect(resolveProjectDirs(from).rootDir).toBe(monorepo);
    }

    execSync(`rm -rf "${monorepo}"`);
  });

  it('falls back to git root when no package.json exists between cwd and git root', () => {
    const repo = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    const sub = path.join(repo, 'src');
    execSync(`mkdir -p "${sub}"`);
    // No package.json anywhere.

    const { rootDir } = resolveProjectDirs(sub);
    expect(rootDir).toBe(repo);

    execSync(`rm -rf "${repo}"`);
  });

  it('never escapes the git root', () => {
    // If the user runs from inside a git repo and there's a package.json
    // ABOVE the git root, we must NOT pick it - that'd write `.restless/`
    // outside the repo.
    const outer = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    fs.writeFileSync(path.join(outer, 'package.json'), '{}'); // package.json above git root
    const repo = path.join(outer, 'inner-repo');
    execSync(`mkdir -p "${repo}"`);
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    // No package.json inside the repo.

    const { rootDir } = resolveProjectDirs(repo);
    expect(rootDir).toBe(repo); // capped at git root, never the outer dir

    execSync(`rm -rf "${outer}"`);
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

describe('isGitIgnored', () => {
  it('distinguishes ignored from unignored files in a repo', () => {
    const tmpDir = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    // Neutralize any global excludes file - a developer machine that
    // globally ignores `.env*` would otherwise flip the .env.local case.
    execSync('git config core.excludesFile /dev/null', { cwd: tmpDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'RESTLESS_KEY=x\n');
    fs.writeFileSync(path.join(tmpDir, '.env.local'), 'RESTLESS_KEY=x\n');

    expect(isGitIgnored(path.join(tmpDir, '.env'), tmpDir)).toBe(true);
    expect(isGitIgnored(path.join(tmpDir, '.env.local'), tmpDir)).toBe(false);

    execSync(`rm -rf "${tmpDir}"`);
  });

  it('returns null outside a git repo', () => {
    const tmpDir = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
    fs.writeFileSync(path.join(tmpDir, '.env'), 'x\n');
    expect(isGitIgnored(path.join(tmpDir, '.env'), tmpDir)).toBe(null);
    execSync(`rm -rf "${tmpDir}"`);
  });
});
