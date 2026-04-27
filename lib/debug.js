import os from 'os';
import { SITE_URL } from './config.js';

// Single in-process log buffer. The CLI is one-shot, so a module-level
// singleton is the right shape — we don't have multiple concurrent runs.
const state = {
  enabled: false,
  entries: [],
  meta: {},
  uploaded: false,
  // Originals saved at init() so we can pass through after recording.
  origStdoutWrite: null,
  origStderrWrite: null,
  // Per-stream rolling buffer for line-based capture. Plan redraws and
  // typeOut() write fragments without newlines — buffering lets us emit
  // one entry per visual line instead of one per character.
  bufStdout: '',
  bufStderr: '',
};

export function isEnabled() {
  return state.enabled;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

function pushLine(stream, line) {
  // Drop empty / whitespace-only lines so the log isn't half blanks.
  if (!line.trim()) return;
  state.entries.push({ at: Date.now(), type: stream, text: line });
}

function wrapStream(stream, name, bufKey, origKey) {
  const orig = stream.write.bind(stream);
  state[origKey] = orig;
  stream.write = (chunk, ...args) => {
    try {
      let str;
      if (typeof chunk === 'string') str = chunk;
      else if (chunk && typeof chunk.toString === 'function') str = chunk.toString('utf8');
      else str = '';
      state[bufKey] += stripAnsi(str);
      let nl;
      while ((nl = state[bufKey].indexOf('\n')) !== -1) {
        const line = state[bufKey].slice(0, nl);
        state[bufKey] = state[bufKey].slice(nl + 1);
        pushLine(name, line);
      }
    } catch {
      // Never let logging break the actual write path.
    }
    return orig(chunk, ...args);
  };
}

/**
 * Initialize debug capture. No-op unless `--debug` is in argv.
 * Returns true when enabled so callers can branch on it.
 */
export function init({ argv }) {
  state.enabled = argv.includes('--debug');
  if (!state.enabled) return false;

  state.meta = {
    cli: 'api',
    command: argv[2] || '',
    argv: argv.slice(2),
    cwd: safeCwd(),
    platform: process.platform,
    nodeVersion: process.version,
    osRelease: os.release(),
    osType: os.type(),
    user: safeUser(),
    hostname: safeHost(),
    startedAt: new Date().toISOString(),
  };

  wrapStream(process.stdout, 'stdout', 'bufStdout', 'origStdoutWrite');
  wrapStream(process.stderr, 'stderr', 'bufStderr', 'origStderrWrite');

  log('init', { meta: state.meta });
  return true;
}

function safeCwd() { try { return process.cwd(); } catch { return ''; } }
function safeUser() { try { return os.userInfo().username; } catch { return ''; } }
function safeHost() { try { return os.hostname(); } catch { return ''; } }

/**
 * Record a structured event. Free-form `data` object is merged onto
 * the entry alongside `at`/`type`. Silent when not in debug mode.
 */
export function log(type, data) {
  if (!state.enabled) return;
  const entry = { at: Date.now(), type };
  if (data && typeof data === 'object') Object.assign(entry, data);
  else if (data !== undefined) entry.value = data;
  state.entries.push(entry);
}

function flushBuffers() {
  if (state.bufStdout) { pushLine('stdout', state.bufStdout); state.bufStdout = ''; }
  if (state.bufStderr) { pushLine('stderr', state.bufStderr); state.bufStderr = ''; }
}

/**
 * POST the captured log to the app. Idempotent — only fires once per
 * process. Returns the server's response body on success, null on any
 * failure (network, non-2xx, etc.). Bounded to 5s so we never hang
 * the user on exit.
 */
export async function flush({ exitCode } = {}) {
  if (!state.enabled || state.uploaded) return null;
  state.uploaded = true;
  flushBuffers();

  const body = {
    meta: { ...state.meta, exitCode: exitCode ?? null, finishedAt: new Date().toISOString() },
    entries: state.entries,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${SITE_URL}/api/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Async exit: flush, then call the real process.exit. Safe to invoke
 * fire-and-forget from sync contexts (event handlers, etc.) — Node
 * will not exit while our pending fetch keeps the loop alive, and
 * the inner exit() lands once flush settles.
 */
export async function flushAndExit(code = 0) {
  if (state.enabled) log('exit', { code });
  await flush({ exitCode: code });
  process.exit(code);
}

/**
 * Wire up signal/error handlers so unexpected paths still upload.
 * Call once, near the top of the entry point.
 */
export function attachExitHandlers() {
  if (!state.enabled) return;

  process.on('beforeExit', async (code) => {
    if (state.uploaded) return;
    log('beforeExit', { code });
    await flush({ exitCode: code });
  });

  process.on('uncaughtException', async (err) => {
    log('uncaughtException', { message: err?.message, stack: err?.stack });
    await flush({ exitCode: 1 });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });
}
