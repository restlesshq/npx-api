import readline from 'readline';
import { PassThrough } from 'stream';

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s) => `\x1b[1m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

export function ask(prompt) {
  return new Promise((resolve) => {
    // Reset stdin to a clean state
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('readable');
    process.stdin.resume();

    // Pipe stdin through a clean PassThrough so readline gets a fresh stream
    // (readline's internal state breaks if stdin was previously used in raw mode)
    const pass = new PassThrough();
    process.stdin.pipe(pass);

    const rl = readline.createInterface({
      input: pass,
      output: process.stdout,
      terminal: false,
    });

    process.stdout.write(prompt);

    rl.once('line', (answer) => {
      rl.close();
      process.stdin.unpipe(pass);
      pass.destroy();
      process.stdin.pause();
      resolve(answer);
    });
  });
}

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
        resolve([...selected].sort());
      } else if (key === '\x03') { // ctrl-c
        stdin.setRawMode(false);
        process.exit(0);
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

    function render() {
      clearLines(items.length + 2);
      stdout.write(`  ${bold(message)}\n`);
      for (let i = 0; i < items.length; i++) {
        const pointer = i === cursor ? cyan('❯') : ' ';
        const label = i === cursor ? bold(items[i]) : items[i];
        stdout.write(`  ${pointer} ${label}\n`);
      }
      stdout.write(dim('  ↑/↓ move · enter select\n'));
    }

    // initial draw
    stdout.write(`  ${bold(message)}\n`);
    for (let i = 0; i < items.length; i++) {
      const pointer = i === cursor ? cyan('❯') : ' ';
      const label = i === cursor ? bold(items[i]) : items[i];
      stdout.write(`  ${pointer} ${label}\n`);
    }
    stdout.write(dim('  ↑/↓ move · enter select\n'));

    stdin.on('data', (key) => {
      if (key === '\x1b[A') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === '\x1b[B') {
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        resolve(cursor);
      } else if (key === '\x03') {
        stdin.setRawMode(false);
        process.exit(0);
      }
    });
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
    if (key === '\x03') { stdin.setRawMode(false); stdout.write('\x1b[?25h\n'); process.exit(0); }
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
        process.exit(0);
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

export async function terminalRunScreen(defaultCommand, { onRun, pollConfig } = {}) {
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
          }
        }
      }
    } catch {}
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

    if (logs.length === 0) {
      // Centered title + "Waiting for logs..."
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

      // Show recent logs
      const hintLine = 1; // reserve a line for the continue hint
      const visible = logs.slice(0, maxLogLines - hintLine);
      for (const log of visible) {
        const statusColor = log.status >= 400 ? rc : gc;
        const method = log.method.padEnd(6);
        const status = `${statusColor}${log.status}${rst}`;
        const duration = `${d}${Math.round(log.duration)}ms${rst}`;
        const url = log.url.length > termWidth - 30 ? log.url.substring(0, termWidth - 33) + '...' : log.url;
        lines.push(`  ${d}${method}${rst} ${url} ${status} ${duration}`);
      }

      // Fill remaining (leave last line for hint)
      const remaining = topHeight - lines.length - hintLine;
      for (let i = 0; i < remaining; i++) lines.push('');

      // Continue hint at the bottom of the top half
      lines.push(`  ${d}Press ${rst}${bc}Tab${rst}${d} when you're ready to continue setup${rst}`);
    }

    return lines;
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
        if (key === '\x03') { cleanup(); process.exit(0); }
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
            cleanup(); process.exit(0);
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

    let result = { output: '', success: true };
    if (onRun) {
      result = onRun(command);
    }

    const outputArr = (result.output || '').trim().split('\n');
    const phase = result.success ? 'done' : 'retry';

    // Track successful runs and start polling
    if (result.success) hasSuccessfulRun = true;
    if (result.success && pollConfig) startPolling();

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
                cleanup(); process.exit(0);
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
          cleanup(); process.exit(0);
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
