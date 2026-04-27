import readline from 'readline';
import * as debug from './debug.js';

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s) => `\x1b[1m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

export function ask(prompt) {
  return new Promise((resolve) => {
    // Reset stdin from whatever state the previous UI left it in
    // (multiSelect/singleSelect put it in raw mode with keypress listeners).
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('readable');
    process.stdin.resume();

    // terminal: true lets readline handle arrow keys / cursor movement /
    // backspace / etc. itself. Running directly on stdin (no PassThrough)
    // so the TTY escape-sequence interpretation works.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Ctrl-C while answering should quit the CLI cleanly.
    rl.once('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      debug.flushAndExit(130);
    });

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdin.pause();
      debug.log('input.ask', { prompt: stripAnsi(prompt), answer });
      resolve(answer);
    });
  });
}

// Local copy so debug logging doesn't have to import from ./debug for ANSI
// stripping — keeps the dependency direction one-way.
// eslint-disable-next-line no-control-regex
const ANSI_RE_UI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s) { return (s || '').replace(ANSI_RE_UI, ''); }

export function clearLines(n) {
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

export function multiSelect(items, { message }) {
  return new Promise((resolve) => {
    const selected = new Set(items.map((_, i) => i)); // all selected by default
    let cursor = 0;

    const { stdin, stdout } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function render() {
      clearLines(items.length + 2); // items + header + footer
      stdout.write(`  ${bold(message)}\n`);
      for (let i = 0; i < items.length; i++) {
        const check = selected.has(i) ? green('✓') : dim('○');
        const label = i === cursor ? bold(items[i]) : items[i];
        const pointer = i === cursor ? cyan('❯') : ' ';
        stdout.write(`  ${pointer} ${check} ${label}\n`);
      }
      stdout.write(dim('  ↑/↓ move · space toggle · enter confirm\n'));
    }

    // initial draw (no clear needed first time)
    stdout.write(`  ${bold(message)}\n`);
    for (let i = 0; i < items.length; i++) {
      const check = selected.has(i) ? green('✓') : dim('○');
      const label = i === cursor ? bold(items[i]) : items[i];
      const pointer = i === cursor ? cyan('❯') : ' ';
      stdout.write(`  ${pointer} ${check} ${label}\n`);
    }
    stdout.write(dim('  ↑/↓ move · space toggle · enter confirm\n'));

    stdin.on('data', (key) => {
      if (key === '\x1b[A') { // up
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === '\x1b[B') { // down
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === ' ') { // space - toggle
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        render();
      } else if (key === '\r' || key === '\n') { // enter
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        const indices = [...selected].sort();
        debug.log('input.multiSelect', {
          message,
          items: items.map((it) => stripAnsi(String(it))),
          selected: indices,
          selectedItems: indices.map((i) => stripAnsi(String(items[i]))),
        });
        resolve(indices);
      } else if (key === '\x03') { // ctrl-c
        stdin.setRawMode(false);
        debug.flushAndExit(0);
      }
    });
  });
}

export function singleSelect(items, { message, defaultIndex = 0 } = {}) {
  return new Promise((resolve) => {
    let cursor = defaultIndex;

    const { stdin, stdout } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    // Items may contain embedded newlines; subsequent lines render dim and
    // indented under the label. Total rows rendered = sum of line counts.
    const totalRows = () => items.reduce((n, it) => n + it.split('\n').length, 0);

    function drawList(initial = false) {
      if (!initial) clearLines(totalRows() + 2);
      stdout.write(`  ${bold(message)}\n`);
      for (let i = 0; i < items.length; i++) {
        const pointer = i === cursor ? cyan('❯') : ' ';
        const num = dim(`${i + 1}.`);
        const parts = items[i].split('\n');
        const first = i === cursor ? bold(parts[0]) : parts[0];
        stdout.write(`  ${pointer} ${num} ${first}\n`);
        for (const l of parts.slice(1)) {
          stdout.write(`       ${l}\n`);
        }
      }
      const hint = items.length <= 9
        ? `  ↑/↓ move · 1-${items.length} jump · enter select`
        : '  ↑/↓ move · enter select';
      stdout.write(dim(hint + '\n'));
    }

    drawList(true);

    stdin.on('data', (key) => {
      // Arrow up
      if (key === '\x1b[A') {
        cursor = (cursor - 1 + items.length) % items.length;
        drawList();
        return;
      }
      // Arrow down
      if (key === '\x1b[B') {
        cursor = (cursor + 1) % items.length;
        drawList();
        return;
      }
      // Enter
      if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        debug.log('input.singleSelect', {
          message,
          items: items.map((it) => stripAnsi(String(it))),
          selected: cursor,
          selectedItem: stripAnsi(String(items[cursor])),
        });
        resolve(cursor);
        return;
      }
      // Ctrl-C
      if (key === '\x03') {
        stdin.setRawMode(false);
        debug.flushAndExit(0);
      }
      // Number keys: jump directly. Single press selects.
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (idx < items.length) {
          cursor = idx;
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          // Redraw with the final selection highlighted before resolving.
          drawList();
          debug.log('input.singleSelect', {
            message,
            items: items.map((it) => stripAnsi(String(it))),
            selected: cursor,
            selectedItem: stripAnsi(String(items[cursor])),
          });
          resolve(cursor);
        }
      }
    });
  });
}

/**
 * Type a string into stdout one visible character at a time. ANSI color
 * escapes are written atomically so they don't glitch. Honors non-TTY
 * (just writes the string at once, no animation).
 */
export async function typeOut(text, { delay = 18 } = {}) {
  if (!process.stdout.isTTY) {
    process.stdout.write(text);
    return;
  }
  // Split on ANSI SGR sequences so we type visible chars but write color
  // codes atomically.
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\x1b[')) {
      process.stdout.write(part);
    } else {
      for (const ch of part) {
        process.stdout.write(ch);
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }
}

export async function typeLine(text, opts) {
  await typeOut(text, opts);
  process.stdout.write('\n');
}

/**
 * Named spinner presets. Try each by changing `style` in the inlineStatus
 * call site. All frames are single-width so they animate in place via \b.
 */
export const SPINNERS = {
  // Subtle rotating arc. Quiet.
  arc:        ['◜', '◝', '◞', '◟'],

  // Rotating half-circle. Strong spin feel.
  halfcircle: ['◐', '◓', '◑', '◒'],

  // Pie chart filling up. Clockwise growth.
  piefill:    ['◴', '◵', '◶', '◷'],

  // Dot growing/shrinking — pulse. Low-key.
  pulse:      ['·', '∙', '•', '●', '•', '∙'],

  // Claude-style rotating sparkle. Busy, magical.
  sparkle:    ['✦', '✧', '✶', '✷', '✸', '✹'],

  // Concentric circles opening and closing. Breathy.
  concentric: ['◌', '○', '◎', '●', '◎', '○'],

  // Classic braille spinner. The default in most CLIs.
  braille:    ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

/**
 * Animate a "loading → resolved status" in place on the current line.
 * The spinner lands in place where the colored ● ends up, and the
 * status code types in after it. No erase-and-replace — caller's
 * surrounding text isn't disturbed.
 *
 *   await inlineStatus({ code: '400 Bad Request', success: false });
 *
 * Valid styles: arc, halfcircle, piefill, pulse, sparkle, concentric, braille.
 */
export async function inlineStatus({ code, success, duration = 1100, style = 'arc' }) {
  const circle = success ? green('●') : red('●');
  const colored = success ? green(bold(code)) : red(bold(code));

  if (!process.stdout.isTTY) {
    // Non-TTY: just emit the final status.
    process.stdout.write(`${circle} ${colored}`);
    return;
  }

  const frames = SPINNERS[style] || SPINNERS.arc;
  let frame = 0;

  process.stdout.write(dim(frames[0]));

  const interval = setInterval(() => {
    frame = (frame + 1) % frames.length;
    process.stdout.write('\b' + dim(frames[frame]));
  }, 110);

  await new Promise((r) => setTimeout(r, duration));
  clearInterval(interval);

  // Land: rotating frame → dim filled circle → colored filled circle → text.
  // The breath between the circle and the status code happens *after*
  // the trailing space, so the cursor is sitting one column right of the
  // dot during the pause instead of glued up against it.
  process.stdout.write('\b' + dim('●'));
  await new Promise((r) => setTimeout(r, 120));
  process.stdout.write('\b' + circle + ' ');
  await new Promise((r) => setTimeout(r, 60));
  await typeOut(colored);
}

/**
 * Wait for any keypress. Ctrl-C exits. Returns the pressed key as a string
 * (single char for printable keys, escape sequence for arrows, etc.) so
 * callers can branch on specific shortcuts.
 */
export function waitForKey() {
  return new Promise((resolve) => {
    const { stdin } = process;
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (key) => {
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      if (key === '\x03') debug.flushAndExit(0);
      debug.log('input.waitForKey', { key: keyDisplay(key) });
      resolve(key);
    });
  });
}

// Render a key for the debug log without dumping raw control bytes.
// Printable chars pass through; everything else becomes a hex escape.
function keyDisplay(k) {
  if (!k) return '';
  if (k.length === 1 && k.charCodeAt(0) >= 32 && k.charCodeAt(0) < 127) return k;
  return [...k].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 32 && code < 127) return c;
    return '\\x' + code.toString(16).padStart(2, '0');
  }).join('');
}

/**
 * Single-keypress yes/no prompt. Prefer this over `ask()` for any y/n
 * question — it's more reliable (raw-mode stdin, no readline) and more
 * ergonomic (no Enter required).
 *
 *   y / Y   → true
 *   n / N   → false
 *   Enter   → defaultValue
 *   Ctrl-C  → exit(130)
 *
 * Any other key re-prompts silently. `prompt` is written via stdout before
 * the read starts; pass an empty string if the caller already drew the
 * question through the plan updater.
 */
export function askYesNo(prompt = '', { defaultValue = true } = {}) {
  if (prompt) process.stdout.write(prompt);
  return new Promise((resolve) => {
    const { stdin } = process;

    // Belt-and-suspenders cleanup of prior UI state. `waitForKey` / readline
    // both leave stdin in configurations that trip each other up.
    try { stdin.setRawMode(false); } catch {}
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('readable');

    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.setEncoding('utf8');

    const onKey = (key) => {
      if (key === '\x03') {
        try { stdin.setRawMode(false); } catch {}
        stdin.pause();
        process.stdout.write('\n');
        debug.flushAndExit(130);
        return;
      }
      const ch = (key || '').toLowerCase();
      let answer;
      if (ch === 'y') answer = true;
      else if (ch === 'n') answer = false;
      else if (key === '\r' || key === '\n') answer = defaultValue;
      else return; // ignore anything else — wait for a valid key
      stdin.off('data', onKey);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      process.stdout.write(answer ? 'y\n' : 'n\n');
      debug.log('input.askYesNo', { prompt: stripAnsi(prompt), answer });
      resolve(answer);
    };
    stdin.on('data', onKey);
  });
}

export function startSpinner(initialMsg) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let msg = initialMsg;
  const interval = setInterval(() => {
    process.stdout.write(`\x1b[2K\r  ${dim(frames[i++ % frames.length])} ${dim(msg)}`);
  }, 80);
  return {
    update(newMsg) { msg = newMsg; },
    stop() {
      clearInterval(interval);
      process.stdout.write('\x1b[2K\r');
    },
  };
}

export async function terminalPrompt(defaultCommand) {
  const { stdin, stdout } = process;
  const termWidth = stdout.columns || 80;
  const boxWidth = Math.max(Math.min(termWidth - 4, 72), 40);
  const cmdSpace = boxWidth - 7;

  const r = '\x1b[31m', y = '\x1b[33m', g = '\x1b[32m', d = '\x1b[2m', rst = '\x1b[0m';

  function renderBox(text, cp) {
    let visible = text;
    let visCursor = cp;
    if (text.length > cmdSpace) {
      const start = Math.max(0, cp - cmdSpace + 5);
      visible = text.substring(start, start + cmdSpace);
      visCursor = cp - start;
    }
    const pad = Math.max(0, cmdSpace - visible.length);

    const dashes = Math.max(boxWidth - 11, 1);
    const top = `  ${d}╭── ${rst}${r}●${rst} ${y}●${rst} ${g}●${rst}${d} ${'─'.repeat(dashes)}╮${rst}`;
    const cmd = `  ${d}│${rst}  ${d}$${rst} ${visible}${' '.repeat(pad)} ${d}│${rst}`;
    const bot = `  ${d}╰${'─'.repeat(boxWidth - 2)}╯${rst}`;
    const help = `  ${d}enter to run · edit the command above${rst}`;

    return { top, cmd, bot, help, visCursor };
  }

  let boxDrawn = false;

  function drawBox(text, cp) {
    if (boxDrawn) {
      stdout.write('\x1b[1G\x1b[1A\x1b[J');
    }

    const { top, cmd, bot, help, visCursor } = renderBox(text, cp);
    stdout.write(`${top}\n${cmd}\n${bot}\n${help}`);
    stdout.write(`\x1b[2A\x1b[${8 + visCursor}G`);

    boxDrawn = true;
  }

  // Phase 1: Typing animation
  stdout.write('\n');
  stdout.write('\x1b[?25h');
  drawBox('', 0);

  let skipTyping = false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const skipHandler = (key) => {
    if (key === '\x03') { stdin.setRawMode(false); stdout.write('\x1b[?25h\n'); debug.flushAndExit(0); return; }
    skipTyping = true;
  };
  stdin.on('data', skipHandler);

  for (let i = 0; i < defaultCommand.length && !skipTyping; i++) {
    await new Promise(r => setTimeout(r, 25));
    drawBox(defaultCommand.substring(0, i + 1), i + 1);
  }

  stdin.removeListener('data', skipHandler);
  drawBox(defaultCommand, defaultCommand.length);

  // Phase 2: Interactive editing
  return new Promise((resolve) => {
    let buffer = defaultCommand;
    let cursor = buffer.length;

    function onKey(key) {
      if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        stdout.write('\x1b[2B\x1b[1G\n');
        debug.log('input.terminalPrompt', { defaultCommand, command: buffer });
        resolve(buffer);
      } else if (key === '\x7f' || key === '\b') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          drawBox(buffer, cursor);
        }
      } else if (key === '\x1b[D') {
        if (cursor > 0) { cursor--; drawBox(buffer, cursor); }
      } else if (key === '\x1b[C') {
        if (cursor < buffer.length) { cursor++; drawBox(buffer, cursor); }
      } else if (key === '\x01') {
        cursor = 0; drawBox(buffer, cursor);
      } else if (key === '\x05') {
        cursor = buffer.length; drawBox(buffer, cursor);
      } else if (key === '\x03') {
        stdin.setRawMode(false);
        stdout.write('\x1b[?25h\n');
        debug.flushAndExit(0);
      } else if (key.length > 0 && !key.startsWith('\x1b') && key.charCodeAt(0) >= 32) {
        for (const ch of key) {
          if (ch.charCodeAt(0) >= 32) {
            buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
            cursor++;
          }
        }
        drawBox(buffer, cursor);
      }
    }

    stdin.on('data', onKey);
  });
}

export async function terminalRunScreen(defaultCommand, { onRun, pollConfig, noLogsHint, noLogsHintMs = 8000 } = {}) {
  const { stdin, stdout } = process;
  const termWidth = stdout.columns || 80;
  const termHeight = stdout.rows || 24;

  const boxWidth = termWidth - 4;
  const topHeight = Math.floor(termHeight / 2);
  const botHeight = termHeight - topHeight;
  const cmdSpace = boxWidth - 7;
  const maxOutputLines = botHeight - 5;

  const d = '\x1b[2m', rst = '\x1b[0m';
  const rc = '\x1b[31m', yc = '\x1b[33m', gc = '\x1b[32m';
  const bc = '\x1b[1m';

  // Log polling state
  let logs = [];
  let logCount = 0;
  let hasSuccessfulRun = false;
  let pollTimer = null;
  let pollSince = new Date().toISOString();

  // "In-flight" placeholder for the most recent run. Surfaced at the
  // top of the log list with a spinner; replaced by the real log when
  // it lands, or annotated with a diagnostic message if we conclude
  // (immediately or after `noLogsHintMs`) that no log will arrive.
  //
  //   { method, url, state: 'pending' | 'failed', hint?: string[],
  //     setAtCount: number }
  let pendingEntry = null;
  let hintTimer = null;
  let spinFrame = 0;
  let spinTimer = null;
  // Concentric breathing-circle frames — same set runner.js uses, so
  // the loading icon here matches the one users already see in the plan.
  const SPINNER_FRAMES = ['◌', '○', '◎', '●', '◎', '○'];

  function startSpin() {
    if (spinTimer) return;
    spinTimer = setInterval(() => {
      spinFrame++;
      if (lastDrawArgs && pendingEntry && pendingEntry.state === 'pending') {
        drawScreen(...lastDrawArgs);
      }
    }, 180);
  }
  function stopSpin() {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  }
  function setPendingHint(hint) {
    if (!pendingEntry) return;
    const lines = Array.isArray(hint) ? hint : String(hint).split('\n');
    pendingEntry.state = 'failed';
    pendingEntry.hint = lines;
    stopSpin();
    if (lastDrawArgs) drawScreen(...lastDrawArgs);
  }
  function startNoLogsHintTimer() {
    if (!noLogsHint || hintTimer || !pendingEntry || pendingEntry.state !== 'pending') return;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      if (!pendingEntry || pendingEntry.state !== 'pending') return;
      if (logs.length > 0) return;
      const v = typeof noLogsHint === 'function' ? noLogsHint() : noLogsHint;
      if (v) setPendingHint(v);
    }, noLogsHintMs);
  }
  function clearHintTimer() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  }

  async function pollLogs() {
    if (!pollConfig) return;
    try {
      const res = await fetch(pollConfig.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: pollConfig.projectId,
          setupKey: pollConfig.setupKey,
          since: pollSince,
          limit: 20,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          // Add new logs (avoid duplicates by id)
          const existingIds = new Set(logs.map(l => l.id));
          const newLogs = data.logs.filter(l => !existingIds.has(l.id));
          if (newLogs.length > 0) {
            logs = [...newLogs, ...logs];
            logCount += newLogs.length;
            // A real log just landed for the in-flight request — drop
            // the placeholder so the row doesn't double up.
            if (pendingEntry && logCount > pendingEntry.setAtCount) {
              pendingEntry = null;
              stopSpin();
              clearHintTimer();
            }
          }
        }
      }
    } catch {
      // Network blips are expected during early setup. Swallow — the
      // user will notice if logs never arrive (we surface a hint), and
      // a stderr write would shove the rendered TUI down a row.
    }
  }

  let exited = false;

  function startPolling() {
    if (!pollConfig || pollTimer) return;
    pollTimer = setInterval(async () => {
      if (exited) return;
      await pollLogs();
      if (!exited && lastDrawArgs) drawScreen(...lastDrawArgs);
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function cleanup() {
    exited = true;
    stopPolling();
    stopSpin();
    clearHintTimer();
    try { stdin.setRawMode(false); } catch {}
    // Pause BEFORE removing listeners to avoid 'end' event from flowing mode
    stdin.pause();
    stdin.removeAllListeners('data');
    // Clear the full-screen view so the plan manager can take over cleanly
    stdout.write('\x1b[?25h\x1b[H\x1b[J');
  }

  let lastDrawArgs = null;

  function buildTopHalf() {
    const lines = [];
    const maxLogLines = topHeight - 3; // leave room for header + hint

    if (logs.length === 0 && !pendingEntry) {
      // No run yet — gentle prompt centered in the top half.
      const title = "Let's test the setup! Make an API request to see if it's working.";
      const label = 'Waiting for logs...';
      const padBefore = Math.max(Math.floor((topHeight - 3) / 2), 0);
      const padAfter = Math.max(topHeight - padBefore - 3, 0);
      for (let i = 0; i < padBefore; i++) lines.push('');
      lines.push(' '.repeat(Math.max(Math.floor((termWidth - title.length) / 2), 0)) + bc + title + rst);
      lines.push('');
      lines.push(' '.repeat(Math.max(Math.floor((termWidth - label.length) / 2), 0)) + d + label + rst);
      for (let i = 0; i < padAfter; i++) lines.push('');
    } else {
      // Header
      lines.push(`  ${bc}Logs${rst} ${d}(${logCount} received)${rst}`);
      lines.push('');

      const hintLine = 1; // reserve a line for the continue hint

      // Pending placeholder (in-flight or failed) goes first.
      if (pendingEntry) {
        if (pendingEntry.state === 'pending') {
          const frame = SPINNER_FRAMES[spinFrame % SPINNER_FRAMES.length];
          lines.push(formatLogRow({
            icon: `${d}${frame}${rst}`,
            status: `${d}···${rst}`,
            method: pendingEntry.method,
            url: pendingEntry.url,
            trail: `${d}in flight…${rst}`,
            dim: true,
          }));
        } else {
          // Failed: warning icon, hint lines with a tree-style connector
          // so it reads as one unit ("this row failed because…").
          lines.push(formatLogRow({
            icon: `${yc}⚠${rst}`,
            status: `${d}---${rst}`,
            method: pendingEntry.method,
            url: pendingEntry.url,
          }));
          const hintList = pendingEntry.hint || [];
          for (let i = 0; i < hintList.length; i++) {
            // First hint gets the corner connector at the icon column;
            // subsequent lines are indented to align with the text.
            const connector = i === 0 ? `${d}╰─${rst}` : '  ';
            lines.push(`  ${connector}     ${hintList[i]}`);
          }
        }
      }

      // Real logs, newest first.
      const used = lines.length + hintLine;
      const visible = logs.slice(0, Math.max(maxLogLines - used + 2, 0));
      for (const log of visible) {
        const dot = colorForStatus(log.status);
        lines.push(formatLogRow({
          icon: `${dot}●${rst}`,
          status: String(log.status).padStart(3),
          method: log.method,
          url: pathOnly(log.url),
          trail: log.duration != null ? `${d}${Math.round(log.duration)}ms${rst}` : '',
          statusColor: dot,
        }));
      }

      // Fill remaining (leave last line for hint)
      const remaining = topHeight - lines.length - hintLine;
      for (let i = 0; i < remaining; i++) lines.push('');

      // Continue hint at the bottom of the top half
      lines.push(`  ${d}Press ${rst}${bc}Tab${rst}${d} when you're ready to continue setup${rst}`);
    }

    return lines;
  }

  // Pick the dot color from a response status code:
  //   2xx → green, 3xx → yellow, 4xx → orange (256-color), 5xx → red.
  function colorForStatus(status) {
    if (status >= 500) return rc;
    if (status >= 400) return '\x1b[38;5;208m'; // orange
    if (status >= 300) return yc;
    if (status >= 200) return gc;
    return d;
  }

  // Strip scheme://host from a URL so the row reads `GET /pets`,
  // matching the design. Falls back to the raw value if it doesn't
  // parse (relative URL, weird input, etc).
  function pathOnly(url) {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || '');
    } catch {
      return url;
    }
  }

  // Layout: `  ●  STAT  METHOD   /url    trail`
  //   - icon: 1 visible char (already wrapped in ANSI color)
  //   - status: 3 chars (status code or '---' for pending/failed)
  //   - method: padded to 6
  //   - url: truncated to fit the row
  //   - trail: optional right-side text (duration, "in flight…")
  function formatLogRow({ icon, status, method, url, trail = '', dim = false, statusColor }) {
    const colorOpen = dim ? d : '';
    const colorClose = dim ? rst : '';
    const statusPart = statusColor ? `${statusColor}${status}${rst}` : `${colorOpen}${status}${colorClose}`;
    const methodPart = `${colorOpen}${method.padEnd(6)}${colorClose}`;
    // Compute available URL width: ~12 chars chrome on the left
    // (icon + spaces + status + method) plus the trail on the right.
    const trailVisible = trail.replace(/\x1b\[[0-9;]*m/g, '');
    const urlMax = Math.max(10, termWidth - 16 - trailVisible.length);
    const urlText = url.length > urlMax ? url.substring(0, urlMax - 1) + '…' : url;
    const urlPart = `${colorOpen}${urlText}${colorClose}`;
    return `  ${icon}  ${statusPart}  ${methodPart} ${urlPart}${trail ? '  ' + trail : ''}`;
  }

  function buildScreen(text, cp, output, phase) {
    const lines = buildTopHalf();

    // ── Bottom half: terminal box ──
    const dashes = Math.max(boxWidth - 11, 1);
    lines.push(`  ${d}╭── ${rst}${rc}●${rst} ${yc}●${rst} ${gc}●${rst}${d} ${'─'.repeat(dashes)}╮${rst}`);

    // Command line
    let visible = text;
    let visCursor = cp !== undefined ? cp : text.length;
    if (text.length > cmdSpace) {
      const start = Math.max(0, visCursor - cmdSpace + 5);
      visible = text.substring(start, start + cmdSpace);
      visCursor = (cp !== undefined ? cp : text.length) - start;
    }
    const cmdPad = Math.max(0, cmdSpace - visible.length);
    lines.push(`  ${d}│${rst}  ${d}$${rst} ${visible}${' '.repeat(cmdPad)} ${d}│${rst}`);

    // Output area
    if (output && output.length > 0 && !(output.length === 1 && output[0] === '')) {
      lines.push(`  ${d}│${'─'.repeat(boxWidth - 2)}│${rst}`);
      let outputToShow = output.slice(0, maxOutputLines);
      if (output.length > maxOutputLines) {
        outputToShow = output.slice(0, maxOutputLines - 1);
        outputToShow.push(`${d}… ${output.length - maxOutputLines + 1} more lines${rst}`);
      }
      for (const ol of outputToShow) {
        const clean = ol.replace(/\t/g, '  ');
        const truncated = clean.substring(0, boxWidth - 4);
        const olPad = Math.max(0, boxWidth - 4 - truncated.length);
        lines.push(`  ${d}│${rst} ${truncated}${' '.repeat(olPad)} ${d}│${rst}`);
      }
      const remaining = Math.max(0, maxOutputLines - outputToShow.length);
      for (let i = 0; i < remaining; i++) {
        lines.push(`  ${d}│${rst}${' '.repeat(boxWidth - 2)}${d}│${rst}`);
      }
    } else {
      const emptyCount = maxOutputLines + 1;
      for (let i = 0; i < emptyCount; i++) {
        lines.push(`  ${d}│${rst}${' '.repeat(boxWidth - 2)}${d}│${rst}`);
      }
    }

    lines.push(`  ${d}╰${'─'.repeat(boxWidth - 2)}╯${rst}`);

    if (phase === 'edit') {
      lines.push(`  ${d}enter to run · edit the command above${rst}`);
    } else if (phase === 'running') {
      lines.push(`  ${d}running...${rst}`);
    } else if (phase === 'retry') {
      lines.push(`  ${bc}↵ Enter${rst}${d} rerun · ${rst}${bc}e${rst}${d} edit command · ${rst}${bc}Tab${rst}${d} skip${rst}`);
    } else if (phase === 'confirm-skip') {
      lines.push(`  ${bc}Tab${rst}${d} skip anyway · ${rst}${bc}↵ Enter${rst}${d} keep testing${rst}`);
    } else if (phase === 'done' && pollConfig) {
      lines.push(`  ${bc}↵ Enter${rst}${d} run again · ${rst}${bc}Tab${rst}${d} continue setup${rst}`);
    } else {
      lines.push(`  ${d}press enter to continue${rst}`);
    }

    return { allLines: lines, visCursor };
  }

  function drawScreen(text, cp, output, phase) {
    lastDrawArgs = [text, cp, output, phase];
    const { allLines, visCursor } = buildScreen(text, cp, output, phase);
    stdout.write('\x1b[?25l\x1b[H\x1b[J');
    stdout.write(allLines.join('\n'));

    if (phase === 'edit') {
      const cmdRow = topHeight + 2;
      stdout.write(`\x1b[${cmdRow};${8 + visCursor}H`);
      stdout.write('\x1b[?25h');
    }
  }

  let command = defaultCommand;
  let isFirstRun = true;
  let skipEdit = false;

  // Outer loop: each iteration is an edit → run cycle
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Typing animation (first run only) ──
    if (isFirstRun) {
      drawScreen('', 0, null, 'edit');

      let skipTyping = false;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const skipHandler = (key) => {
        if (key === '\x03') { cleanup(); debug.flushAndExit(0); return; }
        skipTyping = true;
      };
      stdin.on('data', skipHandler);

      for (let i = 0; i < command.length && !skipTyping; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        drawScreen(command.substring(0, i + 1), i + 1, null, 'edit');
      }

      stdin.removeListener('data', skipHandler);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
    }

    // ── Interactive editing (skipped on rerun) ──
    if (!skipEdit) {
      drawScreen(command, command.length, null, 'edit');

      command = await new Promise((resolve) => {
        let buffer = command;
        let cursor = buffer.length;

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        function onKey(key) {
          if (key === '\r' || key === '\n') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeAllListeners('data');
            resolve(buffer);
          } else if (key === '\x7f' || key === '\b') {
            if (cursor > 0) {
              buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
              cursor--;
              drawScreen(buffer, cursor, null, 'edit');
            }
          } else if (key === '\x1b[D') {
            if (cursor > 0) { cursor--; drawScreen(buffer, cursor, null, 'edit'); }
          } else if (key === '\x1b[C') {
            if (cursor < buffer.length) { cursor++; drawScreen(buffer, cursor, null, 'edit'); }
          } else if (key === '\x01') {
            cursor = 0; drawScreen(buffer, cursor, null, 'edit');
          } else if (key === '\x05') {
            cursor = buffer.length; drawScreen(buffer, cursor, null, 'edit');
          } else if (key === '\x03') {
            cleanup(); debug.flushAndExit(0); return;
          } else if (key.length > 0 && !key.startsWith('\x1b') && key.charCodeAt(0) >= 32) {
            for (const ch of key) {
              if (ch.charCodeAt(0) >= 32) {
                buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
                cursor++;
              }
            }
            drawScreen(buffer, cursor, null, 'edit');
          }
        }

        stdin.on('data', onKey);
      });
    }
    skipEdit = false;

    // ── Run the command ──
    drawScreen(command, command.length, null, 'running');

    // New run — clear any stale state from the previous attempt.
    pendingEntry = null;
    stopSpin();
    clearHintTimer();

    let result = { output: '', success: true };
    if (onRun) {
      result = onRun(command);
    }

    // onRun can return a `command` field to rewrite what we display —
    // useful when the run handler had to patch the command (adding a
    // missing required flag, for instance) and wants the user to see
    // exactly what was executed.
    if (typeof result.command === 'string') {
      command = result.command;
    }

    // Stand up the in-flight placeholder as soon as the run finishes,
    // so the user sees their request appear up top with a spinner
    // before any polling round-trip. `pending` from onRun carries the
    // method + url; `immediateHint` is set when onRun already knows
    // logs won't be coming (e.g. SDK didn't run on this request).
    if (result.success && result.pending) {
      pendingEntry = {
        method: result.pending.method || 'GET',
        url: result.pending.url || '',
        state: result.immediateHint ? 'failed' : 'pending',
        hint: result.immediateHint
          ? (Array.isArray(result.immediateHint) ? result.immediateHint : [String(result.immediateHint)])
          : null,
        setAtCount: logCount,
      };
      if (pendingEntry.state === 'pending') startSpin();
    }

    const outputArr = (result.output || '').trim().split('\n');
    const phase = result.success ? 'done' : 'retry';

    // Track successful runs and start polling
    if (result.success) hasSuccessfulRun = true;
    if (result.success && pollConfig) {
      startPolling();
      if (pendingEntry && pendingEntry.state === 'pending') startNoLogsHintTimer();
    }

    drawScreen(command, command.length, outputArr, phase);

    // ── Wait for action ──
    const action = await new Promise((resolve) => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const handler = (key) => {
        if (key === '\r' || key === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          if (result.success && pollConfig) {
            // In polling mode, Enter goes back to edit so they can try different commands
            resolve('edit');
          } else if (result.success) {
            resolve('continue');
          } else {
            resolve('rerun');
          }
        } else if (key === 'e' && !result.success) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          resolve('edit');
        } else if (key === '\t') {
          if (pollConfig && !hasSuccessfulRun) {
            // Show confirmation — they haven't had a successful API call yet
            drawScreen(command, command.length, [
              '',
              `  ${bc}You haven't made a successful API call yet.${rst}`,
              `  Try running a request so you can see logs come through.`,
              '',
              `  ${d}Press ${rst}${bc}Tab${rst}${d} again to skip anyway, or ${rst}${bc}Enter${rst}${d} to keep testing.${rst}`,
            ], 'confirm-skip');
            // Wait for their choice
            const confirmHandler = (k) => {
              if (k === '\t') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeAllListeners('data');
                resolve('skip');
              } else if (k === '\r' || k === '\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeAllListeners('data');
                resolve('edit');
              } else if (k === '\x03') {
                cleanup(); debug.flushAndExit(0); return;
              }
            };
            stdin.removeAllListeners('data');
            stdin.on('data', confirmHandler);
          } else {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeAllListeners('data');
            resolve('skip');
          }
        } else if (key === '\x03') {
          cleanup(); debug.flushAndExit(0); return;
        }
      };
      stdin.on('data', handler);
    });

    if (action === 'continue' || action === 'skip') {
      cleanup();
      return { command, ...result };
    }

    // Rerun: skip the edit phase, go straight to running again
    isFirstRun = false;
    skipEdit = action === 'rerun';
  }
}
