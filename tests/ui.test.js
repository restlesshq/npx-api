import { describe, it, expect } from 'vitest';
import { normalizePickerItem, pickContextualHint } from '../lib/ui.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI_RE, '');

describe('normalizePickerItem', () => {
  it('treats a plain string as a label with no hint', () => {
    expect(normalizePickerItem('Hello')).toEqual({ label: 'Hello', hint: '' });
  });

  it('splits a string on newline into label + hint', () => {
    expect(normalizePickerItem('Hello\nworld')).toEqual({ label: 'Hello', hint: 'world' });
  });

  it('joins multi-line hints into a single hint string', () => {
    expect(normalizePickerItem('Hello\nfirst\nsecond')).toEqual({ label: 'Hello', hint: 'first second' });
  });

  it('passes through { label, hint } objects unchanged', () => {
    expect(normalizePickerItem({ label: 'Foo', hint: 'Bar' })).toEqual({ label: 'Foo', hint: 'Bar' });
  });

  it('treats a missing hint on the object as empty', () => {
    expect(normalizePickerItem({ label: 'Foo' })).toEqual({ label: 'Foo', hint: '' });
  });

  it('coerces non-string label/hint values to strings', () => {
    expect(normalizePickerItem({ label: 42, hint: 7 })).toEqual({ label: '42', hint: '7' });
  });

  it('strips whitespace from a hint that came from a newline split', () => {
    expect(normalizePickerItem('Label\n   ')).toEqual({ label: 'Label', hint: '' });
  });
});

describe('pickContextualHint', () => {
  it('returns the default invitation when nothing has happened yet', () => {
    const r = pickContextualHint({});
    expect(r.kind).toBe('default');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('Press enter to send a test request - no API key needed.');
    expect(text).toContain('401');
    expect(text).not.toContain('API_KEY_HERE');
  });

  it('flips to success when the SDK header was detected (no logs, no key)', () => {
    const r = pickContextualHint({ sdkDetected: true });
    expect(r.kind).toBe('success');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('the SDK is picking up your requests');
    expect(text).toContain('Press Tab to continue the setup.');
  });

  it('switches to success on any landed log, regardless of status', () => {
    const r = pickContextualHint({
      logs: [{ status: 200, method: 'GET', url: '/pets' }],
    });
    expect(r.kind).toBe('success');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('the SDK is picking up your requests');
    expect(text).toContain('Press Tab to continue the setup.');
  });

  it('treats a rejected request (401/404/500) as success too - the log still landed', () => {
    expect(pickContextualHint({ logs: [{ status: 401 }] }).kind).toBe('success');
    expect(pickContextualHint({ logs: [{ status: 404 }] }).kind).toBe('success');
    expect(pickContextualHint({ logs: [{ status: 500 }] }).kind).toBe('success');
    expect(pickContextualHint({ logs: [{ status: 301 }] }).kind).toBe('success');
  });

  it('shows the failing nudge once 3+ attempts have failed', () => {
    const r = pickContextualHint({
      failedAttempts: [{ method: 'GET', url: '/x' }, { method: 'GET', url: '/x' }, { method: 'GET', url: '/x' }],
    });
    expect(r.kind).toBe('failing');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('Still not seeing it');
    expect(text).toContain('RESTLESS_KEY');
    expect(text).toContain("skip ahead");
    expect(text).toContain('press Tab to continue');
  });

  it('counts a currently-failed pendingEntry toward the failure threshold', () => {
    // 2 archived + 1 pending failure -> 3 -> failing.
    const r = pickContextualHint({
      failedAttempts: [{}, {}],
      pendingEntry: { state: 'failed', method: 'GET', url: '/x' },
    });
    expect(r.kind).toBe('failing');
  });

  it('does NOT count a pending in-flight entry toward failures', () => {
    const r = pickContextualHint({
      failedAttempts: [{}, {}],
      pendingEntry: { state: 'pending', method: 'GET', url: '/x' },
    });
    expect(r.kind).toBe('default');
  });

  it('success beats failing (a 2xx after lots of fails clears the warning)', () => {
    const r = pickContextualHint({
      logs: [{ status: 200 }],
      failedAttempts: [{}, {}, {}, {}, {}],
    });
    expect(r.kind).toBe('success');
  });

  it('handles empty / missing inputs safely', () => {
    expect(pickContextualHint().kind).toBe('default');
    expect(pickContextualHint({}).kind).toBe('default');
    expect(pickContextualHint({ logs: null, failedAttempts: null }).kind).toBe('default');
  });

  it('uses dim+bold styling for the Tab keyword in every variant', () => {
    for (const variant of [
      pickContextualHint(),
      pickContextualHint({ logs: [{ status: 200 }] }),
      pickContextualHint({ sdkDetected: true }),
      pickContextualHint({ failedAttempts: [{}, {}, {}] }),
    ]) {
      const raw = variant.lines.join('');
      expect(raw).toMatch(/\x1b\[1mTab\x1b\[0m/);
    }
  });

  it("the success line is rendered green", () => {
    const r = pickContextualHint({ logs: [{ status: 200 }] });
    // first line: "  ${green('Congrats!...')}" - contains escape \x1b[32m
    expect(r.lines[0]).toContain('\x1b[32m');
  });

  it('the failing line is rendered yellow', () => {
    const r = pickContextualHint({ failedAttempts: [{}, {}, {}] });
    // ui.yellow is a 24-bit truecolor sequence; the SGR opcode that
    // matters is 38;2;<r>;<g>;<b>. Just confirm we start a foreground
    // color region (not the default).
    expect(r.lines[0]).toMatch(/\x1b\[(33|38;2;|38;5;)/);
  });
});
