import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setGitRoot } from '../lib/pathGuard.js';
import { saveSettings } from '../lib/settings.js';
import * as mod from '../lib/project-init.js';

let tmp;
let home;
let realHome;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-proj-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-home-'));
  // Credentials land under the user's home dir, and `credsPath` resolves
  // `os.homedir()` (which honors $HOME on POSIX) per call - so pointing HOME
  // at a temp dir keeps the suite away from the real ~/.restless.
  realHome = process.env.HOME;
  process.env.HOME = home;
  setGitRoot(tmp);
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function settingsWith(api) {
  saveSettings(tmp, { version: 1, apis: [api] });
}

/** A fetch that hands back a new project id every call, like the real one. */
function mintingFetch() {
  let n = 0;
  return vi.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ project_id: `project-${++n}`, setup_key: `setup-${n}` }),
  }));
}

describe('registerProject', () => {
  it('sends only the hash, never the key', async () => {
    const fetchImpl = mintingFetch();
    await mod.registerProject({ writeKeyHash: 'abc123', fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({ write_key_hash: 'abc123' });
  });

  it('retries once on a 5xx (the metrics service cold-starts)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ project_id: 'p', setup_key: 's' }) });
    const res = await mod.registerProject({ writeKeyHash: 'h', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ projectId: 'p', setupKey: 's' });
  });

  it('throws with the server body on a non-retryable failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'nope' }));
    await expect(mod.registerProject({ writeKeyHash: 'h', fetchImpl })).rejects.toThrow(/HTTP 400.*nope/s);
  });
});

describe('project credentials', () => {
  it('round-trips the setup key so a later process can still claim the project', () => {
    mod.saveProjectCreds({ projectId: 'p1', setupKey: 's1', apiKey: 'rstlss_k' });
    expect(mod.loadProjectCreds('p1')).toMatchObject({ projectId: 'p1', setupKey: 's1', apiKey: 'rstlss_k' });
  });

  it('keeps credentials out of the repo and readable only by the user', () => {
    const file = mod.saveProjectCreds({ projectId: 'p1', setupKey: 's1', apiKey: 'k' });
    expect(file.startsWith(tmp)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns null for a project we have never seen', () => {
    expect(mod.loadProjectCreds('nope')).toBeNull();
  });
});

describe('ensureProject', () => {
  // The regression this exists for: /api/projects/init is not idempotent, so
  // re-registering an unchanged key mints a second project and orphans the
  // first - the server keeps logging to the old one while the CLI verifies
  // the new, empty one and blames the user's key.
  it('reuses the existing project when the key has not changed', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.' });

    const first = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_same', fetchImpl });
    expect(first).toMatchObject({ projectId: 'project-1', reused: false });

    for (const _ of [1, 2, 3]) {
      const again = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_same', fetchImpl });
      expect(again).toMatchObject({ projectId: 'project-1', setupKey: 'setup-1', reused: true });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mints a new project when the key changes', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.' });
    await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_one', fetchImpl });
    const second = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_two', fetchImpl });
    expect(second).toMatchObject({ projectId: 'project-2', reused: false });
  });

  it('mints when settings names a project we hold no setup key for', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.', projectId: 'from-a-different-machine' });
    const res = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', fetchImpl });
    expect(res).toMatchObject({ projectId: 'project-1', reused: false });
  });

  it('records the project id on the API entry that owns it', async () => {
    const fetchImpl = mintingFetch();
    saveSettings(tmp, { version: 1, apis: [
      { id: 'a', name: 'One', rootDir: 'svc-a' },
      { id: 'b', name: 'Two', rootDir: 'svc-b' },
    ]});
    await mod.ensureProject({ rootDir: tmp, apiRootDir: 'svc-b', apiKey: 'rstlss_k', fetchImpl });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis.find((a) => a.rootDir === 'svc-b').projectId).toBe('project-1');
    expect(saved.apis.find((a) => a.rootDir === 'svc-a').projectId).toBeUndefined();
  });
});
