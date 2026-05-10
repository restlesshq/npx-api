import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  setGitRoot,
  getGitRoot,
  isInsideRoot,
  assertInsideRoot,
  safeWriteFileSync,
  safeAppendFileSync,
  safeMkdirSync,
} from '../lib/pathGuard.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pathguard-')));
}

describe('isInsideRoot', () => {
  it('treats the root itself as inside', () => {
    expect(isInsideRoot('/foo', '/foo')).toBe(true);
  });

  it('accepts descendants', () => {
    expect(isInsideRoot('/foo/bar/baz', '/foo')).toBe(true);
    expect(isInsideRoot('/foo/bar', '/foo')).toBe(true);
  });

  it('rejects siblings', () => {
    expect(isInsideRoot('/foo-other', '/foo')).toBe(false);
    expect(isInsideRoot('/baz', '/foo')).toBe(false);
  });

  it('rejects ancestors', () => {
    expect(isInsideRoot('/foo', '/foo/bar')).toBe(false);
    expect(isInsideRoot('/', '/foo')).toBe(false);
  });

  it('rejects paths that walk up via ..', () => {
    expect(isInsideRoot('/foo/../bar', '/foo')).toBe(false);
  });

  it('returns false when no root is configured and none provided', () => {
    expect(isInsideRoot('/whatever')).toBe(false);
  });
});

describe('setGitRoot / getGitRoot', () => {
  beforeEach(() => setGitRoot(null));
  afterEach(() => setGitRoot(null));

  it('round-trips a path through resolve()', () => {
    setGitRoot('/Users/x/repo/');
    expect(getGitRoot()).toBe('/Users/x/repo');
  });

  it('clears the boundary when called with falsy', () => {
    setGitRoot('/Users/x/repo');
    setGitRoot(null);
    expect(getGitRoot()).toBeNull();
  });
});

describe('assertInsideRoot', () => {
  beforeEach(() => setGitRoot(null));
  afterEach(() => setGitRoot(null));

  it('throws when no boundary is configured', () => {
    expect(() => assertInsideRoot('/anywhere')).toThrow(/git root not configured/i);
  });

  it('passes when target is inside', () => {
    setGitRoot('/Users/x/repo');
    expect(() => assertInsideRoot('/Users/x/repo/sub/file.txt')).not.toThrow();
  });

  it('throws with a clear message when target escapes', () => {
    setGitRoot('/Users/x/repo');
    expect(() => assertInsideRoot('/Users/x/other/file.txt'))
      .toThrow(/outside the git root/i);
  });

  it('error has code EOUTSIDEROOT for escape attempts', () => {
    setGitRoot('/Users/x/repo');
    try {
      assertInsideRoot('/Users/x/other/file.txt');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('EOUTSIDEROOT');
    }
  });
});

describe('safe* fs wrappers', () => {
  let root;
  beforeEach(() => {
    root = tmp();
    setGitRoot(root);
  });
  afterEach(() => {
    setGitRoot(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('safeWriteFileSync writes inside the root', () => {
    const p = path.join(root, 'hello.txt');
    safeWriteFileSync(p, 'hi');
    expect(fs.readFileSync(p, 'utf8')).toBe('hi');
  });

  it('safeWriteFileSync refuses paths outside the root', () => {
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-'));
    try {
      expect(() => safeWriteFileSync(path.join(sibling, 'oops.txt'), 'no'))
        .toThrow(/outside the git root/i);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('safeAppendFileSync refuses ancestors', () => {
    const ancestor = path.dirname(root);
    expect(() => safeAppendFileSync(path.join(ancestor, 'oops.txt'), 'no'))
      .toThrow(/outside the git root/i);
  });

  it('safeMkdirSync allows nested dirs inside the root', () => {
    const p = path.join(root, 'a', 'b', 'c');
    safeMkdirSync(p, { recursive: true });
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });

  it('safeMkdirSync refuses an outside dir', () => {
    expect(() => safeMkdirSync(path.join(path.dirname(root), 'leak'), { recursive: true }))
      .toThrow(/outside the git root/i);
  });
});
