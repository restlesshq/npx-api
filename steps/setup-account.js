import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, celebrationBanner } from '../lib/ui.js';
import { parseOas } from '../lib/oas-parse.js';
import { loadSettings } from '../lib/settings.js';
import { SITE_URL } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import * as debug from '../lib/debug.js';

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
 * cut us off if they click the URL instead. Uses raw-mode keypress
 * detection rather than readline because readline + rawMode toggling
 * leaves stdin in configurations that interact badly with the rest of
 * the CLI's UI (see the note above `askYesNo` in lib/ui.js).
 */
function waitForEnter() {
  let cancel;
  const promise = new Promise((resolve) => {
    const { stdin } = process;
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('readable');
    try { stdin.setRawMode(true); } catch {}
    stdin.setEncoding('utf8');
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
    };

    const onData = (key) => {
      if (key === '\x03') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      if (key === '\r' || key === '\n') { cleanup(); resolve('enter'); }
      // Ignore everything else - typing in the terminal at this prompt
      // shouldn't do anything except wait for Enter or get pre-empted by
      // the polling success.
    };

    stdin.on('data', onData);

    cancel = () => { cleanup(); resolve(null); };
  });
  return { promise, cancel: () => cancel() };
}

// Count operations (method entries under each path) in a parsed OAS, so the
// completion recap can show a concrete "Mapped N endpoints" number.
const OAS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
function countEndpoints(oas) {
  if (!oas || typeof oas.paths !== 'object' || !oas.paths) return 0;
  let n = 0;
  for (const item of Object.values(oas.paths)) {
    if (item && typeof item === 'object') {
      for (const method of Object.keys(item)) {
        if (OAS_METHODS.has(method.toLowerCase())) n++;
      }
    }
  }
  return n;
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
  // ── Sub 0: Upload OpenAPI specs ─────────────────────────────────
  // Stage everything the server needs BEFORE the user logs in, so the
  // claim flow has nothing left to do but mark the project as theirs.
  // The OAS lands in `PendingOAS` keyed by setupKeyHash; the claim
  // route picks it up after auth completes.
  const settings = loadSettings(rootDir);
  const apiEntry = pickApiEntry(settings, apiRootDir);
  const oasFile = apiEntry?.oasFile;
  const oasPath = oasFile ? path.join(rootDir, oasFile) : null;
  const hasLocalOas = !!(oasPath && fs.existsSync(oasPath));

  update({ status: 'active', activeSub: 0, message: hasLocalOas
    ? [`  Uploading ${bold(oasFile)} to your account.`]
    : [dim('  No local OpenAPI spec found to upload.')],
  });

  let endpointCount = 0;
  if (hasLocalOas) {
    setSpinner?.('Uploading OpenAPI spec');
    try {
      const oasRaw = fs.readFileSync(oasPath, 'utf8');
      const isJson = oasPath.endsWith('.json');
      // Count endpoints off the same bytes we're uploading, for the recap.
      try {
        const parsed = parseOas(oasRaw, isJson ? 'json' : 'yaml');
        if (parsed.ok) endpointCount = countEndpoints(parsed.oas);
      } catch {}
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
        update({ status: 'failed', message: [
          `  ${red('✗')} OAS upload failed (HTTP ${uploadRes.status}).`,
          errText ? dim(`  ${errText.slice(0, 200)}`) : null,
          dim(`  Endpoint: ${SITE_URL}/api/projects/${projectId}/oas`),
        ].filter(Boolean) });
        return { apiKey };
      }
    } catch (err) {
      setSpinner?.('');
      update({ status: 'failed', message: [
        `  ${red('✗')} OAS upload error: ${err.message}`,
      ]});
      return { apiKey };
    }
  }

  // Upload the FULL `.restless/settings.json`. We send the whole
  // file (not just this api's entry) so the server has the full
  // workspace context - other apis in the file, top-level
  // version/config, etc. The UI cherry-picks the entry matching
  // this projectId (by its `id` in the apis[] array - though for
  // request-id-prefix display, the matching apiEntry suffices).
  // Non-fatal on failure: the project still claims, just without
  // the settings blob attached. We log + warn rather than abort.
  if (settings && Array.isArray(settings.apis) && settings.apis.length) {
    setSpinner?.('Uploading project settings');
    try {
      const settingsRes = await fetch(
        `${SITE_URL}/api/projects/${projectId}/settings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setup_key: setupKey,
            settings,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      setSpinner?.('');
      if (!settingsRes.ok) {
        const errText = await settingsRes.text().catch(() => '');
        update({ message: [
          `  ${dim('!')} Settings upload skipped (HTTP ${settingsRes.status}).`,
          errText ? dim(`    ${errText.slice(0, 200)}`) : null,
        ].filter(Boolean) });
      }
    } catch (err) {
      setSpinner?.('');
      update({ message: [
        `  ${dim('!')} Settings upload skipped: ${err.message}`,
      ]});
    }
  }

  // ── Sub 1: Log in to claim the project ──────────────────────────
  // Hand the project + setupKey to the server up front, keyed by an
  // opaque token. The login URL we display only needs that token, so
  // the setupKey never lands in browser history, the OAuth referer,
  // the user's terminal scrollback, or screen shares.
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
      update({ sub: { 0: 'done' }, status: 'failed', message: [
        `  ${red('✗')} Couldn't prepare login link (HTTP ${startRes.status}).`,
        text ? dim(`  ${text.slice(0, 200)}`) : null,
      ].filter(Boolean) });
      return { apiKey };
    }
  } catch (err) {
    setSpinner?.('');
    update({ sub: { 0: 'done' }, status: 'failed', message: [
      `  ${red('✗')} Couldn't reach ${SITE_URL} to prepare the login link.`,
      dim(`  ${err.message}`),
    ]});
    return { apiKey };
  }
  setSpinner?.('');
  // Short form of `/login?token=<token>`; the site redirects it there.
  // People retype this out of a terminal, so keep it as short as possible.
  const loginUrl = `${SITE_URL}/init/${token}`;

  const uploadDoneLine = hasLocalOas
    ? `  ${green('✓')} Uploaded ${bold(oasFile)}.`
    : null;

  // A concrete recap of what the setup actually accomplished. Shown on the
  // completion screen so the final step reads as a payoff with real numbers,
  // not just another identical-looking intermediate step.
  const recap = [
    `  ${bold('Here’s what you set up:')}`,
    `    ${green('✓')} ${endpointCount
      ? `Mapped ${bold(String(endpointCount))} endpoint${endpointCount === 1 ? '' : 's'}`
      : 'Mapped your API'}`,
    `    ${green('✓')} Installed and wired the Restless SDK`,
    hasLocalOas ? `    ${green('✓')} Uploaded ${bold(oasFile)}` : null,
  ].filter(Boolean);

  // Non-interactive (agent / CI): claiming the project is a human action -
  // it needs a browser login that no one is here to complete, and the auth
  // poll below is unbounded, so racing it would hang forever. The OAS +
  // settings are already uploaded, so the project is fully staged; hand back
  // the claim URL and finish cleanly instead of blocking.
  if (!isInteractive()) {
    update({ status: 'done', sub: { 0: 'done', 1: 'done' }, message: [
      uploadDoneLine,
      uploadDoneLine ? '' : null,
      `  ${green('✓')} SDK is installed and your spec is uploaded.`,
      `  Claim your project on Restless when you're ready (opens a browser login):`,
      '',
      `    ${cyan(loginUrl)}`,
    ].filter((l) => l !== null) });
    debug.log('setup-account.noninteractive', { claimed: false });
    return { apiKey };
  }

  // All the setup work is done - the only thing left is the human action of
  // claiming the project. Mark the step tree complete (all green, no in-progress
  // arrow), celebrate, and frame the login as claiming a reward. The CTA is the
  // hero (bright-green + bold, brightest thing on screen); the URL is demoted to
  // a dim fallback below it.
  update({ status: 'done', sub: { 0: 'done', 1: 'done' }, message: [
    ...celebrationBanner(`🎉  ${bold('Setup complete')} — your API is ready to claim`),
    '',
    ...recap,
    '',
    `  ${green(bold('❯ Press Enter to open your browser and log in'))}`,
    '',
    dim('  Didn’t open? Paste this link instead:'),
    `  ${dim(loginUrl)}`,
  ] });

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
    // Keep the completed step tree (status stays done) so the payoff doesn't
    // snap back to an in-progress look while we wait on the browser login.
    update({ status: 'done', message: [
      ...celebrationBanner(`🎉  ${bold('Setup complete')} — one last step to claim it`),
      '',
      `  ${green(bold('❯ Opening your browser…'))}`,
      // No second glyph: a bare ❯ under the line reads as an input prompt
      // waiting on you, when the only thing left is to finish in the browser.
      `  ${dim('You can finish the setup there!')}`,
      '',
      dim('  Didn’t open? Paste this link instead:'),
      `  ${dim(loginUrl)}`,
    ] });
    process.stdin.resume();
    result = await pollPromise;
    process.stdin.pause();
  } else {
    enter.cancel();
    result = winner.value;
  }
  pollAbort.abort();

  const { email, slug } = result;

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    uploadDoneLine,
    `  ${green('✓')} Logged in as ${bold(email)}.`,
    `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
    '',
    '',
    `  ${bold('Next steps:')}`,
    '',
    `    Commit your changes and deploy.`,
    // All one dim line - a cyan `.restless/` inside it would render
    // dim-cyan, which is muddier than just leaving it gray.
    `    ${dim('Include the .restless/ folder so your team and CI use the same config.')}`,
    '',
    // `uploadDoneLine` is conditionally null, but the blank separators are
    // real content - filtering on truthiness dropped them and jammed this
    // whole block against the checkmarks above it.
  ].filter((l) => l !== null && l !== undefined) });

  return { apiKey, email, slug };
}
