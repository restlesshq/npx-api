import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, yellow, cyan, orange, actionPicker, ask, askYesNo, waitForServerOrKey } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { SITE_URL } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import * as debug from '../lib/debug.js';
import { parseStatus, validatePort, describeDiagnosis, fixActions, fixContext } from '../lib/test-diagnosis.js';
import { isInteractive } from '../lib/env.js';
import { findTestCandidates, buildCurl } from '../lib/test-endpoint.js';
import { loadOas } from '../lib/oas-auth.js';

// A bare host[:port] like `api.example.com` or `api.example.com:8080` -
// a token with a dot before the first slash and no scheme. Used to catch
// curls whose URL was emitted without an `http(s)://` prefix.
const SCHEMELESS_HOST = /(?<![\w./-])([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)(?=[/\s'"`]|$)/gi;

/**
 * Force every absolute URL in the saved curl to point at the local
 * dev server. The saved curl is built against localhost already, but
 * older/reused settings may carry a production base (from the OAS
 * `servers[0].url`), and the user can edit the box - step 3 must always
 * hit localhost so the SDK middleware runs against the dev process.
 *
 * We replace ALL `http(s)://host[:port]` occurrences (not just the
 * first) so an edge-case URL inside `--data` can't smuggle in a prod
 * call, then also rewrite any remaining schemeless `host[:port]` token
 * (curl treats `api.example.com/x` as a real http request). Trailing
 * slashes are trimmed to avoid a double-slash when the path is absolute.
 */
function rewriteCurlBase(curl, localBase) {
  const clean = localBase.replace(/\/+$/, '');
  return curl
    .replace(/https?:\/\/[^\s/'"`]+/g, clean)
    .replace(SCHEMELESS_HOST, (m) => (isLocalHost(m) ? m : clean.replace(/^https?:\/\//, '')));
}

/**
 * Strip the target API's auth off a saved curl. We now send the test
 * request unauthenticated on purpose - a rejected request (401) still
 * proves the SDK middleware saw it, and it means the user never has to
 * paste a real API key. New curls are built without auth (see
 * lib/test-endpoint.js), but settings written by older CLI versions may
 * still carry an `API_KEY_HERE` header/query, so we scrub it here.
 */
function stripAuthPlaceholder(curl) {
  return curl
    .replace(/\s+(?:-H|--header|--url-query)\s+(["'])[^"']*API_KEY_HERE[^"']*\1/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isLocalHost(host) {
  const name = host.toLowerCase().split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0' || name === '[::1]' || name === '::1';
}

/**
 * Belt-and-braces guard: after rewriting, sniff the actual URL the
 * curl will hit and confirm it's localhost. If somehow it isn't (the
 * user edited the box, the saved curl had a non-URL form, etc.) we
 * refuse to run and surface a clear error instead of silently firing
 * a request at production.
 */
function curlTargetIsLocal(curl) {
  const schemed = curl.match(/\bhttps?:\/\/([^\s/'"`]+)/);
  if (schemed) return isLocalHost(schemed[1]);
  // No schemed URL - look for a bare host[:port] token. curl resolves
  // `api.example.com/x` as a real http request, so a non-local bare host
  // is just as dangerous as a schemed one.
  const bare = curl.match(SCHEMELESS_HOST);
  if (bare) return bare.every(isLocalHost);
  return true; // relative URL only → curl stays local; let it fail loudly if not.
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
  ctx = {},
}) {
  const aiTool = ctx.aiTool || 'the AI';

  await startStep({
    update,
    stepNum: 3,
    title: 'Test your setup',
    intro: "Now let's confirm the SDK is picking up your requests.",
    sections: [
      {
        label: 'How',
        body:
          `As soon as your server is up, we detect it, quietly send a test request,\n` +
          `and confirm it flows through the SDK - a rejected request (like a ${bold('401')})\n` +
          `still counts. Nothing to run, no key needed. If it's not wired right,\n` +
          `${orange(aiTool)} fixes it and we re-check on our own.`,
      },
    ],
    actionRequired: 'Start your server in another terminal.',
    action: 'start watching',
  });

  const searchDir = apiRootDir && apiRootDir !== '.' ? path.resolve(packageDir, apiRootDir) : packageDir;
  // The SDK was wired into this same directory by the install step, so
  // that's where the fix AI should run.
  const installDir = searchDir;

  // The port is mutable - the user can correct a wrong guess mid-flight,
  // so `localBase()` always reflects the current choice.
  let localPort = detectLocalPort(searchDir);
  const localBase = () => `http://localhost:${localPort}`;

  // The test curl was picked at the end of step 1 (auth stripped - we send
  // it unauthenticated on purpose). We re-point its base at the current
  // port on every probe. Falls back to a bare GET / if none was saved.
  const settings = loadSettings(rootDir);
  const apiEntry = settings.apis?.find((a) => a.rootDir === (apiRootDir || '.')) || settings.apis?.[0];
  const savedCurl = apiEntry?.testCurl ? stripAuthPlaceholder(apiEntry.testCurl) : null;

  function buildProbeCurl() {
    const base = savedCurl ? rewriteCurlBase(savedCurl, localBase()) : `curl -sS ${localBase()}/`;
    let cmd = curlHasIncludeFlag(base) ? base : base.replace(/^curl\b/, 'curl -i');
    if (!curlTargetIsLocal(cmd)) cmd = rewriteCurlBase(cmd, localBase());
    return cmd;
  }

  const pollConfig = projectId ? { url: `${SITE_URL}/api/logs/poll`, projectId, setupKey } : null;

  // Fire one request at the local server and classify from the response
  // headers. A connection error → 'unreachable' (server down / wrong port);
  // otherwise the SDK's `x-restless-id` header tells us the rest.
  function probe() {
    const cmd = buildProbeCurl();
    if (!curlTargetIsLocal(cmd)) return { state: 'unreachable' };
    try {
      const raw = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      const { headers } = splitCurlIncludeOutput(raw);
      const diag = diagnoseFromHeaders(headers);
      return { state: diag.state, status: parseStatus(raw), requestId: diag.requestId };
    } catch (err) {
      debug.log('test-setup.probe-unreachable', { message: String(err?.message || '').slice(0, 160) });
      return { state: 'unreachable' };
    }
  }

  // ── Visible "test" batch ────────────────────────────────────────────────
  // Once we know the server is up and the SDK is wired, we fire a few real
  // requests and show each one's status code + whether the SDK captured it.
  // A single silent probe reads as "did it even do anything?"; watching 2-3
  // requests come back with status codes makes it obvious we tested and it
  // worked.

  // Up to 3 safe GET requests, pulled from the OAS's ranked test candidates
  // (so we exercise a few different real endpoints). Falls back to the single
  // saved probe curl if the OAS isn't readable.
  function buildTestRequests() {
    const reqs = [];
    try {
      const oasPath = apiEntry?.oasFile ? path.join(rootDir, apiEntry.oasFile) : null;
      const oas = oasPath ? loadOas(oasPath) : null;
      if (oas) {
        for (const cand of findTestCandidates(oas, { max: 3 })) {
          let curl = buildCurl(oas, cand, localBase());
          if (!curlHasIncludeFlag(curl)) curl = curl.replace(/^curl\b/, 'curl -i');
          if (curlTargetIsLocal(curl)) reqs.push({ method: cand.method, path: cand.path, curl });
        }
      }
    } catch {}
    if (!reqs.length) {
      const curl = buildProbeCurl();
      const method = (curl.match(/(?:-X|--request)\s+(\w+)/)?.[1] || 'GET').toUpperCase();
      let p = '/';
      try { const u = new URL(curl.match(/\bhttps?:\/\/[^\s"']+/)?.[0] || ''); p = u.pathname + (u.search || ''); } catch {}
      reqs.push({ method, path: p, curl });
    }
    return reqs.slice(0, 3);
  }

  function colorStatus(status) {
    if (status == null) return dim('---');
    const s = String(status);
    if (status >= 200 && status < 300) return green(s);
    if (status >= 500) return red(s);
    return yellow(s); // 3xx / 4xx (incl. an expected 401) - not an error for us
  }

  // Render the batch rows as plan-message lines. `done` swaps the spinner
  // header for a summary of how many the SDK captured.
  function batchLines(rows, { done = false } = {}) {
    const captured = rows.filter((r) => r.captured).length;
    const header = done
      ? `  ${green('✓')} Sent ${rows.length} test request${rows.length === 1 ? '' : 's'} - the SDK saw ${captured}/${rows.length}.`
      : `  ${dim('◌')} Sending a few test requests through the SDK…`;
    const lines = [header, ''];
    for (const r of rows) {
      const label = `${r.method} ${r.path}`;
      const padded = label.length >= 30 ? label : label.padEnd(30);
      let tail;
      if (r.state === 'done') {
        tail = `${colorStatus(r.status)}   ${r.captured ? green('✓ SDK') : yellow('⚠ missed')}`;
      } else if (r.state === 'running') {
        tail = dim('sending…');
      } else {
        tail = dim('queued');
      }
      lines.push(`     ${padded}  ${tail}`);
    }
    return lines;
  }

  // Fire the batch. Interactively we animate it row-by-row (each request
  // flips from "sending…" to its status code); non-interactively we run them
  // all and let the caller print the final list once (no per-row redraw spam).
  async function runTestBatch() {
    const rows = buildTestRequests().map((r) => ({ ...r, state: 'pending', status: null, captured: false }));
    const interactive = isInteractive();
    const draw = () => update({ message: batchLines(rows) });
    if (interactive) draw();
    for (const row of rows) {
      if (interactive) { row.state = 'running'; draw(); await new Promise((r) => setTimeout(r, 250)); }
      try {
        const raw = execSync(row.curl, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        row.status = parseStatus(raw);
        row.captured = diagnoseFromHeaders(splitCurlIncludeOutput(raw).headers).state !== 'no-sdk';
      } catch {
        row.status = null;
        row.captured = false;
      }
      row.state = 'done';
      if (interactive) draw();
    }
    return rows;
  }

  // Render a diagnosis into the plan step message. The waiting state also
  // gets a footer advertising the escape-hatch keys.
  function render(state, { status, attempt } = {}) {
    const { icon, lines } = describeDiagnosis(state, { status, localBase: localBase(), aiTool, attempt });
    const msg = [`  ${icon}  ${lines[0]}`, ...lines.slice(1).map((l) => `     ${l}`)];
    if (state === 'unreachable') {
      msg.push('');
      msg.push(dim(`     Press ${bold('p')} to change the port · ${bold('Tab')} to skip`));
    }
    update({ message: msg });
  }

  // Poll the dashboard for a log from this run. A landed log (any status,
  // incl. 401) proves RESTLESS_KEY is valid end-to-end; nothing landing
  // after a clean header points at a stale key.
  async function dashboardLogged(since) {
    if (!pollConfig) return true; // no poll available → the clean header is all we have
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(pollConfig.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, setupKey, since, limit: 5 }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.logs && data.logs.length > 0) return true;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async function changePort() {
    const answer = await ask(`\n  ${cyan('?')} What port is your server on? `, { defaultValue: String(localPort) });
    const p = validatePort(answer);
    if (p) localPort = p;
    return localPort;
  }

  // Hand the runtime evidence to the agent and let it edit the code.
  async function runFix(state) {
    const { evidence, guidance } = fixContext(state, { localBase: localBase() });
    update({ message: [
      `  ${orange(aiTool)} is reading your code and fixing the wiring…`,
      dim(`     When it's done, restart your server - we'll re-check on our own.`),
    ]});
    debug.log('test-setup.fix-start', { state });
    try {
      await runAI(loadPrompt('fix-sdk', { evidence, guidance, base: localBase() }), installDir, { setSpinner });
      update({ message: [
        `  ${green('✓')} ${orange(aiTool)} applied a fix. ${bold('Restart your server')} and we'll re-check automatically.`,
      ]});
    } catch (err) {
      debug.log('test-setup.fix-error', { message: String(err?.message || '').slice(0, 160) });
      update({ message: [
        `  ${yellow('⚠')} Couldn't complete the automatic fix. Check the notes above, then restart your server.`,
      ]});
    }
  }

  function confirmSkip() {
    return askYesNo(`\n  ${yellow("Skip without confirming the SDK is set up?")} `, { defaultValue: false });
  }

  function finishSkipped(lastState) {
    update({ status: 'done', message: [
      `  ${yellow('⚠')} Skipped the setup check - you can run setup again anytime to finish it.`,
    ]});
    debug.log('test-setup.skipped', { lastState });
  }

  // ── Non-interactive (agent / CI) ───────────────────────────────────────
  // The interactive loop below relies on a human to press keys, restart the
  // server on cue, and drive the fix menu - none of which happens under an
  // agent, so it would hang (the post-fix watch waits forever for a manual
  // restart). Instead: poll for the server for a bounded window, diagnose
  // once, and report. Success = the SDK saw the request (any status, incl.
  // a 401 / `missing-key` - an agent has no key and doesn't need one). On a
  // real failure we surface the diagnosis + fix guidance and return so the
  // driving agent can act, rather than blocking on a restart we can't get.
  if (!isInteractive()) {
    const MAX_ATTEMPTS = 15; // ~30s at 2s spacing - room for a dev server to boot
    let diag = { state: 'unreachable' };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      diag = probe();
      if (diag.state !== 'unreachable') break;
      if (attempt === 1) render('unreachable', { attempt });
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (diag.state === 'unreachable') {
      update({ status: 'done', message: [
        `  ${yellow('⚠')} Couldn't reach your server on ${bold(localBase())} within the wait window.`,
        dim(`     Start it (or set the right port) and run setup again to finish the check.`),
      ]});
      debug.log('test-setup.noninteractive', { state: 'unreachable' });
      return { success: false, diagnostic: 'unreachable' };
    }

    // The SDK saw the request. Fire a few visible requests so the outcome is
    // concrete (status codes + captured flags), then confirm. For a real key
    // we'd also check the dashboard, but an agent has none - the header is the
    // proof of wiring.
    if (diag.state === 'ok' || diag.state === 'no-key') {
      const since = new Date(Date.now() - 15000).toISOString();
      const rows = await runTestBatch();
      let landed = false;
      if (diag.state === 'ok' && pollConfig) landed = await dashboardLogged(since);
      const msg = batchLines(rows, { done: true });
      msg.push('');
      if (diag.state === 'no-key') {
        msg.push(`  ${green('✓')} The SDK is wired up and capturing requests.`);
        msg.push(dim(`     No ${bold('RESTLESS_KEY')} is set, so nothing was uploaded - set it and restart to stream logs.`));
      } else {
        const extra = landed ? ' and logging them to your dashboard' : '';
        msg.push(`  ${green('✓')} The SDK is picking up your requests${extra}.`);
        if (!landed && pollConfig) msg.push(dim(`     Header looked good but no log reached the dashboard - double-check ${bold('RESTLESS_KEY')}.`));
      }
      update({ status: 'done', message: msg });
      debug.log('test-setup.noninteractive', { state: diag.state, landed, tested: rows.length });
      return { success: true, diagnostic: diag.state };
    }

    // no-sdk / stale-key → a real problem. Report the diagnosis and, when the
    // state is AI-fixable, the exact guidance so the outer agent can fix it.
    const desc = describeDiagnosis(diag.state, { status: diag.status, localBase: localBase(), aiTool });
    const msg = [`  ${desc.icon}  ${desc.lines[0]}`, ...desc.lines.slice(1).map((l) => `     ${l}`)];
    if (desc.canFix) {
      const { guidance } = fixContext(diag.state, { localBase: localBase() });
      if (guidance) msg.push(dim(`     Fix hint: ${guidance}`));
    }
    update({ status: 'done', message: msg });
    debug.log('test-setup.noninteractive', { state: diag.state });
    return { success: false, diagnostic: diag.state };
  }

  // ── Main loop: watch → diagnose → (fix / retry / port / skip) → repeat ──
  let lastState = null;
  while (true) {
    // Passive watch: poll until the server answers, or the user hits a key.
    const ev = await waitForServerOrKey(probe, {
      intervalMs: 2000,
      render: (attempt) => render('unreachable', { attempt }),
    });

    if (ev.type === 'key') {
      if (ev.key === '\t') {
        if (await confirmSkip()) { finishSkipped(lastState); return { success: false, diagnostic: lastState }; }
        continue;
      }
      if ((ev.key || '').toLowerCase() === 'p') { await changePort(); continue; }
      continue; // any other key → re-check immediately
    }

    const diag = ev.result;
    lastState = diag.state;

    // Success path: the header is clean. Confirm the log reached the
    // dashboard (when we can) to catch a stale key; otherwise the clean
    // header is enough.
    if (diag.state === 'ok') {
      const since = new Date(Date.now() - 15000).toISOString();
      // Fire a few real requests, animating each status code as it lands, so
      // it's visibly clear we tested it and it works.
      const rows = await runTestBatch();
      const landed = await dashboardLogged(since);
      if (landed) {
        const extra = pollConfig ? ' and logging them to your dashboard' : '';
        const msg = batchLines(rows, { done: true });
        msg.push('');
        msg.push(`  ${green('✓')} The SDK is picking up your requests${extra}.`);
        update({ status: 'done', message: msg });
        debug.log('test-setup.done', { state: 'ok', logged: !!pollConfig, tested: rows.length });
        return { success: true, diagnostic: 'ok' };
      }
      // Requests were captured but nothing landed upstream → stale key. Fall
      // through to the fix menu with that diagnosis.
      diag.state = 'stale-key';
      lastState = 'stale-key';
    }

    // Failing path: show the diagnosis, then offer the fix loop.
    render(diag.state, { status: diag.status });
    const choice = await actionPicker([], {
      message: 'What would you like to do?',
      actions: fixActions(diag.state, { aiTool }),
    });
    const action = choice.key;
    if (action === 'skip') {
      if (await confirmSkip()) { finishSkipped(lastState); return { success: false, diagnostic: lastState }; }
      continue;
    }
    if (action === 'port') { await changePort(); continue; }
    if (action === 'fix') {
      await runFix(diag.state);
      // The server is still running the OLD code until the user restarts,
      // so an immediate re-probe would show the same failure and read as
      // "the fix didn't work". Wait until the diagnosis actually CHANGES
      // (the restart landed) - or the user presses a key to re-check now.
      const prev = diag.state;
      await waitForServerOrKey(
        () => {
          const r = probe();
          return r.state === prev ? { state: 'unreachable' } : r;
        },
        {
          intervalMs: 2000,
          render: () => update({ message: [
            `  ${dim('⟳')}  Fix applied - ${bold('restart your server')} and we'll pick it up…`,
            dim(`     Press any key to re-check now.`),
          ]}),
        },
      );
      continue; // re-enter the main watch, which re-probes fresh.
    }
    // 'recheck' → loop again; waitForServerOrKey probes immediately.
  }
}
