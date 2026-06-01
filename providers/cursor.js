import { spawn } from 'child_process';
import * as debug from '../lib/debug.js';

// Mirrors the truncation budget in providers/claude.js + codex.js so debug
// logs from any provider stay roughly the same size.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

// Match the phase taxonomy used by claude.js / codex.js so the spinner reads
// the same regardless of which agent is running underneath.
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

function describePatch(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  const first = list[0] || 'file';
  return {
    phase: 'Editing files',
    detail: list.length > 1 ? `Edit ${first} (+${list.length - 1} more)` : `Edit ${first}`,
  };
}

/**
 * Classify a cursor-agent tool_call by its name (the single key inside the
 * `tool_call` object, e.g. `editToolCall`). Returns the activity `kind`
 * (which counter it bumps) plus a `{phase, detail}` for the spinner.
 *
 * Confirmed names from probing cursor-agent: readToolCall, editToolCall
 * (covers create + edit), shellToolCall. The rest are best-effort mappings
 * so a new/renamed tool degrades to a sane "Working" line instead of crashing.
 */
function describeTool(name, args = {}) {
  const base = String(name || '').replace(/ToolCall$/, '');
  switch (base) {
    case 'shell':
    case 'terminal':
    case 'runTerminalCmd':
      return { kind: 'exec', status: describeExec(args.command) };
    case 'edit':
    case 'write':
    case 'create':
    case 'applyPatch':
    case 'multiEdit':
    case 'searchReplace':
      return { kind: 'mutation', status: describePatch([args.path]) };
    case 'read':
      return { kind: 'read', status: { phase: 'Reading files', detail: `Read ${args.path || 'file'}` } };
    case 'ls':
    case 'list':
      return { kind: 'read', status: { phase: 'Checking files', detail: `List ${args.path || '.'}` } };
    case 'grep':
    case 'search':
    case 'codebaseSearch':
      return { kind: 'read', status: { phase: 'Searching the code', detail: `Search ${(args.query || args.pattern || '').slice(0, 40)}`.trim() } };
    case 'glob':
    case 'fileSearch':
      return { kind: 'read', status: { phase: 'Looking for files', detail: base } };
    default:
      return { kind: 'other', status: { phase: 'Working', detail: base } };
  }
}

/**
 * Pure reducer over cursor-agent `stream-json` events. Kept separate from the
 * spawn plumbing so it can be unit-tested against captured event fixtures
 * without launching the CLI.
 *
 * The authoritative output is the terminal `result` event's `.result` field
 * (the full, already-concatenated assistant text) - we only fall back to
 * stitched `assistant` events if no result event ever arrives. This sidesteps
 * the duplicate-text class of bug we hit porting codex.
 *
 * Returns a handler you feed one parsed event at a time, plus `finalize()`.
 */
export function createCursorReducer({ onStatus } = {}) {
  const state = {
    resultText: '',
    assistantText: '',
    isError: false,
    execs: 0,
    mutations: 0,
  };
  // Dedupe activity counters across the started/completed lifecycle.
  const counted = new Set();

  function handle(evt) {
    if (!evt || typeof evt !== 'object') return;
    switch (evt.type) {
      case 'system':
        onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
        break;
      case 'assistant': {
        const blocks = evt.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
              state.assistantText += b.text;
              debug.log('ai.text', { text: truncate(b.text, MAX_AI_TEXT) });
            }
          }
        }
        onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
        break;
      }
      case 'tool_call': {
        // Only act on the "started" edge so we count each call once. The
        // tool name is the single key inside `tool_call`.
        if (evt.subtype && evt.subtype !== 'started') break;
        const callId = evt.call_id;
        if (callId && counted.has(callId)) break;
        if (callId) counted.add(callId);
        const name = evt.tool_call && typeof evt.tool_call === 'object' ? Object.keys(evt.tool_call)[0] : undefined;
        const args = (name && evt.tool_call[name]?.args) || {};
        const { kind, status } = describeTool(name, args);
        if (kind === 'exec') {
          state.execs++;
          debug.log('ai.tool_use', { tool: 'Bash', input: { command: truncate(String(args.command || ''), MAX_TOOL_INPUT_FIELD) } });
        } else if (kind === 'mutation') {
          state.mutations++;
          debug.log('ai.tool_use', { tool: 'Edit', input: { path: args.path } });
        } else {
          debug.log('ai.tool_use', { tool: name || 'tool', input: truncateInput(args) });
        }
        onStatus?.(status);
        break;
      }
      case 'result':
        if (typeof evt.result === 'string') state.resultText = evt.result;
        state.isError = evt.is_error === true || (evt.subtype && evt.subtype !== 'success');
        break;
      case 'user':
        break;
      default:
        debug.log('ai.event', { type: evt.type });
    }
  }

  function finalize() {
    return {
      result: state.resultText || state.assistantText,
      execs: state.execs,
      mutations: state.mutations,
      isError: state.isError,
    };
  }

  return { handle, finalize, state };
}

function truncateInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? truncate(v, MAX_TOOL_INPUT_FIELD) : v;
  }
  return out;
}

export default {
  name: 'cursor',

  async run(prompt, cwd, { onStatus } = {}) {
    const reducer = createCursorReducer({ onStatus });

    debug.log('ai.run.start', {
      provider: 'cursor',
      cwd,
      promptChars: prompt?.length ?? 0,
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });

    return new Promise((resolve, reject) => {
      // `cursor-agent --print` runs headless and streams newline-delimited
      // JSON events with `--output-format stream-json`. `--force` allows writes
      // and shell without prompting AND satisfies the workspace-trust gate
      // (confirmed: no separate --trust needed for write runs). `--model auto`
      // lets Cursor route to whatever the user's plan supports rather than
      // pinning a model their subscription may not cover. The prompt is passed
      // as a single positional argument (well under ARG_MAX at ~14KB).
      const args = [
        '--print',
        '--output-format',
        'stream-json',
        '--force',
        '--model',
        'auto',
        '--workspace',
        cwd,
        prompt,
      ];
      let child;
      try {
        child = spawn('cursor-agent', args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (err) {
        reject(new Error(`Failed to spawn cursor-agent: ${err.message}`));
        return;
      }

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
          reducer.handle(evt);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        debug.log('ai.run.end', { provider: 'cursor', error: err.message });
        // ENOENT = `cursor-agent` not on PATH. We gate the menu on this, so
        // this is just a safety net.
        if (err.code === 'ENOENT') {
          reject(new Error(`Cursor CLI not found. Install it from https://cursor.com/install`));
          return;
        }
        reject(new Error(`Failed to spawn cursor-agent: ${err.message}`));
      });

      child.on('close', (code) => {
        // Flush any complete trailing line.
        if (stdoutBuffer.trim()) {
          try { reducer.handle(JSON.parse(stdoutBuffer)); } catch {}
        }
        const { result, execs, mutations, isError } = reducer.finalize();
        debug.log('ai.run.end', {
          provider: 'cursor',
          resultChars: result.length,
          exitCode: code,
          mutations,
          execs,
          isError,
        });
        if (code !== 0) {
          const stderrTail = stderrBuffer.split('\n').slice(-8).join('\n').trim();
          // Auth is the most common first-run failure. Surface a concrete next
          // step instead of dumping raw stderr.
          if (/not\s+logged\s+in|cursor-agent\s+login|api[-_ ]?key|unauthor|trust/i.test(stderrTail)) {
            reject(new Error(`Cursor isn't authenticated (or the workspace isn't trusted). Run \`cursor-agent login\` (or set CURSOR_API_KEY) and try again.`));
            return;
          }
          reject(new Error(`cursor-agent exited with code ${code}${stderrTail ? `:\n${stderrTail}` : ''}`));
          return;
        }
        resolve(result);
      });
    });
  },
};
