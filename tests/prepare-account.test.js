import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { existingRestlessKey, findExistingEnvFile } from '../steps/prepare-account.js';
import { resolveOwningDir } from '../lib/install-target.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-account-')));
}

describe('existingRestlessKey', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when the file does not exist', () => {
    expect(existingRestlessKey(path.join(dir, '.env'))).toBeNull();
  });

  it('returns null when the file has no RESTLESS_KEY', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'OTHER=foo\nFOO_BAR=baz\n');
    expect(existingRestlessKey(p)).toBeNull();
  });

  it('reads a bare value', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'RESTLESS_KEY=rdme_abc123\n');
    expect(existingRestlessKey(p)).toBe('rdme_abc123');
  });

  it('strips surrounding double quotes', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'RESTLESS_KEY="rdme_abc123"\n');
    expect(existingRestlessKey(p)).toBe('rdme_abc123');
  });

  it('strips surrounding single quotes', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, "RESTLESS_KEY='rdme_abc123'\n");
    expect(existingRestlessKey(p)).toBe('rdme_abc123');
  });

  it('handles `export` prefix', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'export RESTLESS_KEY=rdme_abc123\n');
    expect(existingRestlessKey(p)).toBe('rdme_abc123');
  });

  it('finds the key when surrounded by other lines', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, '# comment\nFOO=1\nRESTLESS_KEY=rdme_xyz\nBAR=2\n');
    expect(existingRestlessKey(p)).toBe('rdme_xyz');
  });

  it('returns null when the value is empty', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'RESTLESS_KEY=\n');
    expect(existingRestlessKey(p)).toBeNull();
  });
});

describe('findExistingEnvFile', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when neither .env nor .env.local is present', () => {
    expect(findExistingEnvFile(dir)).toBeNull();
  });

  it('finds an existing .env regular file', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, '');
    expect(findExistingEnvFile(dir)).toBe(p);
  });

  it('finds .env.local when there is no .env', () => {
    const p = path.join(dir, '.env.local');
    fs.writeFileSync(p, '');
    expect(findExistingEnvFile(dir)).toBe(p);
  });

  it('prefers .env over .env.local when both exist', () => {
    const env = path.join(dir, '.env');
    const local = path.join(dir, '.env.local');
    fs.writeFileSync(env, '');
    fs.writeFileSync(local, '');
    expect(findExistingEnvFile(dir)).toBe(env);
  });

  it('returns null when .env is a directory, not a file', () => {
    fs.mkdirSync(path.join(dir, '.env'));
    expect(findExistingEnvFile(dir)).toBeNull();
  });

  it('does not look in parent directories with the default (single-dir) behavior', () => {
    // .env exists in the parent, but with no rootDir we only check the child.
    const parentEnv = path.join(dir, '.env');
    fs.writeFileSync(parentEnv, 'RESTLESS_KEY=should-not-be-found\n');
    const child = path.join(dir, 'child');
    fs.mkdirSync(child);
    expect(findExistingEnvFile(child)).toBeNull();
  });

  it('walks up to rootDir and finds a root .env when the api dir has none (monorepo)', () => {
    // dir = repo root with a .env; api code lives in packages/api with none.
    const rootEnv = path.join(dir, '.env');
    fs.writeFileSync(rootEnv, 'RESTLESS_KEY=from-root\n');
    const apiDir = path.join(dir, 'packages', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    expect(findExistingEnvFile(apiDir, dir)).toBe(rootEnv);
  });

  it('returns the .env closest to the api dir when both api dir and root have one', () => {
    // Mirrors the SDK runtime walk: the closer .env wins, so we write to it.
    fs.writeFileSync(path.join(dir, '.env'), 'RESTLESS_KEY=from-root\n');
    const apiDir = path.join(dir, 'packages', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    const apiEnv = path.join(apiDir, '.env');
    fs.writeFileSync(apiEnv, 'OTHER=1\n');
    expect(findExistingEnvFile(apiDir, dir)).toBe(apiEnv);
  });

  it('finds an intermediate .env between the api dir and the root', () => {
    const apiDir = path.join(dir, 'packages', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    const midEnv = path.join(dir, 'packages', '.env');
    fs.writeFileSync(midEnv, 'OTHER=1\n');
    expect(findExistingEnvFile(apiDir, dir)).toBe(midEnv);
  });

  it('never looks above rootDir', () => {
    // .env above the declared rootDir must stay invisible.
    fs.writeFileSync(path.join(dir, '.env'), 'RESTLESS_KEY=above-root\n');
    const root = path.join(dir, 'repo');
    const apiDir = path.join(root, 'packages', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    expect(findExistingEnvFile(apiDir, root)).toBeNull();
  });
});

// `.env` has to land in the same directory the dependency does, so this is
// the same resolver install-sdk uses - it was a second wrapper until the two
// were collapsed. These cases pin the JavaScript (package.json) manifest.
describe('resolveOwningDir, for the .env location', () => {
  let root;
  beforeEach(() => { root = fs.realpathSync(tmp()); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('returns packageDir when apiRootDir is missing', () => {
    expect(resolveOwningDir(root, undefined, 'javascript')).toBe(root);
    expect(resolveOwningDir(root, '', 'javascript')).toBe(root);
  });

  it('returns packageDir when apiRootDir is "."', () => {
    expect(resolveOwningDir(root, '.', 'javascript')).toBe(root);
  });

  it('returns the apiRootDir when it has its own package.json', () => {
    const sub = path.join(root, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'package.json'), '{}');
    expect(resolveOwningDir(root, 'packages/api', 'javascript')).toBe(sub);
  });

  it('walks up to the nearest ancestor with a package.json', () => {
    const mid = path.join(root, 'packages', 'api');
    const leaf = path.join(mid, 'src', 'routes');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(mid, 'package.json'), '{}');
    expect(resolveOwningDir(root, 'packages/api/src/routes', 'javascript')).toBe(mid);
  });

  it('falls back to packageDir when no ancestor has package.json', () => {
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveOwningDir(root, 'src', 'javascript')).toBe(root);
  });
});

describe('replaceRestlessKey', () => {
  it('swaps only the RESTLESS_KEY line, preserving the rest', async () => {
    const { replaceRestlessKey } = await import('../steps/prepare-account.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-key-'));
    const { setGitRoot } = await import('../lib/pathGuard.js');
    setGitRoot(dir);
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'PORT=3001\nRESTLESS_KEY=rstlss_old\nOTHER=1\n');

    expect(replaceRestlessKey(envPath, 'rstlss_new')).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('PORT=3001\nRESTLESS_KEY=rstlss_new\nOTHER=1\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no RESTLESS_KEY line exists', async () => {
    const { replaceRestlessKey } = await import('../steps/prepare-account.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-key-'));
    const { setGitRoot } = await import('../lib/pathGuard.js');
    setGitRoot(dir);
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'PORT=3001\n');
    expect(replaceRestlessKey(envPath, 'rstlss_new')).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('PORT=3001\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
