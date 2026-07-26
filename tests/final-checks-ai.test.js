import { describe, expect, it, vi } from 'vitest';

import { runAiChecks } from '../steps/final-checks.js';

// eslint-disable-next-line no-control-regex
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const ctx = { installDir: '/repo/api', framework: 'Express', language: 'javascript' };
const reply = (obj) => vi.fn(async () => '```json\n' + JSON.stringify(obj) + '\n```');

describe('runAiChecks', () => {
  it('turns the checklist into rows, in the order the model answered', async () => {
    const runner = reply({ checks: [
      { id: 'order', ok: true, note: '' },
      { id: 'mounted', ok: true, note: '' },
      { id: 'credential', ok: true, note: '' },
      { id: 'collateral', ok: true, note: '' },
      { id: 'runtime', ok: true, note: '' },
    ]});
    const rows = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(rows.map((r) => r.kind)).toEqual([
      'ai-order', 'ai-mounted', 'ai-credential', 'ai-collateral', 'ai-runtime',
    ]);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('surfaces the note on a failure', async () => {
    const runner = reply({ checks: [
      { id: 'order', ok: false, note: 'sits below requireApiKey on line 42' },
    ]});
    const [row] = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(row.ok).toBe(false);
    expect(strip(row.detail)).toContain('sits below requireApiKey');
    expect(row.label).toBe('Middleware order');
  });

  // These get reported, never auto-repaired - the fix is an edit to the
  // user's own middleware order, not to the block we manage.
  it('marks every row advisory and offers no fix thunk', async () => {
    const runner = reply({ checks: [{ id: 'order', ok: false, note: 'wrong place' }] });
    const [row] = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(row.advisory).toBe(true);
    expect(row.fix).toBeUndefined();
  });

  it('ignores checks it never asked about', async () => {
    const runner = reply({ checks: [
      { id: 'order', ok: true },
      { id: 'made-this-up', ok: false, note: 'hallucinated' },
    ]});
    const rows = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('ai-order');
  });

  // A review pass must never block the install, so both failure modes
  // degrade to one informational row that can't fail the step.
  it('degrades to an informational row when the model errors', async () => {
    const runner = vi.fn(async () => { throw new Error('rate limited'); });
    const [row] = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(row.ok).toBe(true);
    expect(row.informational).toBe(true);
    expect(strip(row.detail)).toContain("couldn't run");
  });

  it('degrades the same way on unparseable output', async () => {
    const runner = vi.fn(async () => 'I had a look and it seems fine to me!');
    const [row] = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(row.ok).toBe(true);
    expect(row.informational).toBe(true);
  });

  it('passes the file relative to the install dir, and the framework', async () => {
    const runner = reply({ checks: [] });
    await runAiChecks({ ctx, sourceFile: '/repo/api/src/server.js', runner });
    const [prompt, cwd] = runner.mock.calls[0];
    expect(prompt).toContain('src/server.js');
    expect(prompt).toContain('Express');
    expect(cwd).toBe('/repo/api');
    // The prompt has to keep telling it not to edit - this is a review pass.
    expect(prompt.toLowerCase()).toContain('do not edit');
  });
});
