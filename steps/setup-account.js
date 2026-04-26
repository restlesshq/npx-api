import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan } from '../lib/ui.js';
import { loadSettings } from '../lib/settings.js';
import { SITE_URL } from '../lib/config.js';

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`);
    else if (process.platform === 'win32') execSync(`start "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}

/**
 * Poll the auth-check endpoint until the user finishes logging in. If the
 * AbortSignal fires we resolve to `null` so the caller can keep racing
 * other promises without an unhandled rejection.
 */
async function pollForAuth(token, signal) {
  const pollUrl = `${SITE_URL}/api/auth/check?token=${token}`;
  while (!signal?.aborted) {
    try {
      const res = await fetch(pollUrl, { signal });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete') return data;
      }
    } catch {
      if (signal?.aborted) return null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * Wait for the user to press Enter, but stay cancellable so polling can
 * cut us off if they click the URL instead. The returned `cancel()` closes
 * the readline interface and resolves the promise with `null`.
 */
function waitForEnter() {
  let cancel;
  const promise = new Promise((resolve) => {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('readable');
    process.stdin.resume();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.once('SIGINT', () => { rl.close(); process.stdout.write('\n'); process.exit(130); });
    rl.question('', () => { rl.close(); process.stdin.pause(); resolve('enter'); });

    cancel = () => { rl.close(); process.stdin.pause(); resolve(null); };
  });
  return { promise, cancel: () => cancel() };
}

// Find the API entry whose rootDir matches apiRootDir, falling back to the
// first one if there's no match (typical single-API setup).
function pickApiEntry(settings, apiRootDir) {
  const key = apiRootDir || '.';
  return settings.apis.find((a) => (a.rootDir || '.') === key) || settings.apis[0];
}

export default async function setupAccount({
  rootDir,
  apiRootDir,
  update,
  setSpinner,
  apiKey,
  projectId,
  setupKey,
}) {
  // ── Sub 0: Log in to claim the project ──────────────────────────
  // Hand the project + setupKey to the server up front, keyed by an
  // opaque token. The login URL we display only needs that token, so the
  // setupKey never lands in browser history, the OAuth referer, the
  // user's terminal scrollback, or screen shares.
  const token = crypto.randomBytes(16).toString('hex');
  setSpinner?.('Preparing login link');
  try {
    const startRes = await fetch(`${SITE_URL}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, projectId, setupKey }),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      setSpinner?.('');
      update({ status: 'failed', message: [
        `  ${red('✗')} Couldn't prepare login link (HTTP ${startRes.status}).`,
        text ? dim(`  ${text.slice(0, 200)}`) : null,
      ].filter(Boolean) });
      return { apiKey };
    }
  } catch (err) {
    setSpinner?.('');
    update({ status: 'failed', message: [
      `  ${red('✗')} Couldn't reach ${SITE_URL} to prepare the login link.`,
      dim(`  ${err.message}`),
    ]});
    return { apiKey };
  }
  setSpinner?.('');
  const loginUrl = `${SITE_URL}/login?token=${token}`;

  update({ status: 'active', activeSub: 0, message: [
    '  Now log in to claim your project on Restless.',
    '',
    `    ${cyan(loginUrl)}`,
    '',
    dim('  Press Enter to open in your browser, or click the link above.'),
  ]});

  // Race the Enter prompt against polling: if the user clicks the link
  // directly (skipping Enter), polling finishes first and we cancel the
  // prompt; if they press Enter, we open the browser and keep polling.
  const pollAbort = new AbortController();
  const pollPromise = pollForAuth(token, pollAbort.signal);
  const enter = waitForEnter();

  const winner = await Promise.race([
    enter.promise.then((v) => ({ kind: 'enter', value: v })),
    pollPromise.then((v) => ({ kind: 'poll', value: v })),
  ]);

  let result;
  if (winner.kind === 'enter') {
    openBrowser(loginUrl);
    update({ activeSub: 0, message: [
      '  Waiting for you to log in...',
      '',
      dim('  Complete the login in your browser. We\'ll continue automatically.'),
    ]});
    process.stdin.resume();
    result = await pollPromise;
    process.stdin.pause();
  } else {
    enter.cancel();
    result = winner.value;
  }
  pollAbort.abort();

  const { email, slug } = result;

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    `  ${green('✓')} Logged in as ${bold(email)}.`,
    `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
  ]});

  // ── Sub 1: Upload OpenAPI specs ─────────────────────────────────
  const settings = loadSettings(rootDir);
  const apiEntry = pickApiEntry(settings, apiRootDir);
  const oasFile = apiEntry?.oasFile;
  const oasPath = oasFile ? path.join(rootDir, oasFile) : null;

  if (!oasPath || !fs.existsSync(oasPath)) {
    // No local OAS file (framework serves it natively, or nothing was generated).
    update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
      `  ${green('✓')} Logged in as ${bold(email)}.`,
      `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
      dim('  No local OpenAPI spec to upload — your framework serves it at runtime.'),
    ]});
    return { apiKey, email, slug };
  }

  update({ activeSub: 1, message: [
    `  Uploading ${bold(oasFile)} to your account.`,
  ]});
  setSpinner?.('Uploading OpenAPI spec');

  try {
    const oasRaw = fs.readFileSync(oasPath, 'utf8');
    const isJson = oasPath.endsWith('.json');
    const uploadRes = await fetch(`${SITE_URL}/api/projects/${projectId}/oas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_key: setupKey,
        oas_raw: oasRaw,
        format: isJson ? 'json' : 'yaml',
      }),
      signal: AbortSignal.timeout(10000),
    });
    setSpinner?.('');
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      update({ sub: { 0: 'done' }, activeSub: 1, status: 'failed', message: [
        `  ${green('✓')} Logged in as ${bold(email)}.`,
        `  ${red('✗')} OAS upload failed (HTTP ${uploadRes.status}).`,
        errText ? dim(`  ${errText.slice(0, 200)}`) : null,
        dim(`  Endpoint: ${SITE_URL}/api/projects/${projectId}/oas`),
      ].filter(Boolean) });
      return { apiKey, email, slug };
    }
  } catch (err) {
    setSpinner?.('');
    update({ sub: { 0: 'done' }, activeSub: 1, status: 'failed', message: [
      `  ${green('✓')} Logged in as ${bold(email)}.`,
      `  ${red('✗')} OAS upload error: ${err.message}`,
    ]});
    return { apiKey, email, slug };
  }

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    `  ${green('✓')} Logged in as ${bold(email)}.`,
    `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
    `  ${green('✓')} OpenAPI spec uploaded.`,
  ]});

  return { apiKey, email, slug };
}
