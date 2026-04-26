import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, yellow, terminalRunScreen } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { SITE_URL } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';

/**
 * Swap the base URL in a saved curl for the user's localhost. The saved
 * curl was built with the production base, but step 3 wants the user to
 * hit their local dev server, so we rewrite the first http(s) URL.
 */
function rewriteCurlBase(curl, localBase) {
  return curl.replace(/https?:\/\/[^\s/]+/, localBase);
}

/**
 * Scan a handful of common source files for a `.listen(PORT)` call so the
 * default curl hits the right localhost port. Falls back to 3000.
 */
function detectLocalPort(searchDir) {
  try {
    const files = execSync(
      'find . -maxdepth 2 -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.rb" | head -20',
      { cwd: searchDir, encoding: 'utf8' },
    );
    for (const file of files.trim().split('\n').filter(Boolean)) {
      try {
        const content = fs.readFileSync(path.join(searchDir, file), 'utf8');
        const match = content.match(/\.listen\(\s*(\d{4,5})\s*[,)]/) || content.match(/PORT\s*(?:=|:)\s*(\d{4,5})/);
        if (match) return match[1];
      } catch {}
    }
  } catch {}
  return '3000';
}

export default async function testSetup({
  packageDir,
  rootDir,
  apiRootDir,
  update,
  setSpinner,
  domain,
  projectId,
  setupKey,
}) {
  await startStep({
    update,
    stepNum: 3,
    title: 'Test your setup',
    intro: "Now let's make sure everything's wired up.",
    sections: [
      {
        label: 'Why',
        body:
          `Before you ship, you want to see a real request actually flow through\n` +
          `the SDK and land in your dashboard. This catches any wiring mistakes\n` +
          `while they're still cheap to fix.`,
      },
      {
        label: "What we'll do",
        body:
          `Start your server (in another terminal), then we hit the test endpoint\n` +
          `we picked earlier with ${bold('curl')} and watch the log show up live on the\n` +
          `dashboard side.`,
      },
    ],
    action: 'run a test request',
  });

  // The test curl was picked at the end of step 1 (when the OAS was fresh)
  // and saved to .api/settings.json. Read it back and rewrite its base URL
  // to localhost so the user can hit their dev server without editing the
  // command. Falls back to a generic GET / if nothing was saved (e.g. the
  // framework serves OAS at runtime).
  const searchDir = apiRootDir && apiRootDir !== '.' ? path.resolve(packageDir, apiRootDir) : packageDir;
  const localPort = detectLocalPort(searchDir);
  const localBase = `http://localhost:${localPort}`;

  const settings = loadSettings(rootDir);
  const apiEntry = settings.apis?.find((a) => a.rootDir === (apiRootDir || '.')) || settings.apis?.[0];
  let curlCommand = apiEntry?.testCurl
    ? rewriteCurlBase(apiEntry.testCurl, localBase)
    : `curl -sS ${localBase}/`;

  update({ message: [
    `  ${green('✓')} Make sure your server is running on ${bold(localBase)},`,
    dim(`  then hit enter in the box below to fire off the request.`),
  ]});

  // ── Sub 1: Verify — interactive terminal with live log polling ──────────
  const pollConfig = projectId
    ? { url: `${SITE_URL}/api/logs/poll`, projectId, setupKey }
    : null;

  const result = await terminalRunScreen(curlCommand, {
    pollConfig,
    onRun: (cmd) => {
      try {
        let output = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
        // Pretty-print JSON responses when possible.
        try { output = JSON.stringify(JSON.parse(output), null, 2); } catch {}
        return { output, success: true };
      } catch (err) {
        return { output: err.stderr || err.stdout || err.message || '', success: false };
      }
    },
  });

  update({ status: 'done', message: [
    result.success
      ? `  ${green('✓')} Test request succeeded${pollConfig ? ' and logs are flowing' : ''}.`
      : `  ${yellow('⚠')} Request didn't come back clean. Double-check your server's running and try again.`,
  ]});

  return { success: result.success };
}
