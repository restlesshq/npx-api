import { describe, expect, it, vi } from 'vitest';

import { runAiChecks } from '../steps/final-checks.js';

// eslint-disable-next-line no-control-regex
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const ctx = { installDir: '/repo/api', framework: 'Express', language: 'javascript' };
const reply = (obj) => vi.fn(async () => '```json\n' + JSON.stringify(obj) + '\n```');

describe('runAiChecks', () => {
  // The whole checklist collapses into a single row. Itemizing five green
  // "looks right" lines reads as five more things the user has to review;
  // the only takeaway on a clean pass is "nothing wrong around the wiring".
  it('collapses an all-pass checklist into one "looks good" row', async () => {
    const runner = reply({ checks: [
      { id: 'order', ok: true, note: 'registered on line 27, above the auth guard' },
      { id: 'mounted', ok: true, note: '' },
      { id: 'credential', ok: true, note: 'extracts the same authorization token' },
      { id: 'collateral', ok: true, note: '' },
      { id: 'runtime', ok: true, note: '' },
    ]});
    const rows = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('ai-review');
    expect(rows[0].ok).toBe(true);
    expect(rows[0].label).toBe('Deeper review');
    expect(strip(rows[0].detail)).toContain('looks good');
    // Notes on passing checks stay out of the render - they were the noise.
    expect(strip(rows[0].detail)).not.toContain('auth guard');
    expect(strip(rows[0].detail)).not.toContain('authorization token');
  });

  it('surfaces only the failures, labeled, under the single row', async () => {
    const runner = reply({ checks: [
      { id: 'order', ok: false, note: 'sits below requireApiKey on line 42' },
      { id: 'mounted', ok: true, note: 'fine' },
      { id: 'runtime', ok: false, note: '' },
    ]});
    const rows = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.ok).toBe(false);
    expect(row.label).toBe('Deeper review');
    const detail = strip(row.detail);
    expect(detail).toContain('Middleware order: sits below requireApiKey on line 42');
    expect(detail).toContain('File still loads: needs a look');
    expect(detail).not.toContain('fine');
  });

  // These get reported, never auto-repaired - the fix is an edit to the
  // user's own middleware order, not to the block we manage.
  it('marks a failing review advisory and offers no fix thunk', async () => {
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
    expect(rows[0].ok).toBe(true);
    expect(strip(rows[0].detail)).not.toContain('hallucinated');
  });

  // An empty checklist is not a pass - don't claim "looks good" when the
  // model answered nothing we asked about.
  it('does not claim "looks good" on an empty checklist', async () => {
    const runner = reply({ checks: [] });
    const [row] = await runAiChecks({ ctx, sourceFile: '/repo/api/index.js', runner });
    expect(row.ok).toBe(true);
    expect(row.informational).toBe(true);
    expect(strip(row.detail)).toContain('no clear verdict');
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
