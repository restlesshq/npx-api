import crypto from 'crypto';
import { execSync } from 'child_process';
import { bold, dim, green, cyan, ask } from '../lib/ui.js';
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

export default async function setupAccount({ rootDir, update, apiKey, projectId, setupKey }) {
  const settings = loadSettings(rootDir);
  const specCount = settings.apis.length;
  const specNames = settings.apis.map(a => a.name).join(', ');

  // API key was already generated and shown before the test step
  update({ status: 'active', activeSub: 0, sub: { 0: 'done' }, activeSub: 1, message: [
    `  ${green('✓')} API key already configured.`,
  ]});

  // ── Log in to claim the project ─────────────────────────────────
  const token = crypto.randomBytes(16).toString('hex');
  const loginUrl = `${SITE_URL}/login?token=${token}&projectId=${encodeURIComponent(projectId)}&setupKey=${encodeURIComponent(setupKey)}`;

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    '  Now log in to claim your project on Restless.',
    '',
    `    ${cyan(loginUrl)}`,
    '',
    dim('  Press Enter to open in your browser.'),
  ]});

  await ask('');
  openBrowser(loginUrl);

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    '  Waiting for you to log in...',
    '',
    dim('  Complete the login in your browser. We\'ll continue automatically.'),
  ]});

  // Keep stdin flowing during polling so stray keypresses don't cause issues
  process.stdin.resume();

  const result = await pollForAuth(token);

  process.stdin.pause();

  const { email, slug } = result;

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    `  ${green('✓')} Logged in as ${bold(email)}.`,
    `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
  ]});

  return { apiKey, email, slug };
}
