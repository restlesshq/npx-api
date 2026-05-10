import { spawn } from 'child_process';
import * as debug from '../lib/debug.js';

// Mirrors the truncation budget in providers/claude.js so debug logs from
// either provider stay roughly the same size.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

// Match the phase taxonomy used by claude.js so the spinner reads the same
// regardless of which agent is actually running underneath.
function describeExec(rawCommand) {
  const raw = (Array.isArray(rawCommand) ? rawCommand.join(' ') : String(rawCommand || ''))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ');
  let phase = 'Running commands';
  if (/^(npm|pnpm|yarn|bun|pip|gem|go|cargo)\s/.test(raw)) phase = 'Installing packages';
  else if (/^(ls|cat|find|head|tail|rg|grep)\s/.test(raw)) phase = 'Checking files';
  else if (/^curl\s/.test(raw)) phase = 'Making requests';
  else if (/^mkdir\s/.test(raw)) phase = 'Creating directories';
  return {
    phase,
    detail: `Bash ${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}`,
  };
}

function describePatch(changes) {
  const paths = Object.keys(changes || {});
  const first = paths[0] || 'file';
  return {
    phase: 'Editing files',
    detail: paths.length > 1 ? `Edit ${first} (+${paths.length - 1} more)` : `Edit ${first}`,
  };
}

export default {
  name: 'codex',

  async run(prompt, cwd, { onStatus } = {}) {
    let result = '';
    debug.log('ai.run.start', {
      provider: 'codex',
      cwd,
      promptChars: prompt?.length ?? 0,
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });

    return new Promise((resolve, reject) => {
      // `codex exec --json` runs non-interactively and streams newline-delimited
      // protocol events on stdout. `--full-auto` = workspace-write sandbox with
      // on-failure approvals, the closest match to how we run Claude here. We
      // pass the prompt through stdin so multi-line prompts (which most of
      // ours are) don't get mangled by the shell.
      const args = ['exec', '--json', '--full-auto', '-C', cwd, '-'];
      let child;
      try {
        child = spawn('codex', args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (err) {
        reject(new Error(`Failed to spawn codex: ${err.message}`));
        return;
      }

      child.stdin.write(prompt);
      child.stdin.end();

      let stdoutBuffer = '';
      let stderrBuffer = '';

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // keep trailing partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          handleEvent(evt);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        debug.log('ai.run.end', { provider: 'codex', error: err.message });
        // ENOENT = `codex` not on PATH. We already gate the menu on this, so
        // this fallback is just a safety net.
        if (err.code === 'ENOENT') {
          reject(new Error(`Codex CLI not found. Install with: npm install -g @openai/codex`));
          return;
        }
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });

      child.on('close', (code) => {
        debug.log('ai.run.end', { provider: 'codex', resultChars: result.length, exitCode: code });
        if (code !== 0) {
          const stderrTail = stderrBuffer.split('\n').slice(-8).join('\n').trim();
          // Auth is the most common first-run failure. Surface a concrete next
          // step instead of dumping the raw stderr.
          if (/not\s+logged\s+in|please\s+run\s+codex\s+login|api[-_ ]?key|unauthor/i.test(stderrTail)) {
            reject(new Error(`Codex isn't authenticated. Run \`codex login\` (or set OPENAI_API_KEY) and try again.`));
            return;
          }
          reject(new Error(`Codex exited with code ${code}${stderrTail ? `:\n${stderrTail}` : ''}`));
          return;
        }
        resolve(result);
      });

      function handleEvent(evt) {
        // Codex protocol events look like { id, msg: { type, ... } }. Older
        // releases used a flatter shape, so accept either.
        const type = evt.msg?.type ?? evt.type;
        const data = evt.msg ?? evt;
        if (!type) return;

        switch (type) {
          case 'agent_message_delta':
          case 'agent_message': {
            const text = data.delta ?? data.message ?? '';
            if (text) result += text;
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            if (text) debug.log('ai.text', { text: truncate(text, MAX_AI_TEXT) });
            break;
          }
          case 'agent_reasoning_delta':
          case 'agent_reasoning':
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            break;
          case 'exec_command_begin': {
            onStatus?.(describeExec(data.command));
            const cmdStr = Array.isArray(data.command) ? data.command.join(' ') : data.command;
            debug.log('ai.tool_use', { tool: 'Bash', input: { command: truncate(cmdStr, MAX_TOOL_INPUT_FIELD) } });
            break;
          }
          case 'patch_apply_begin': {
            onStatus?.(describePatch(data.changes));
            debug.log('ai.tool_use', { tool: 'Patch', input: { paths: Object.keys(data.changes || {}) } });
            break;
          }
          case 'mcp_tool_call_begin':
            onStatus?.({ phase: 'Working', detail: data.tool || data.server || 'Tool call' });
            break;
          case 'error':
            // Don't reject - Codex sometimes recovers within a turn. The
            // process exit code will tell us if the run actually failed.
            debug.log('ai.error', { message: truncate(data.message || JSON.stringify(data), 500) });
            break;
          default:
            // Unrecognized event - log it so we can extend the mapping if a
            // new event type appears in a future Codex release.
            debug.log('ai.event', { type });
        }
      }
    });
  },
};
