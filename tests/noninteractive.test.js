import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ask, singleSelect, askYesNo, waitForKey, terminalPrompt, terminalRunScreen } from '../lib/ui.js';
import { createPlanManager } from '../lib/runner.js';

// Force the non-interactive path regardless of the ambient TTY. isInteractive()
// checks RESTLESS_NONINTERACTIVE before anything else, so this is deterministic.
describe('non-interactive UI primitives', () => {
  let logSpy, writeSpy;
  beforeEach(() => {
    process.env.RESTLESS_NONINTERACTIVE = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    delete process.env.RESTLESS_NONINTERACTIVE;
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('singleSelect resolves to the default index without reading stdin', async () => {
    const idx = await singleSelect([{ label: 'A' }, { label: 'B' }, { label: 'C' }], { message: 'pick', defaultIndex: 2 });
    expect(idx).toBe(2);
  });

  it('singleSelect clamps an out-of-range default', async () => {
    const idx = await singleSelect([{ label: 'A' }], { message: 'pick', defaultIndex: 9 });
    expect(idx).toBe(0);
  });

  it('ask resolves to the provided default value', async () => {
    const val = await ask('  name? ', { defaultValue: 'foo' });
    expect(val).toBe('foo');
  });

  it('askYesNo resolves to the caller default', async () => {
    expect(await askYesNo('go? ', { defaultValue: true })).toBe(true);
    expect(await askYesNo('go? ', { defaultValue: false })).toBe(false);
  });

  it('waitForKey resolves immediately as Enter', async () => {
    expect(await waitForKey()).toBe('\r');
  });

  it('terminalPrompt returns the default command unchanged', async () => {
    expect(await terminalPrompt('npm install thing')).toBe('npm install thing');
  });

  it('terminalRunScreen runs onRun exactly once and returns its success', async () => {
    let calls = 0;
    const res = await terminalRunScreen('curl -i http://localhost:3000/', {
      onRun: (cmd) => { calls++; return { output: 'HTTP/1.1 401', success: true, command: cmd }; },
    });
    expect(calls).toBe(1);
    expect(res.success).toBe(true);
    expect(res.command).toBe('curl -i http://localhost:3000/');
  });

  it('terminalRunScreen surfaces an onRun throw as a failed result', async () => {
    const res = await terminalRunScreen('curl x', { onRun: () => { throw new Error('boom'); } });
    expect(res.success).toBe(false);
  });
});

describe('non-interactive plan manager', () => {
  let logSpy, writeSpy;
  beforeEach(() => {
    process.env.RESTLESS_NONINTERACTIVE = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    delete process.env.RESTLESS_NONINTERACTIVE;
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('prints step messages append-only and never clears the screen', () => {
    const plan = createPlanManager();
    plan.pin();
    const update = plan.makeUpdater(0);
    update({ status: 'active', message: ['', '  ── Step 1: Map your API ──', ''] });
    update({ status: 'done', message: ['  ✓ done'] });

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('── Step 1: Map your API ──');
    expect(logged).toContain('✓ done');

    // The full-screen clear/home escape must never be written in this mode.
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain('\x1b[H');
    expect(written).not.toContain('\x1b[J');
  });

  it('emits a spinner phase once when it changes, without per-tick spam', () => {
    const plan = createPlanManager();
    plan.pin();
    plan.setSpinner('Scanning endpoints');
    plan.setSpinner('Scanning endpoints'); // same phase - should not re-emit
    plan.setSpinner('Writing spec');

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    const scanning = logged.filter((l) => l.includes('Scanning endpoints'));
    const writing = logged.filter((l) => l.includes('Writing spec'));
    expect(scanning.length).toBe(1);
    expect(writing.length).toBe(1);
  });
});
