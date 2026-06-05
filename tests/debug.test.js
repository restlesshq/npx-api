import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// debug.js holds a module-level singleton (the CLI is one-shot), so each
// test re-imports a fresh copy via resetModules to start from clean state.
async function freshDebug() {
  vi.resetModules();
  return import('../lib/debug.js');
}

let tmpDir;
let fetchSpy;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-debug-'));
  process.env.RESTLESS_DEBUG_DIR = tmpDir;
  // Default: a successful upload. Individual tests assert call count.
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  global.fetch = fetchSpy;
  // The uploader/finalize write status lines to stderr - silence them.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.RESTLESS_DEBUG_DIR;
  vi.restoreAllMocks();
});

function jsonFiles() {
  return fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
}

describe('finalize (always-write, conditional upload)', () => {
  it('writes a local copy on a normal run and does NOT upload', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('hello', { foo: 'bar' });
    await debug.finalize({ exitCode: 0 });

    const files = jsonFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/-init\.json$/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
    expect(body.entries.some((e) => e.type === 'hello' && e.foo === 'bar')).toBe(true);
    expect(body.meta.exitCode).toBe(0);
    expect(body.meta.finishedAt).toBeTruthy();
  });

  it('records events even without --debug (log is no longer gated)', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('one');
    debug.log('two');
    await debug.finalize({ exitCode: 0 });

    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles()[0]), 'utf8'));
    const types = body.entries.map((e) => e.type);
    expect(types).toContain('one');
    expect(types).toContain('two');
  });

  it('writes AND uploads when --debug is set', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init', '--debug'] });
    debug.log('hello');
    await debug.finalize({ exitCode: 0 });

    expect(jsonFiles().length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/debug$/);
    expect(opts.method).toBe('POST');
  });

  it('is idempotent - a second finalize neither rewrites nor re-uploads', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init', '--debug'] });
    await debug.finalize({ exitCode: 0 });
    await debug.finalize({ exitCode: 0 });

    expect(jsonFiles().length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('findLatestLocalLog', () => {
  it('returns null when no logs exist', async () => {
    const debug = await freshDebug();
    expect(debug.findLatestLocalLog()).toBe(null);
  });

  it('returns the newest log, skipping submit-debug logs', async () => {
    const debug = await freshDebug();
    const stub = '{"meta":{},"entries":[]}';
    fs.writeFileSync(path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json'), stub);
    fs.writeFileSync(path.join(tmpDir, '2026-01-02T00-00-00-000Z-update.json'), stub);
    // Newest by timestamp, but it's a submit-debug run and must be ignored.
    fs.writeFileSync(path.join(tmpDir, '2026-01-03T00-00-00-000Z-submit-debug.json'), stub);

    const latest = debug.findLatestLocalLog();
    expect(path.basename(latest)).toBe('2026-01-02T00-00-00-000Z-update.json');
  });
});

describe('submitLocalLog', () => {
  it('reads the file and POSTs its contents verbatim', async () => {
    const debug = await freshDebug();
    const file = path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json');
    const contents = '{"meta":{"cli":"api"},"entries":[{"type":"x"}]}';
    fs.writeFileSync(file, contents);

    const res = await debug.submitLocalLog(file);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].body).toBe(contents);
  });

  it('returns not-ok and does not POST when the file is missing', async () => {
    const debug = await freshDebug();
    const res = await debug.submitLocalLog(path.join(tmpDir, 'nope.json'));
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a server failure as not-ok', async () => {
    const debug = await freshDebug();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const file = path.join(tmpDir, 'log.json');
    fs.writeFileSync(file, '{"meta":{},"entries":[]}');

    const res = await debug.submitLocalLog(file);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});
