import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, ask } from '../lib/ui.js';
import { loadSettings } from '../lib/settings.js';
import { SITE_URL } from '../lib/config.js';

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`);
    else if (process.platform === 'win32') execSync(`start "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}

async function pollForAuth(token) {
  const pollUrl = `${SITE_URL}/api/auth/check?token=${token}`;
  while (true) {
    try {
      const res = await fetch(pollUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete') {
          return data;
        }
      }
    } catch {
      // Site might not be up yet, keep trying
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
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
  const token = crypto.randomBytes(16).toString('hex');
  const loginUrl = `${SITE_URL}/login?token=${token}&projectId=${encodeURIComponent(projectId)}&setupKey=${encodeURIComponent(setupKey)}`;

  update({ status: 'active', activeSub: 0, message: [
    '  Now log in to claim your project on Restless.',
    '',
    `    ${cyan(loginUrl)}`,
    '',
    dim('  Press Enter to open in your browser.'),
  ]});

  await ask('');
  openBrowser(loginUrl);

  update({ activeSub: 0, message: [
    '  Waiting for you to log in...',
    '',
    dim('  Complete the login in your browser. We\'ll continue automatically.'),
  ]});

  // Keep stdin flowing during polling so stray keypresses don't cause issues
  process.stdin.resume();

  const result = await pollForAuth(token);

  process.stdin.pause();

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
