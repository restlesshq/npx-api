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

describe('pollForLandedLog', () => {
  const okResponse = (logs) => ({ ok: true, json: async () => ({ logs }) });

  it('returns true as soon as a log lands', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ id: 'log-1' }]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ projectId: 'p', setupKey: 's', since: 'now' });
  });

  it('keeps polling past empty responses, then reports the landing', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValueOnce(okResponse([{ id: 'log-1' }]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 10000, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns false when nothing lands before the deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 0, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(false);
  });

  it('treats network errors as not-landed-yet rather than throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 0, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(false);
  });
});

describe('findCredsByApiKey / key recovery', () => {
  it('finds the creds this machine saved for a key', () => {
    mod.saveProjectCreds({ projectId: 'p-1', setupKey: 's-1', apiKey: 'rstlss_a' });
    expect(mod.findCredsByApiKey('rstlss_a')).toMatchObject({ projectId: 'p-1', setupKey: 's-1' });
    expect(mod.findCredsByApiKey('rstlss_other')).toBe(null);
    expect(mod.findCredsByApiKey(null)).toBe(null);
  });

  it('prefers the OLDEST registration when one key maps to several projects', () => {
    // The duplicate mapping is exactly the orphan bug: ingress routes the
    // key's uploads to the first project registered for it.
    const dir = path.join(home, '.restless', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p-old.json'), JSON.stringify({
      projectId: 'p-old', setupKey: 's-old', apiKey: 'rstlss_dup', savedAt: '2026-07-25T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(dir, 'p-new.json'), JSON.stringify({
      projectId: 'p-new', setupKey: 's-new', apiKey: 'rstlss_dup', savedAt: '2026-07-26T00:00:00.000Z',
    }));
    expect(mod.findCredsByApiKey('rstlss_dup')).toMatchObject({ projectId: 'p-old' });
  });

  it('ensureProject adopts local creds when settings has no projectId', async () => {
    // The Greg scenario: key on disk from an earlier run, fresh settings.
    mod.saveProjectCreds({ projectId: 'p-orig', setupKey: 's-orig', apiKey: 'rstlss_k' });
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'One', rootDir: '.' }] });

    const fetchImpl = vi.fn(); // must never be called - recovery is local
    const res = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', fetchImpl });
    expect(res).toMatchObject({ projectId: 'p-orig', setupKey: 's-orig', reused: true, recovered: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis[0].projectId).toBe('p-orig');
  });

  it('ensureProject returns null for an unknown key when registerUnknown is false', async () => {
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'One', rootDir: '.' }] });
    const fetchImpl = vi.fn();
    const res = await mod.ensureProject({
      rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_mystery', registerUnknown: false, fetchImpl,
    });
    expect(res).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
