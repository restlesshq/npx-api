import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { existingRestlessKey, findExistingEnvFile, resolveApiDir } from '../steps/prepare-account.js';

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

  it('does not look in parent directories', () => {
    // .env exists in the parent, but the apiDir is a child without one.
    const parentEnv = path.join(dir, '.env');
    fs.writeFileSync(parentEnv, 'RESTLESS_KEY=should-not-be-found\n');
    const child = path.join(dir, 'child');
    fs.mkdirSync(child);
    expect(findExistingEnvFile(child)).toBeNull();
  });
});

describe('resolveApiDir', () => {
  let root;
  beforeEach(() => { root = fs.realpathSync(tmp()); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('returns packageDir when apiRootDir is missing', () => {
    expect(resolveApiDir(root, undefined)).toBe(root);
    expect(resolveApiDir(root, '')).toBe(root);
  });

  it('returns packageDir when apiRootDir is "."', () => {
    expect(resolveApiDir(root, '.')).toBe(root);
  });

  it('returns the apiRootDir when it has its own package.json', () => {
    const sub = path.join(root, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'package.json'), '{}');
    expect(resolveApiDir(root, 'packages/api')).toBe(sub);
  });

  it('walks up to the nearest ancestor with a package.json', () => {
    const mid = path.join(root, 'packages', 'api');
    const leaf = path.join(mid, 'src', 'routes');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(mid, 'package.json'), '{}');
    expect(resolveApiDir(root, 'packages/api/src/routes')).toBe(mid);
  });

  it('falls back to packageDir when no ancestor has package.json', () => {
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveApiDir(root, 'src')).toBe(root);
  });
});
