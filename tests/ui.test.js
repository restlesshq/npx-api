import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isAbortKey,
  normalizePickerItem,
  pickContextualHint,
  printLogo,
  setLogoSubtitle,
  startSpinner,
} from '../lib/ui.js';
import { CLI_NAME } from '../lib/config.js';

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

describe('startSpinner stays on one line', () => {
  /**
   * The spinner redraws with `\x1b[2K\r`, which clears the current line and
   * returns to ITS start. A message wider than the terminal wraps, so `\r`
   * lands on the last visual line only, the earlier ones survive, and every
   * tick leaks another - the spinner scrolls the screen and reads as a hang.
   * It is fed URLs, file paths and model-written summaries, so none of its
   * messages have a bounded length.
   */
  function capture(msg, columns) {
    const chunks = [];
    const origWrite = process.stdout.write;
    const origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    process.stdout.write = (c) => { chunks.push(String(c)); return true; };
    try {
      const spinner = startSpinner(msg);
      // Drive one tick without waiting on the real 80ms interval.
      return new Promise((resolve) => {
        setTimeout(() => {
          spinner.stop();
          process.stdout.write = origWrite;
          if (origCols) Object.defineProperty(process.stdout, 'columns', origCols);
          else delete process.stdout.columns;
          resolve(chunks);
        }, 120);
      });
    } catch (err) {
      process.stdout.write = origWrite;
      throw err;
    }
  }

  const widest = (chunks) => Math.max(
    0,
    ...chunks
      .map((c) => strip(c).replace(/\x1b\[2K/g, '').replace(/\r/g, ''))
      .map((c) => c.length),
  );

  it('truncates a message far wider than the terminal', async () => {
    const long = 'x'.repeat(400);
    const chunks = await capture(long, 80);
    expect(widest(chunks)).toBeLessThanOrEqual(80);
  });

  it('marks the truncation so it does not read as the whole message', async () => {
    const chunks = await capture('y'.repeat(400), 80);
    expect(chunks.some((c) => c.includes('\u2026'))).toBe(true);
  });

  it('leaves a short message intact', async () => {
    const chunks = await capture('Waiting for approval', 80);
    expect(chunks.some((c) => strip(c).includes('Waiting for approval'))).toBe(true);
  });

  it('never emits a newline, which is what would leak a line per tick', async () => {
    const chunks = await capture('z'.repeat(400), 80);
    expect(chunks.join('').includes('\n')).toBe(false);
  });

  it('adapts to a narrow terminal', async () => {
    const chunks = await capture('w'.repeat(400), 40);
    expect(widest(chunks)).toBeLessThanOrEqual(40);
  });
});

describe('logo subtitle names the running command', () => {
  // Row 2 of the logo was hardcoded to `npx api init`, so `update` displayed
  // the wrong command above every screen it drew. The default now also honours
  // CLI_NAME, which exists so output matches whatever bin name shipped - the
  // old literal ignored it.
  const DEFAULT_SUBTITLE = `npx ${CLI_NAME} init`;
  afterEach(() => setLogoSubtitle(DEFAULT_SUBTITLE));

  function render() {
    const out = [];
    const orig = process.stdout.write;
    process.stdout.write = (c) => { out.push(String(c)); return true; };
    try { printLogo(); } finally { process.stdout.write = orig; }
    return strip(out.join(''));
  }

  it('defaults to init, under whatever name the CLI was invoked as', () => {
    expect(render()).toContain(DEFAULT_SUBTITLE);
  });

  it('shows whatever the command sets', () => {
    setLogoSubtitle(`npx ${CLI_NAME} update`);
    const drawn = render();
    expect(drawn).toContain(`npx ${CLI_NAME} update`);
    expect(drawn).not.toContain(DEFAULT_SUBTITLE);
  });

  it('keeps the brand row intact', () => {
    setLogoSubtitle(`npx ${CLI_NAME} update`);
    expect(render()).toContain('Restless');
  });
});

describe('isAbortKey', () => {
  /**
   * Every raw-mode prompt keys off this, so it decides both whether Esc gets
   * you out and whether the arrow keys still work. The Esc test is exact for
   * that reason: arrows arrive as `\x1b[A` and friends, so a prefix match would
   * make Up and Down quit the picker instead of moving in it.
   */
  it('treats Ctrl-C and a bare Esc as abort', () => {
    expect(isAbortKey('\x03')).toBe(true);
    expect(isAbortKey('\x1b')).toBe(true);
  });

  it('does NOT treat any arrow key as abort', () => {
    for (const arrow of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']) {
      expect(isAbortKey(arrow)).toBe(false);
    }
  });

  it('does not treat other escape sequences as abort', () => {
    // Delete, Home, End, page keys - anything that shares the Esc prefix.
    for (const seq of ['\x1b[3~', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~', '\x1bOP']) {
      expect(isAbortKey(seq)).toBe(false);
    }
  });

  it('leaves ordinary input alone', () => {
    for (const key of ['\r', '\n', 's', 'S', ' ', '\x7f', '\b', '\x01', '\x05', '']) {
      expect(isAbortKey(key)).toBe(false);
    }
  });

  it('still catches a Ctrl-C bundled with other bytes', () => {
    // A fast paste or a burst read can deliver it alongside other input.
    expect(isAbortKey('abc\x03')).toBe(true);
  });

  it('is safe on non-string input', () => {
    for (const v of [undefined, null, 0, {}, []]) {
      expect(isAbortKey(v)).toBe(false);
    }
  });
});
