import os from 'os';
import { SITE_URL } from './config.js';

// Single in-process log buffer. The CLI is one-shot, so a module-level
// singleton is the right shape - we don't have multiple concurrent runs.
//
// We deliberately do NOT mirror stdout/stderr into the log. The CLI's
// terminal UI is animation-heavy (typing effects, plan redraws, spinner
// frames) - capturing every write produced 25k+ entries of mostly
// useless ANSI artifacts. Instead, every meaningful moment is emitted
// as a structured event (input.*, ai.*, step.*, error, etc.) by the
// surface that owns it.
const state = {
  enabled: false,
  entries: [],
  meta: {},
  uploaded: false,
};

export function isEnabled() {
  return state.enabled;
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

  log('init', { meta: state.meta });
  return true;
}

function safeCwd() { try { return process.cwd(); } catch { return ''; } }
function safeUser() { try { return os.userInfo().username; } catch { return ''; } }
function safeHost() { try { return os.hostname(); } catch { return ''; } }

/**
 * Defense-in-depth redaction. Architecture already keeps the
 * RESTLESS_KEY out of every code path that feeds debug.log - it's
 * generated in pure Node, written to .env via `fs.appendFileSync` (not
 * an AI Write tool), and every AI prompt explicitly forbids reading
 * `.env*`. But a misbehaving model could still quote the key inside
 * an `ai.text` block. Run every string value through these patterns
 * before storing so even that path can't leak.
 *
 * Patterns are intentionally narrow (specific prefixes, named headers,
 * named env vars) to keep false-positive redactions out of the log.
 */
const REDACTORS = [
  // Our own key format - `rdme_` + 64 hex chars. Strict length match.
  [/rdme_[a-f0-9]{32,}/gi, 'rdme_[REDACTED]'],
  // `RESTLESS_KEY=...` / `API_KEY=...` / `SECRET=...` env-var assignments.
  [/\b(RESTLESS_[A-Z0-9_]+|API[_-]?KEY|SECRET[_A-Z0-9]*|TOKEN[_A-Z0-9]*|PASSWORD)\s*=\s*[^\s\n'"`]+/gi, '$1=[REDACTED]'],
  // `Authorization: Bearer ...` / `X-Api-Key: ...` headers (common shapes).
  [/\b(Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|Proxy-Authorization)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  // Bare `Bearer xxxx` tokens that aren't behind a named header.
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}/g, 'Bearer [REDACTED]'],
];

function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, replacement] of REDACTORS) out = out.replace(re, replacement);
  return out;
}

function redactDeep(value) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
  return out;
}

/**
 * Record a structured event. Free-form `data` object is merged onto
 * the entry alongside `at`/`type`. Silent when not in debug mode.
 * All string values are run through `redactString` first.
 */
export function log(type, data) {
  if (!state.enabled) return;
  const entry = { at: Date.now(), type };
  if (data && typeof data === 'object') Object.assign(entry, redactDeep(data));
  else if (data !== undefined) entry.value = redactDeep(data);
  state.entries.push(entry);
}

/**
 * POST the captured log to the app. Idempotent - only fires once per
 * process. Always prints a short status line to stderr in debug mode
 * so the user can see whether the upload landed; without that the
 * common "wrong SITE_URL" failure mode looks like a no-op.
 *
 * Bounded to 5s so we never hang the user on exit. stderr (not stdout)
 * because we may already be in the middle of normal user-facing
 * output and shouldn't pollute pipes.
 */
export async function flush({ exitCode } = {}) {
  if (!state.enabled || state.uploaded) return null;
  state.uploaded = true;

  // Don't surface the upload endpoint to the user - it's internal
  // infrastructure. The diagnostic is just enough to confirm that
  // "yes, the log was sent" or "no, here's why it failed."
  const url = `${SITE_URL}/api/debug`;
  const body = {
    meta: { ...state.meta, exitCode: exitCode ?? null, finishedAt: new Date().toISOString() },
    entries: state.entries,
  };
  const payload = JSON.stringify(body);

  const writeErr = (s) => process.stderr.write(s);
  writeErr(`\n  \x1b[2m⤴  Uploading debug log (${state.entries.length} entries, ${(payload.length / 1024).toFixed(1)} KB)…\x1b[0m\n`);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      writeErr(`  \x1b[31m✗\x1b[0m \x1b[2mDebug upload failed (HTTP ${res.status}).\x1b[0m\n`);
      return null;
    }
    const data = await res.json().catch(() => null);
    writeErr(`  \x1b[32m✓\x1b[0m \x1b[2mDebug log uploaded.\x1b[0m\n`);
    return data;
  } catch (err) {
    // Generic message - no URL, no host. Network detail goes nowhere
    // useful for the user, and "is the app running" hints can leak
    // dev URLs in screenshots / pastes.
    const timedOut = err?.name === 'AbortError';
    writeErr(`  \x1b[31m✗\x1b[0m \x1b[2mDebug upload failed${timedOut ? ' (timed out)' : ''}.\x1b[0m\n`);
    return null;
  }
}

/**
 * Async exit: flush, then call the real process.exit. Safe to invoke
 * fire-and-forget from sync contexts (event handlers, etc.) - Node
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
