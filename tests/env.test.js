import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// detectAgent() caches on first call, so each case re-imports the module
// fresh with the environment it wants to assert about.
//
// `tty` and `argv` are part of that environment too: `isAgent()` now treats a
// fully-piped run as agent-driven, and vitest itself runs us piped - so a case
// that doesn't say otherwise gets a terminal, or every one of them would look
// like an agent.
async function freshEnv(env, { tty = true, argv = [] } = {}) {
  vi.resetModules();
  const saved = { ...process.env };
  const savedTty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
  const savedArgv = process.argv;
  // Start from a clean slate for the vars we care about so the ambient
  // environment (e.g. running the suite from inside Claude Code) can't leak in.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  delete process.env.RESTLESS_AGENT;
  delete process.env.CI;
  delete process.env.RESTLESS_INTERACTIVE;
  delete process.env.RESTLESS_NONINTERACTIVE;
  Object.assign(process.env, env);
  process.stdout.isTTY = typeof tty === 'object' ? tty.out : tty;
  process.stdin.isTTY = typeof tty === 'object' ? tty.in : tty;
  process.argv = ['node', 'api', ...argv];
  const mod = await import('../lib/env.js');
  return {
    mod,
    restore: () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
      process.stdout.isTTY = savedTty.out;
      process.stdin.isTTY = savedTty.in;
      process.argv = savedArgv;
    },
  };
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

  it('reports an agent-invoked run as the agent source', async () => {
    const r = await freshEnv({ CLAUDECODE: '1' }); restore = r.restore;
    expect(r.mod.invocationSource()).toBe('agent');
  });

  it('reports a plain terminal run as the cli source', async () => {
    const r = await freshEnv({}); restore = r.restore;
    expect(r.mod.invocationSource()).toBe('cli');
  });

  it('still reports cli in CI - nobody invoked it from an agent', async () => {
    const r = await freshEnv({ CI: 'true' }, { tty: false }); restore = r.restore;
    expect(r.mod.isAgent()).toBe(false);
    expect(r.mod.invocationSource()).toBe('cli');
  });
});

describe('agents that name themselves', () => {
  let restore;
  afterEach(() => { if (restore) restore(); restore = null; });

  it('takes a name from RESTLESS_AGENT', async () => {
    const r = await freshEnv({ RESTLESS_AGENT: 'cursor' }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('cursor');
    expect(r.mod.isAgent()).toBe(true);
    expect(r.mod.invocationSource()).toBe('agent');
  });

  it('takes a name from --agent, in either spelling', async () => {
    let r = await freshEnv({}, { argv: ['key', '--agent', 'windsurf'] }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('windsurf');
    restore(); restore = null;

    r = await freshEnv({}, { argv: ['key', '--agent=windsurf'] }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('windsurf');
  });

  it('lets a self-reported name beat the inherited markers', async () => {
    // An agent shelling out from inside a Claude Code session inherits
    // CLAUDECODE=1; naming itself is the only way to correct that.
    const r = await freshEnv({ CLAUDECODE: '1', RESTLESS_AGENT: 'cursor' }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe('cursor');
  });

  it('folds the obvious spellings of a known agent together', async () => {
    for (const [given, expected] of [
      ['Claude Code', 'claude'],
      ['claude_code', 'claude'],
      ['CODEX-CLI', 'codex'],
    ]) {
      const r = await freshEnv({ RESTLESS_AGENT: given }); restore = r.restore;
      expect(r.mod.detectAgent()).toBe(expected);
      restore(); restore = null;
    }
  });

  it('ignores a name the server would reject, falling back to the markers', async () => {
    const r = await freshEnv({ CLAUDECODE: '1', RESTLESS_AGENT: 'not a slug!' });
    restore = r.restore;
    expect(r.mod.detectAgent()).toBe('claude');
  });

  it('ignores a name too long to be a name', async () => {
    const r = await freshEnv({ RESTLESS_AGENT: 'a'.repeat(64) }); restore = r.restore;
    expect(r.mod.detectAgent()).toBe(null);
  });
});

describe('an agent we cannot identify', () => {
  let restore;
  afterEach(() => { if (restore) restore(); restore = null; });

  it('treats a fully-piped run as agent-driven with no name', async () => {
    // The case this exists for: an agent with no marker we know used to fall
    // through to the human path, where the CLI would spawn its own model to
    // edit the caller's repo from inside a child process.
    const r = await freshEnv({}, { tty: false }); restore = r.restore;
    expect(r.mod.isAgent()).toBe(true);
    expect(r.mod.detectAgent()).toBe(null);
    expect(r.mod.invocationSource()).toBe('agent');
  });

  it('leaves `npx restless init | tee log.txt` alone - stdin is still a terminal', async () => {
    const r = await freshEnv({}, { tty: { out: false, in: true } }); restore = r.restore;
    expect(r.mod.isAgent()).toBe(false);
    expect(r.mod.invocationSource()).toBe('cli');
  });

  it('leaves `npx restless init < /dev/null` alone - stdout is still a terminal', async () => {
    const r = await freshEnv({}, { tty: { out: true, in: false } }); restore = r.restore;
    expect(r.mod.isAgent()).toBe(false);
  });

  it('RESTLESS_INTERACTIVE=1 opts a piped run back out', async () => {
    const r = await freshEnv({ RESTLESS_INTERACTIVE: '1' }, { tty: false });
    restore = r.restore;
    expect(r.mod.isAgent()).toBe(false);
    expect(r.mod.invocationSource()).toBe('cli');
  });
});

describe('agentLabel', () => {
  let restore;
  afterEach(() => { if (restore) restore(); restore = null; });

  it('names the agents we know and title-cases the ones we do not', async () => {
    const r = await freshEnv({}); restore = r.restore;
    expect(r.mod.agentLabel('claude')).toBe('Claude Code');
    expect(r.mod.agentLabel('codex')).toBe('Codex');
    expect(r.mod.agentLabel('cursor')).toBe('Cursor');
    expect(r.mod.agentLabel('some-new-agent')).toBe('Some New Agent');
  });

  it('never guesses a vendor when there is no name', async () => {
    const r = await freshEnv({}); restore = r.restore;
    expect(r.mod.agentLabel(null)).toBe('your agent');
  });
});

describe('interactivity', () => {
  let restore;
  afterEach(() => { if (restore) restore(); restore = null; });

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
