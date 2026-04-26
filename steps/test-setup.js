import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, yellow, cyan, terminalRunScreen } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { SITE_URL } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';
import {
  loadOas,
  getAuthForOperation,
  curlHasAuth,
  authToCurlFragment,
  parseCurl,
} from '../lib/oas-auth.js';

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

/**
 * If the LLM-picked curl is missing the auth the OAS says the endpoint
 * requires, append it. Keeps `API_KEY_HERE` at the end so the user can
 * still edit it in one spot.
 */
function ensureCurlHasAuth(curlCommand, rootDir) {
  try {
    const settings = loadSettings(rootDir);
    const oasApi = settings.apis?.[0];
    if (!oasApi?.oasFile) return curlCommand;
    const oas = loadOas(path.join(rootDir, oasApi.oasFile));
    if (!oas) return curlCommand;

    const parsed = parseCurl(curlCommand);
    if (!parsed) return curlCommand;

    const auth = getAuthForOperation(oas, parsed.method, parsed.path);
    if (!auth || curlHasAuth(curlCommand, auth)) return curlCommand;

    const fragment = authToCurlFragment(auth);
    if (!fragment) return curlCommand;
    return `${curlCommand.trimEnd()} ${fragment}`;
  } catch {
    return curlCommand;
  }
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
  aiTool = 'Claude Code',
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
          `Start your server (in another terminal), then ${cyan(aiTool)} picks a safe\n` +
          `GET endpoint from your OpenAPI spec, we hit it with ${bold('curl')}, and\n` +
          `watch the log show up live on the dashboard side.`,
      },
    ],
    action: 'run a test request',
  });

  // ── Sub 0: Find test endpoint ────────────────────────────────────────────
  update({ activeSub: 0, message: [
    `  Picking a safe endpoint from your OpenAPI spec.`,
    dim('  Prefer GETs, fill in path params with example values, include auth if the spec declares it.'),
  ]});

  const searchDir = apiRootDir && apiRootDir !== '.' ? path.resolve(packageDir, apiRootDir) : packageDir;
  const localPort = detectLocalPort(searchDir);
  const localBase = `http://localhost:${localPort}`;

  let curlCommand = `curl -sS ${localBase}/`;
  try {
    const aiResult = await runAI(loadPrompt('find-test-endpoint'), rootDir, { setSpinner });
    const jsonMatch = aiResult.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.curl) curlCommand = parsed.curl.replace(/BASE_URL_HERE/g, localBase);
    }
  } catch {}

  // The LLM is unreliable about including auth — sometimes omits the header
  // even when the spec requires it. Parse the OAS ourselves and patch in the
  // required auth if it's missing, so the curl the user sees matches what the
  // endpoint actually wants.
  curlCommand = ensureCurlHasAuth(curlCommand, rootDir);

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    `  ${green('✓')} Found an endpoint. Make sure your server is running on ${bold(localBase)},`,
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

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    result.success
      ? `  ${green('✓')} Test request succeeded${pollConfig ? ' and logs are flowing' : ''}.`
      : `  ${yellow('⚠')} Request didn't come back clean. Double-check your server's running and try again.`,
  ]});

  return { success: result.success };
}
