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
    const r = pickContextualHint({ command: 'curl http://x' });
    expect(r.kind).toBe('default');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain("Make a successful call to confirm everything's set up.");
    expect(text).toContain('Edit the snippet below to make a valid request.');
    expect(text).not.toContain('API_KEY_HERE');
  });

  it('mentions API_KEY_HERE when the placeholder is still in the command', () => {
    const r = pickContextualHint({
      command: 'curl http://x -H "Authorization: Bearer API_KEY_HERE"',
    });
    expect(r.kind).toBe('placeholder');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('API_KEY_HERE');
    expect(text).toContain('replace');
    expect(text).toContain('real API key');
  });

  it('switches to success on any 2xx in logs', () => {
    const r = pickContextualHint({
      command: 'curl x',
      logs: [{ status: 200, method: 'GET', url: '/pets' }],
    });
    expect(r.kind).toBe('success');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain("Congrats! It's working.");
    expect(text).toContain('Press Tab to continue the setup.');
  });

  it('treats other 2xx codes as success too (201, 204)', () => {
    expect(pickContextualHint({ logs: [{ status: 201 }] }).kind).toBe('success');
    expect(pickContextualHint({ logs: [{ status: 204 }] }).kind).toBe('success');
  });

  it('does NOT treat 3xx / 4xx / 5xx as success', () => {
    expect(pickContextualHint({ logs: [{ status: 301 }] }).kind).toBe('default');
    expect(pickContextualHint({ logs: [{ status: 404 }] }).kind).toBe('default');
    expect(pickContextualHint({ logs: [{ status: 500 }] }).kind).toBe('default');
  });

  it('shows the failing nudge once 3+ attempts have failed', () => {
    const r = pickContextualHint({
      failedAttempts: [{ method: 'GET', url: '/x' }, { method: 'GET', url: '/x' }, { method: 'GET', url: '/x' }],
    });
    expect(r.kind).toBe('failing');
    const text = r.lines.map(strip).join('\n');
    expect(text).toContain('Edit the code snippet below to make a valid call.');
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
      pickContextualHint({ failedAttempts: [{}, {}, {}] }),
    ]) {
      // Tab should appear bolded (escape code 1) somewhere in the lines.
      const raw = variant.lines.join('');
      // 'success' and 'failing' both cite Tab; the default variant doesn't,
      // so we only check non-default variants for the bolded keyword.
      if (variant.kind !== 'default' && variant.kind !== 'placeholder') {
        expect(raw).toMatch(/\x1b\[1mTab\x1b\[0m/);
      }
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
