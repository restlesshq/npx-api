import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { parseRemote, describeRepo, changedSince, hasUncommittedChanges } from '../lib/context-repo.js';

describe('parseRemote', () => {
  it.each([
    ['git@github.com:restlesshq/app.git', { host: 'github.com', owner: 'restlesshq', repo: 'app' }],
    ['git@github.com:restlesshq/app', { host: 'github.com', owner: 'restlesshq', repo: 'app' }],
    ['https://github.com/restlesshq/app.git', { host: 'github.com', owner: 'restlesshq', repo: 'app' }],
    ['ssh://git@github.com/restlesshq/app.git', { host: 'github.com', owner: 'restlesshq', repo: 'app' }],
    // GitLab-style nested groups: everything before the last segment is owner,
    // so two repos in different subgroups don't collide.
    [
      'https://gitlab.com/acme/platform/api.git',
      { host: 'gitlab.com', owner: 'acme/platform', repo: 'api' },
    ],
  ])('parses %s', (url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });

  it.each([[''], [null], [undefined], ['not a url'], ['https://github.com/onlyowner']])(
    'returns null for %s',
    (url) => {
      expect(parseRemote(url)).toBeNull();
    },
  );
});

describe('in a real git repo', () => {
  let dir;
  let firstSha;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-context-'));
    const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'ignore' });
    run('git init -q');
    run('git config user.email test@example.com');
    run('git config user.name Test');
    run('git remote add origin git@github.com:acme/widgets.git');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    run('git add -A');
    run('git commit -qm first');
    firstSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    run('git add -A');
    run('git commit -qm second');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('describes the repo from its remote', () => {
    const info = describeRepo(dir);
    expect(info.isGit).toBe(true);
    expect(info.host).toBe('github.com');
    expect(info.owner).toBe('acme');
    expect(info.repo).toBe('widgets');
    expect(info.label).toBe('acme/widgets');
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
    // A repo with a remote needs no local fallback identity.
    expect(info.localId).toBe('');
    expect(info.rootPath).toBe('');
  });

  it('records the subdirectory being indexed', () => {
    const sub = path.join(dir, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    expect(describeRepo(sub).rootPath).toBe('packages/api');
  });

  it('lists what changed since a commit', () => {
    const diff = changedSince(dir, firstSha);
    expect(diff.ok).toBe(true);
    expect(diff.files).toEqual(['b.txt']);
  });

  it('reports no baseline rather than guessing', () => {
    expect(changedSince(dir, '')).toEqual({ ok: false, reason: 'no-baseline' });
  });

  it('refuses to diff against a commit this checkout does not have', () => {
    // The rebase / squash / shallow-clone case. Answering "nothing changed"
    // here would silently skip everything the run was supposed to read.
    const result = changedSince(dir, '0'.repeat(40));
    expect(result).toEqual({ ok: false, reason: 'unknown-commit' });
  });

  it('notices uncommitted work', () => {
    expect(hasUncommittedChanges(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'three\n');
    expect(hasUncommittedChanges(dir)).toBe(true);
  });
});

describe('outside a git repo', () => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-nogit-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still yields a stable identity, hashed rather than a raw path', () => {
    const info = describeRepo(dir);
    expect(info.isGit).toBe(false);
    expect(info.localId).toMatch(/^[0-9a-f]{32}$/);
    // The server has no business knowing where on disk the code lives.
    expect(info.localId).not.toContain(dir);
    // Stable across calls, so re-running finds the same source row.
    expect(describeRepo(dir).localId).toBe(info.localId);
  });
});
