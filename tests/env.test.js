import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// detectAgent() caches on first call, so each case re-imports the module
// fresh with the environment it wants to assert about.
async function freshEnv(env) {
  vi.resetModules();
  const saved = { ...process.env };
  // Start from a clean slate for the vars we care about so the ambient
  // environment (e.g. running the suite from inside Claude Code) can't leak in.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  delete process.env.CI;
  delete process.env.RESTLESS_INTERACTIVE;
  delete process.env.RESTLESS_NONINTERACTIVE;
  Object.assign(process.env, env);
  const mod = await import('../lib/env.js');
  return { mod, restore: () => { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); } };
}

describe('env detection', () => {
  let restore;
  afterEach(() => { if (restore) restore(); restore = null; });

  it('detects Claude Code via CLAUDECODE=1', async () => {
    const r = await freshEnv({ CLAUDECODE: '1' }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('claude');
    expect(r.mod.isAgent()).toBe(true);
    expect(r.mod.isInteractive()).toBe(false);
  });

  it('detects Codex via CODEX_SANDBOX', async () => {
    const r = await freshEnv({ CODEX_SANDBOX: 'seatbelt' }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('codex');
    expect(r.mod.isInteractive()).toBe(false);
  });

  it('prefers Claude when both agents are signalled', async () => {
    const r = await freshEnv({ CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('claude');
  });

  it('reports no agent when nothing is set', async () => {
    const r = await freshEnv({}); restore = r.restore;
    expect(r.mod.detectAgent()).toBe(null);
    expect(r.mod.isAgent()).toBe(false);
  });

  it('treats CI as non-interactive even without an agent', async () => {
    const r = await freshEnv({ CI: 'true' }); restore = r.restore;
    expect(r.mod.isInteractive()).toBe(false);
  });

  it('RESTLESS_INTERACTIVE=1 forces interactive even under an agent', async () => {
    const r = await freshEnv({ CLAUDECODE: '1', RESTLESS_INTERACTIVE: '1' }); restore = r.restore;
    expect(r.mod.isInteractive()).toBe(true);
  });

  it('RESTLESS_NONINTERACTIVE=1 forces non-interactive with no agent', async () => {
    const r = await freshEnv({ RESTLESS_NONINTERACTIVE: '1' }); restore = r.restore;
    expect(r.mod.isInteractive()).toBe(false);
  });
});
