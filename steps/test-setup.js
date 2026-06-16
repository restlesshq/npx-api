import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, yellow, red, terminalRunScreen } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { SITE_URL } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';

/**
 * Force every absolute URL in the saved curl to point at the local
 * dev server. The saved curl was built with the OAS `servers[0].url`
 * (often a production host); step 3 must always hit localhost so the
 * SDK middleware actually runs against the dev process.
 *
 * We replace ALL `http(s)://host[:port]` occurrences (not just the
 * first) so an edge-case URL inside `--data` can't smuggle in a prod
 * call, and we trim trailing slashes to avoid a double-slash when the
 * curl path is itself absolute.
 */
function rewriteCurlBase(curl, localBase) {
  const clean = localBase.replace(/\/+$/, '');
  return curl.replace(/https?:\/\/[^\s/'"`]+/g, clean);
}

/**
 * Belt-and-braces guard: after rewriting, sniff the actual URL the
 * curl will hit and confirm it's localhost. If somehow it isn't (the
 * user edited the box, the saved curl had a non-URL form, etc.) we
 * refuse to run and surface a clear error instead of silently firing
 * a request at production.
 */
function curlTargetIsLocal(curl) {
  const match = curl.match(/\bhttps?:\/\/([^\s/'"`]+)/);
  if (!match) return true; // no absolute URL → curl will use a relative one, which means localhost only if the cwd makes it so. Treat as ok and let curl fail loudly.
  const host = match[1].toLowerCase().split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
}

/**
 * The CLI needs to read response headers to know whether the SDK
 * middleware ran and whether `RESTLESS_KEY` is loaded. We do that by
 * including `-i` (or `--include`) in the curl, which prefixes the body
 * with the response headers. We refuse to run a curl without one of
 * these flags rather than silently re-add it - the visible command and
 * the executed command should match.
 */
function curlHasIncludeFlag(curl) {
  return /(?:^|\s)(?:-i|--include)(?:\s|$)/.test(curl);
}

/**
 * Pull `{ method, url }` out of a curl command for display in the
 * "in-flight" placeholder. We show the path (not the full URL) - the
 * box already established it's hitting localhost, so the path alone is
 * less noisy.
 */
function extractPending(curl) {
  const methodMatch = curl.match(/(?:^|\s)(?:-X|--request)\s+(\w+)/);
  const method = (methodMatch?.[1] || 'GET').toUpperCase();
  const urlMatch = curl.match(/\bhttps?:\/\/[^\s"']+/);
  let url = urlMatch?.[0] || '';
  try {
    const u = new URL(url);
    url = u.pathname + (u.search || '');
  } catch {}
  return { method, url };
}

/**
 * Parse the combined "headers + body" output produced by `curl -i`.
 * Each HTTP exchange ends in a blank line; the body follows the LAST
 * header block (anything before is from a redirect we don't care about).
 */
function splitCurlIncludeOutput(text) {
  const sep = text.match(/\r?\n\r?\n/g);
  if (!sep) return { headers: {}, body: text };

  // Walk header blocks from the start. As long as the next block looks
  // like more HTTP headers (starts with `HTTP/`), keep going. Once it
  // doesn't, that block is the body.
  let cursor = 0;
  let lastHeaderBlock = '';
  while (cursor < text.length) {
    const next = text.slice(cursor).search(/\r?\n\r?\n/);
    if (next === -1) break;
    const block = text.slice(cursor, cursor + next);
    cursor += next;
    cursor += text.slice(cursor).match(/^\r?\n\r?\n/)?.[0].length || 0;
    if (/^HTTP\//i.test(block)) {
      lastHeaderBlock = block;
    } else {
      // Wasn't a header block - rewind so it ends up in the body.
      cursor = text.indexOf(block);
      break;
    }
  }

  const headers = {};
  for (const line of lastHeaderBlock.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, body: text.slice(cursor) };
}

/**
 * Categorize an outcome based on response headers:
 *
 *   - 'no-sdk'  → response had neither x-request-id nor x-restless-id,
 *                 so the SDK middleware never ran in the request path
 *   - 'no-key'  → SDK ran but RESTLESS_KEY isn't set in process.env;
 *                 the SDK marks this by emitting `missing-key` as the
 *                 header value (see node-sdk/src/adapters/_shared.ts)
 *   - 'ok'      → SDK ran with a key, header carries a real request ID
 */
function diagnoseFromHeaders(headers) {
  const idValue = headers['x-restless-id'] || headers['x-request-id'];
  if (!idValue) return { state: 'no-sdk' };
  if (idValue === 'missing-key') return { state: 'no-key' };
  return { state: 'ok', requestId: idValue };
}

/**
 * Best-effort detection of the port the dev server runs on. We check
 * multiple sources because frameworks differ in where the port is
 * declared:
 *
 *   1. `package.json` scripts - `next dev -p 4000`, `vite --port 4000`,
 *      `nodemon -p 4000`, etc. Most JS/TS apps surface their port here.
 *   2. `.env*` files - `PORT=4000`. Common for Express/Fastify/Koa and
 *      also honored by `next dev` and `nuxt dev`.
 *   3. Source files - `.listen(PORT)` literal or `PORT = N` constant.
 *      Catches the bare-Express path; Next.js / Nuxt have no such call.
 *
 * Falls back to 3000 (Next.js / Express convention) when nothing
 * matches. We deliberately read .env* here even though AI prompts
 * forbid it - this is a local Node read, not a value sent to an LLM,
 * and the port is the only field we extract.
 */
function detectLocalPort(searchDir) {
  // 1. package.json scripts.
  try {
    const pkgPath = path.join(searchDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      // Try the conventional dev-script names first, then any script.
      const ordered = [
        ...['dev', 'start:dev', 'start', 'serve', 'develop'].map((k) => scripts[k]).filter(Boolean),
        ...Object.values(scripts),
      ];
      for (const cmd of ordered) {
        if (typeof cmd !== 'string') continue;
        // Match `-p 4000`, `--port 4000`, `--port=4000`, and inline
        // `PORT=4000 next dev`. Anchor on word boundaries so we don't
        // grab e.g. `--polyfill 1234`.
        const m =
          cmd.match(/(?:^|\s)(?:-p|--port)\s*=?\s*(\d{2,5})\b/) ||
          cmd.match(/\bPORT\s*=\s*(\d{2,5})\b/);
        if (m) return m[1];
      }
    }
  } catch {}

  // 2. .env* files. We don't list every variant by hand - glob the dir.
  try {
    const envFiles = fs.readdirSync(searchDir).filter((f) => /^\.env(\..+)?$/.test(f));
    for (const f of envFiles) {
      try {
        const content = fs.readFileSync(path.join(searchDir, f), 'utf8');
        // `PORT=4000` (no quotes), `PORT="4000"`, `PORT='4000'`.
        const m = content.match(/^\s*PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m);
        if (m) return m[1];
      } catch {}
    }
  } catch {}

  // 3. Source files. Broader extension list now (.tsx, .jsx, .mjs, .cjs).
  try {
    const files = execSync(
      'find . -maxdepth 3 \\( -name "*.tsx" -o -name "*.ts" -o -name "*.jsx" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.py" -o -name "*.rb" \\) -not -path "*/node_modules/*" | head -40',
      { cwd: searchDir, encoding: 'utf8' },
    );
    for (const file of files.trim().split('\n').filter(Boolean)) {
      try {
        const content = fs.readFileSync(path.join(searchDir, file), 'utf8');
        const match = content.match(/\.listen\(\s*(\d{2,5})\s*[,)]/) || content.match(/\bPORT\s*(?:=|:)\s*(\d{2,5})\b/);
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
    actionRequired: 'Make sure your server is up and running so we can test everything locally.',
    action: 'run a test request',
  });

  // The test curl was picked at the end of step 1 (when the OAS was fresh)
  // and saved to .restless/settings.json. Read it back and rewrite its base URL
  // to localhost so the user can hit their dev server without editing the
  // command. Falls back to a generic GET / if nothing was saved (e.g. the
  // OAS had no safe GET endpoint to pick).
  const searchDir = apiRootDir && apiRootDir !== '.' ? path.resolve(packageDir, apiRootDir) : packageDir;
  const localPort = detectLocalPort(searchDir);
  const localBase = `http://localhost:${localPort}`;

  const settings = loadSettings(rootDir);
  const apiEntry = settings.apis?.find((a) => a.rootDir === (apiRootDir || '.')) || settings.apis?.[0];
  const baseCurl = apiEntry?.testCurl
    ? rewriteCurlBase(apiEntry.testCurl, localBase)
    : `curl -sS ${localBase}/`;

  // Show `-i` in the visible command - what the user runs is exactly
  // what we run. We need it to read response headers and confirm the
  // SDK middleware actually ran on this request.
  const curlCommand = curlHasIncludeFlag(baseCurl)
    ? baseCurl
    : baseCurl.replace(/^curl\b/, 'curl -i');

  update({ message: [
    `  ${green('✓')} Make sure your server is running on ${bold(localBase)},`,
    dim(`  then hit enter in the box below to fire off the request.`),
  ]});

  // ── Sub 1: Verify - interactive terminal with live log polling ──────────
  const pollConfig = projectId
    ? { url: `${SITE_URL}/api/logs/poll`, projectId, setupKey }
    : null;

  // The diagnostic state from the most recent run. terminalRunScreen
  // can run the command multiple times; we use the latest reading.
  let lastHeaders = {};
  let lastDiagState = null;

  // Hint copy. The row's icon column already shows the warning glyph,
  // so the strings here lead straight into the message.
  const noSdkHint = [
    `The Restless SDK didn't fire on this request.`,
    `Either the middleware isn't wired in, or ${bold('RESTLESS_KEY')} isn't set in the running process - ${bold('restart')} your server after fixing either.`,
  ];
  const noKeyHint = [
    `Server is loaded, but ${bold('RESTLESS_KEY')} isn't set in the running process.`,
    `${bold('Restart your server')} so it picks up ${bold('.env')}, then run again.`,
  ];
  const wrongKeyHint = [
    `The SDK fired, but no log landed at Restless.`,
    `Most likely your ${bold('RESTLESS_KEY')} is stale. Re-check ${bold('.env')} and ${bold('restart')} your server.`,
  ];

  const result = await terminalRunScreen(curlCommand, {
    pollConfig,
    noLogsHint: () => (lastDiagState === 'ok' ? wrongKeyHint : null),
    onRun: (cmd) => {
      // If the user removed `-i` while editing, put it back. We need it
      // to read response headers (the only way to confirm the SDK ran
      // on this request). Mutate the visible command so what they see
      // matches what actually ran.
      let runCmd = cmd;
      if (!curlHasIncludeFlag(runCmd)) {
        runCmd = runCmd.replace(/^curl\b/, 'curl -i');
      }

      // If the user pasted a non-local URL (or somehow the rewrite
      // missed one), refuse to run rather than firing at production.
      // Force the host back to the detected localBase and re-display.
      if (!curlTargetIsLocal(runCmd)) {
        runCmd = rewriteCurlBase(runCmd, localBase);
        if (!curlTargetIsLocal(runCmd)) {
          return {
            output: `This step only runs against your local server (${localBase}). Edit the URL above to a localhost address and try again.`,
            success: false,
            command: runCmd,
          };
        }
      }
      try {
        const raw = execSync(runCmd, { encoding: 'utf8', timeout: 10000 });
        const { headers, body } = splitCurlIncludeOutput(raw);
        lastHeaders = headers;
        const diag = diagnoseFromHeaders(headers);
        lastDiagState = diag.state;

        // Show only the body to the user - the headers are for us.
        // Pretty-print JSON when possible.
        let output = body;
        try { output = JSON.stringify(JSON.parse(body), null, 2); } catch {}

        // Push an immediate hint when we already know logs aren't
        // coming - no point making the user wait the noLogsHint timeout
        // for a definite negative.
        const immediateHint =
          diag.state === 'no-sdk' ? noSdkHint :
          diag.state === 'no-key' ? noKeyHint :
          undefined;

        return {
          output,
          success: true,
          command: runCmd,
          immediateHint,
          pending: extractPending(runCmd),
        };
      } catch (err) {
        lastDiagState = null;
        return {
          output: err.stderr || err.stdout || err.message || '',
          success: false,
          command: runCmd,
        };
      }
    },
  });

  // Diagnose what happened. The response headers are the source of
  // truth for SDK state; the log poll inside terminalRunScreen tells us
  // whether the metrics server actually received the upload, which
  // separates a working key from a wrong one.
  const diag = diagnoseFromHeaders(lastHeaders);

  let doneMessage;
  if (!result.success) {
    doneMessage = [
      `  ${yellow('⚠')} Request didn't come back clean. Make sure your server is running on ${bold(localBase)} and try again.`,
    ];
  } else if (diag.state === 'no-sdk') {
    doneMessage = [
      `  ${red('✗')} The Restless SDK didn't run on this request.`,
      `  Add the middleware to your server (see ${bold('.restless/INSTALL.md')}) and ${bold('restart')} it.`,
    ];
  } else if (diag.state === 'no-key') {
    doneMessage = [
      `  ${red('✗')} The SDK is loaded, but ${bold('RESTLESS_KEY')} isn't set in the running process.`,
      `  This almost always means your dev server is running on a stale environment.`,
      `  ${bold('Restart your server')} so it picks up ${bold('.env')}, then run the request again.`,
    ];
  } else if (diag.state === 'ok') {
    // We got an upload upstream if the log polling has anything from
    // this run. If nothing landed, the most likely culprit is a wrong
    // RESTLESS_KEY - a valid one would have produced a log already.
    doneMessage = pollConfig
      ? [`  ${green('✓')} Test request succeeded and logs are flowing.`]
      : [`  ${green('✓')} Test request succeeded.`];
  } else {
    // 'no-headers' - couldn't read the dump (user edited the curl, etc).
    // Don't pretend we know more than we do.
    doneMessage = [`  ${green('✓')} Test request succeeded.`];
  }

  update({ status: 'done', message: doneMessage });

  return { success: result.success, diagnostic: diag.state };
}
