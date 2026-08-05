import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, cyan, green, red, startSpinner } from './ui.js';
import { SITE_URL, CLI_NAME } from './config.js';

/**
 * The device-auth token every post-claim write uses.
 *
 * Once a project is claimed, the setup key is spent (the server deletes its
 * copy at claim time), so `update` proves itself with a browser-approved
 * token instead. Tokens last 24h, so a developer running `npx api update`
 * repeatedly during the day sees the browser once.
 *
 * Extracted from the `update` command because there is now more than one
 * thing to push: the settings blob and the spec. Both need the same token,
 * and neither should re-implement the handshake.
 */

/** Where per-project credentials live: the user's home dir, never the repo,
 *  so they don't travel with the code. */
function credsFileFor(projectId) {
  return path.join(os.homedir(), '.restless', 'projects', `${projectId}.json`);
}

// 60s buffer so we don't try to use a token that's about to expire
// mid-request.
const CACHE_BUFFER_MS = 60 * 1000;

/** A cached token that is still comfortably valid, or null. */
export function loadCachedToken(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credsFileFor(projectId), 'utf8'));
    const expiresAt = parsed?.expiresAt ? Date.parse(parsed.expiresAt) : 0;
    if (typeof parsed?.token === 'string' && expiresAt - CACHE_BUFFER_MS > Date.now()) {
      return { token: parsed.token, expiresAt };
    }
  } catch {}
  return null;
}

export function saveCachedToken(projectId, token, expiresAt) {
  const file = credsFileFor(projectId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Merge, don't overwrite: this file is shared with the setup key that
    // `api key` stores for the same project (same path by design - one file
    // per project). A blind write here would drop it and leave `api login`
    // unable to prove ownership.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    fs.writeFileSync(
      file,
      JSON.stringify({ ...existing, token, projectId, expiresAt }, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch (err) {
    // Non-fatal - we'll just re-do the browser dance next time.
    console.log(dim(`  ! Couldn't cache CLI token at ${file}: ${err.message}`));
  }
}

/** Drop a token the server has rejected, so the next run re-authorizes. */
export function clearCachedToken(projectId) {
  try { fs.unlinkSync(credsFileFor(projectId)); } catch {}
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    // Best-effort - the URL is printed either way.
  }
}

/**
 * Get a usable token for this project, reusing the cached one when possible
 * and otherwise running the browser handshake.
 *
 * Returns `{ ok: true, token, cached }`, or `{ ok: false, reason, error }`
 * with `reason` one of 'start-failed' | 'unreachable' | 'expired' | 'timeout'.
 * Never exits the process: callers decide whether a missing token is fatal
 * (pushing a change) or merely means "not synced yet" (a non-interactive run
 * that still wrote its local edits).
 */
export async function getCliToken({ projectId, interactive = true }) {
  const cached = loadCachedToken(projectId);
  if (cached) return { ok: true, token: cached.token, cached: true };

  if (!interactive) {
    return {
      ok: false,
      reason: 'timeout',
      error: 'No authorized CLI session, and approving one needs a browser.',
    };
  }

  const token = crypto.randomBytes(32).toString('hex');

  // Step 1: register the token + projectId on the site.
  try {
    const startRes = await fetch(`${SITE_URL}/api/auth/cli/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, projectId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      return {
        ok: false,
        reason: 'start-failed',
        error: `Couldn't start CLI auth (HTTP ${startRes.status}).${text ? ` ${text.slice(0, 200)}` : ''}`,
      };
    }
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: `Couldn't reach ${SITE_URL}: ${err.message}` };
  }

  // Step 2: open the browser and ask the user to approve. The URL is printed
  // too, in case the browser didn't open (SSH session, dev container).
  const authUrl = `${SITE_URL}/api/auth/cli?token=${token}`;
  console.log('');
  console.log(`  ${bold('Authorize this CLI session in your browser.')}`);
  console.log('');
  console.log(`    ${cyan(authUrl)}`);
  console.log('');
  console.log(dim('  The session is good for 24 hours after you approve.'));
  console.log('');
  openBrowser(authUrl);

  // Step 3: poll until approved (or the token expires).
  const pollSpinner = startSpinner('Waiting for approval');
  const POLL_INTERVAL_MS = 2000;
  const POLL_DEADLINE = Date.now() + 10 * 60 * 1000; // matches the server's 10m pending TTL
  let approvedExpiresAt = null;
  while (Date.now() < POLL_DEADLINE) {
    try {
      const checkRes = await fetch(`${SITE_URL}/api/auth/cli/check?token=${token}`, {
        cache: 'no-store',
      });
      if (checkRes.status === 410) {
        pollSpinner.stop();
        return {
          ok: false,
          reason: 'expired',
          error: 'The auth token expired before you approved it.',
        };
      }
      if (checkRes.ok) {
        const data = await checkRes.json();
        if (data.status === 'authorized') {
          approvedExpiresAt = Date.parse(data.expiresAt);
          break;
        }
      }
    } catch {
      // Network blip - keep polling within the deadline.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  pollSpinner.stop();

  if (!approvedExpiresAt) {
    return { ok: false, reason: 'timeout', error: 'Timed out waiting for browser approval.' };
  }

  saveCachedToken(projectId, token, new Date(approvedExpiresAt).toISOString());
  console.log(green(`  ✓ CLI authorized.`));
  return { ok: true, token, cached: false };
}

/**
 * Print the standard explanation for a token we couldn't get. Kept here so
 * every caller phrases the same failure the same way.
 */
export function reportTokenFailure(res) {
  console.log('');
  console.log(red(`  ✗ ${res.error}`));
  if (res.reason === 'expired' || res.reason === 'timeout') {
    console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} update`)} when you're ready.`));
  }
  console.log('');
}
