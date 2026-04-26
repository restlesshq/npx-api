#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, yellow, ask, askYesNo, startSpinner, singleSelect, typeLine, typeOut, inlineStatus, waitForKey } from '../lib/ui.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import { createPlanManager } from '../lib/runner.js';
import { resolveProjectDirs } from '../lib/project.js';
import generateOas from '../steps/generate-oas.js';
import prepareAccount from '../steps/prepare-account.js';
import installSdk from '../steps/install-sdk.js';
import detectAuth from '../steps/detect-auth.js';
import setupAccount from '../steps/setup-account.js';
import testSetup from '../steps/test-setup.js';
import { SITE_URL, CALENDLY_URL } from '../lib/config.js';
import { loadSettings, formatRequestId, stripRequestIdPrefix } from '../lib/settings.js';
import { fatalError } from '../lib/errors.js';

// Suppress Node's unsettled top-level await warning
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'Warning' && w.message.includes('unsettled top-level await')) return;
  console.warn(w);
});

// Handle Ctrl+C gracefully
let setupInProgress = false;
process.on('SIGINT', () => {
  // Show cursor in case it was hidden, move below current output
  process.stdout.write('\x1b[?25h\n');
  if (setupInProgress) {
    console.log(dim('\n  Setup interrupted. Run `npx api setup` again to resume.\n'));
  }
  process.exit(0);
});

function hasClaude() {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the auth-detection AI pass to populate .api/settings.json with custom
 * redaction rules. Skips if the current API already has a `redact` block
 * (user re-running setup → don't re-spend an AI call).
 */
async function runDetectAuth(plan, setSpinner, packageDir, rootDir, settings) {
  const api = settings.apis?.[0];
  if (!api) return;
  if (api.redact) return; // already detected — don't re-run

  await detectAuth({
    packageDir,
    rootDir,
    apiId: api.id,
    apiName: api.name,
    oasFile: api.oasFile,
    update: plan.makeUpdater(1),
    setSpinner,
    subIndex: 3,
    prevSubs: { 0: 'done', 1: 'done', 2: 'done' },
  });
}

const command = process.argv[2];

if (command === 'setup' || command === 'supercharge') {
  // ── Welcome screen ────────────────────────────────────────────────────
  console.log('');
  await typeLine(`  ${bold(cyan('Welcome to Restless'))}`);
  console.log('');

  // "Restless helps make [400 Bad Request] into [200 Okay]."
  // The two status codes spin as "loading", then resolve into red/green.
  // Swap `spinnerStyle` to try: arc, halfcircle, piefill, pulse, sparkle, concentric, braille
  const spinnerStyle = 'concentric';
  const demoPath = 'GET /api/endpoint';

  await typeOut(`  Restless makes sure every `);
  await inlineStatus({ code: '400 Bad Request', success: false, style: spinnerStyle, loadingText: demoPath });
  await typeOut(` turns out `);
  await inlineStatus({ code: '200 Okay', success: true, style: spinnerStyle, loadingText: demoPath });
  await typeLine(`.`);
  console.log('');

  await typeLine(`  It's not just another observability platform (although you can use it`);
  await typeLine(`  to see what your users are up to!).`);
  console.log('');
  await typeLine(`  Think of us more as an API success platform. We give humans, AI and`);
  await typeLine(`  you the tools to quickly make successful calls.`);
  console.log('');
  await typeLine(`  ${dim("We use AI for the setup, but we'll ask permission before we do anything.")}`);
  console.log('');
  await typeLine(`  ${bold(yellow('Ready to supercharge your API?'))} ${cyan('Hit any key to get started!')}`);
  // Secondary shortcuts: print instantly, on the next line, no typing animation.
  process.stdout.write(`  ${dim(`Press [${bold('d')}${'\x1b[2m'}] to try this on a demo repo · Press [${bold('h')}${'\x1b[2m'}] to set up time with a human`)}\n`);
  const welcomeKey = await waitForKey();

  if (welcomeKey === 'd' || welcomeKey === 'D') {
    console.log('');
    console.log(`  ${dim('Demo repo flow is coming soon. In the meantime, clone')}`);
    console.log(`  ${dim('https://github.com/restlessai/demo and run `npx api setup` there.')}`);
    console.log('');
    process.exit(0);
  }

  if (welcomeKey === 'h' || welcomeKey === 'H') {
    const { execSync } = await import('child_process');
    console.log('');
    console.log(`  ${dim(`Opening ${CALENDLY_URL} in your browser...`)}`);
    console.log('');
    try {
      if (process.platform === 'darwin') execSync(`open "${CALENDLY_URL}"`);
      else if (process.platform === 'win32') execSync(`start "${CALENDLY_URL}"`);
      else execSync(`xdg-open "${CALENDLY_URL}"`);
    } catch {}
    process.exit(0);
  }

  // Any other key: continue normal setup.
  // Clear the viewport + scrollback so the welcome doesn't linger.
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
  // ──────────────────────────────────────────────────────────────────────

  const plan = createPlanManager();

  console.log('');
  console.log(`  ${bold("Here's what we're going to do:")}`);
  console.log('');

  // Show the initial plan as static output (not managed by the redraw system)
  plan.drawInitial();

  console.log('');
  const choice = await singleSelect(
    ['Claude', 'Codex', 'Manual', 'Tell me more'],
    { message: 'How would you like to set this up?', defaultIndex: 0 },
  );

  // Clear the viewport so after-selection stuff starts clean at the top.
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');

  if (choice === 3) {
    // "Tell me more" — explain how it works
    console.log('');
    console.log(`  ${bold('What this does')}`);
    console.log('');
    console.log(`  Restless wires your API up for observability. This CLI does the boring part:`);
    console.log(`  scans your code, generates an OpenAPI spec, installs the SDK, and hooks it`);
    console.log(`  into your server's middleware.`);
    console.log('');
    console.log(`  When it finishes, you sign in to claim the project and your logs start`);
    console.log(`  showing up on the dashboard.`);
    console.log('');
    console.log(`  ${bold('How we keep it safe')}`);
    console.log('');
    console.log(`  ${green('1.')} ${bold('Your code never leaves your machine.')} Scanning is done by Claude or`);
    console.log(`     Codex running locally via the CLI you already have installed. We don't`);
    console.log(`     proxy it, upload it, or see any of it.`);
    console.log('');
    console.log(`  ${green('2.')} ${bold('We handle the fiddly bits.')} Framework-specific middleware placement,`);
    console.log(`     auth-header redaction, env wiring, and OAS generation are all done for you.`);
    console.log('');
    console.log(`  ${green('3.')} ${bold('Nothing runs without your OK.')} You see every file change and command`);
    console.log(`     before it happens, and can bail at any point.`);
    console.log('');
    console.log(`  Run ${cyan('npx api setup')} again when you're ready.`);
    console.log('');
    process.exit(0);
  }

  if (choice === 0 && !hasClaude()) {
    console.log('');
    console.log(red('  ✗ Claude is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @anthropic-ai/claude-code\n'));
    process.exit(1);
  }

  // TODO: wire Codex and Manual flows. For now, only Claude path continues.
  if (choice !== 0) {
    console.log('');
    console.log(dim(`  [dev] ${['Claude','Codex','Manual'][choice]} flow not yet implemented.`));
    console.log('');
    process.exit(0);
  }
  // packageDir = where the user ran the command (scopes what we analyze)
  // rootDir = git root (where .api/ lives)
  const { packageDir, rootDir } = resolveProjectDirs(process.cwd());

  // Set the header (static content above the plan) and pin — from here on, render() manages the whole screen.
  plan.setHeader([
    '',
    `  ${bold("Here's what we're going to do:")}`,
    '',
  ]);
  plan.pin();
  setupInProgress = true;

  const { setSpinner } = plan;

  const settings = loadSettings(rootDir);
  const hasOas = settings.apis.length > 0 && settings.apis.some(a => a.oasFile && fs.existsSync(path.join(rootDir, a.oasFile)));

  // Step 1: Generate OAS file — always run so the user sees the intro screen,
  // even on re-runs where an OAS already exists. generateOas decides internally
  // whether to re-scan or reuse.
  const oasResult = await generateOas({
    packageDir,
    rootDir,
    update: plan.makeUpdater(0),
    setSpinner,
    aiTool: ['Claude Code', 'Codex'][choice] || 'Claude Code',
    existingOas: hasOas,
  });

  // Step 2 sub 0: Generate API key, register project, upload OAS, write .env.
  // Runs BEFORE the SDK install so the source-file edit in sub 2 triggers an
  // auto-restart (nodemon / tsx --watch / node --watch) that loads the key.
  const { apiKey, projectId, setupKey } = await prepareAccount({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    update: plan.makeUpdater(1),
    setSpinner,
  });

  // Step 2 subs 1-2: Install package + configure SDK.
  await installSdk({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    update: plan.makeUpdater(1),
    setSpinner,
    detectedLanguage: oasResult.detectedLanguage,
    detectedFramework: oasResult.detectedFramework,
    aiTool: ['Claude Code', 'Codex'][choice] || 'Claude Code',
  });

  // Step 2 sub 3: Flag custom auth fields for redaction.
  await runDetectAuth(plan, setSpinner, packageDir, rootDir, loadSettings(rootDir));
  plan.makeUpdater(1)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done', 3: 'done' } });

  // Step 3: Test your setup (with live log polling)
  await testSetup({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    setSpinner,
    update: plan.makeUpdater(2),
    domain: oasResult.domain,
    projectId,
    setupKey,
    aiTool: ['Claude Code', 'Codex'][choice] || 'Claude Code',
  });

  // Step 4: Set up account
  await setupAccount({
    rootDir,
    update: plan.makeUpdater(3),
    apiKey,
    projectId,
    setupKey,
  });

  // Step 5: Done!
  plan.makeUpdater(4)({ status: 'done' });
  setupInProgress = false;

} else if (command === 'clear') {
  const cwd = process.cwd();
  const { rootDir: clearRoot } = resolveProjectDirs(cwd);

  // Reset the site DB
  try {
    const res = await fetch(`${SITE_URL}/api/reset`, { method: 'POST' });
    if (res.ok) console.log(green('  ✓ Site database cleared.'));
  } catch {
    console.log(dim('  Site not running — skipped DB reset.'));
  }

  // Remove .api/ directory
  const target = path.join(clearRoot, '.api');
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true });
    console.log(green('  ✓ .api/ removed.'));
  } else {
    console.log(dim('  No .api/ directory found.'));
  }

  // Uninstall SDK package
  const pkgJson = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const deps = pkg.dependencies || {};
    const hasRestless = '@restlessai/sdk' in deps;
    const hasReadme = 'readmeio' in deps;

    if (hasRestless || hasReadme) {
      const toRemove = [
        hasRestless && '@restlessai/sdk',
        hasReadme && 'readmeio',
      ].filter(Boolean).join(' ');

      try {
        execSync(`npm uninstall ${toRemove}`, { cwd, stdio: 'pipe' });
        console.log(green(`  ✓ Uninstalled ${toRemove}.`));
      } catch {
        console.log(dim(`  Could not uninstall ${toRemove} — remove manually.`));
      }
    }
  }
} else if (command === 'debug') {
  const rawRequestIdArg = process.argv[3];
  if (!rawRequestIdArg) {
    console.log(red('\n  ✗ Missing request ID.\n'));
    console.log('  Usage: npx api debug <request-id>\n');
    process.exit(1);
  }

  // Strip decorative prefix (e.g. "TST-abc123" → "abc123") — the prefix is interchangeable
  const requestId = stripRequestIdPrefix(rawRequestIdArg);

  // Load prefix for display — check per-API first, fall back to top-level for backwards compat
  const { packageDir: debugPackageDir, rootDir: debugRootDir } = resolveProjectDirs(process.cwd());
  const debugSettings = loadSettings(debugRootDir);
  const idPrefix = debugSettings.apis?.[0]?.requestIdPrefix || debugSettings.requestIdPrefix || '';

  // Parse --ask flag for non-interactive mode
  const askIndex = process.argv.indexOf('--ask');
  const inlineQuestion = askIndex !== -1 ? process.argv[askIndex + 1] : null;

  // Detect non-interactive environments (CI, piped output, Claude Code, etc.)
  const isTTY = process.stdout.isTTY && process.stdin.isTTY && !inlineQuestion;
  const isPlain = !isTTY || process.env.CLAUDECODE === '1';

  // Plain-text formatting helpers (no ANSI codes)
  const p = {
    bold: isPlain ? (s) => s : bold,
    dim: isPlain ? (s) => s : dim,
    green: isPlain ? (s) => s : green,
    red: isPlain ? (s) => s : red,
    cyan: isPlain ? (s) => s : cyan,
  };


  // Fetch log by request ID (UUID) — no projectId needed, the server searches all projects
  const logUrl = `${SITE_URL}/api/logs/${requestId}/public`;
  let log;
  try {
    const res = await fetch(logUrl);
    if (res.ok) {
      log = await res.json();
    }
  } catch {}

  // If not found, wait for the SDK to flush and retry
  if (!log) {
    process.stdout.write(p.dim('\n  Waiting for log to be ingested...'));
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await fetch(logUrl);
        if (res.ok) {
          log = await res.json();
          break;
        }
      } catch {}
      process.stdout.write('.');
    }
    console.log('');
  }

  if (!log) {
    console.log(p.red(`\n  ✗ Log not found for request ID: ${requestId}\n`));
    console.log(p.dim('  Make sure the API server is running and the SDK is configured.\n'));
    process.exit(1);
  }

  const har = log.har || {};
  const req = har.request || {};
  const res = har.response || {};
  const isError = log.status >= 400;

  // Status line
  console.log('');
  const statusLabel = isError ? p.red(`${log.status}`) : p.green(`${log.status}`);
  console.log(`  ${p.bold(log.method)} ${log.url} ${statusLabel}${log.duration != null ? p.dim(` ${Math.round(log.duration)}ms`) : ''}`);
  const displayId = formatRequestId(log.requestId, idPrefix);
  console.log(p.dim(`  ${new Date(log.createdAt + 'Z').toLocaleString()}  •  ${displayId}`));

  // User
  if (log.user && Object.keys(log.user).length > 0) {
    const parts = Object.entries(log.user).map(([k, v]) => `${p.dim(k + ':')} ${v}`).join('  ');
    console.log(`  ${parts}`);
  }

  // Request
  console.log(`\n  ${p.bold('Request')}`);
  console.log(isPlain ? '  ' + '─'.repeat(36) : dim('  ─'.repeat(36)));

  if (req.headers?.length) {
    for (const h of req.headers) {
      console.log(`  ${p.dim(h.name + ':')} ${h.value}`);
    }
  }

  if (req.postData?.text) {
    console.log('');
    try {
      const pretty = JSON.stringify(JSON.parse(req.postData.text), null, 2);
      for (const line of pretty.split('\n')) {
        console.log(`  ${p.cyan(line)}`);
      }
    } catch {
      console.log(`  ${req.postData.text}`);
    }
  }

  // Response
  console.log(`\n  ${p.bold('Response')} ${statusLabel} ${res.statusText || ''}`);
  console.log(isPlain ? '  ' + '─'.repeat(36) : dim('  ─'.repeat(36)));

  if (res.headers?.length) {
    for (const h of res.headers) {
      console.log(`  ${p.dim(h.name + ':')} ${h.value}`);
    }
  }

  if (res.content?.text) {
    console.log('');
    try {
      const pretty = JSON.stringify(JSON.parse(res.content.text), null, 2);
      for (const line of pretty.split('\n')) {
        console.log(`  ${isError ? p.red(line) : line}`);
      }
    } catch {
      console.log(`  ${res.content.text}`);
    }
  }

  // Footer
  console.log(`\n  ${p.dim('View in browser:')} ${SITE_URL}/logs/${requestId}`);
  if (isPlain && !inlineQuestion) {
    console.log(`\n  ${p.bold('Ask AI about this request')} — ask a question in plain English about this log:`);
    console.log(`  npx api debug ${displayId} --ask "why did this fail?"`);
    console.log(`  npx api debug ${displayId} --ask "how do I fix this?"`);
    console.log(`  npx api debug ${displayId} --ask "show me a working curl command"`);
  }
  console.log('');

  // ── AI: ask via site server ──
  const askUrl = `${SITE_URL}/api/logs/${requestId}/ask`;

  async function askAI(question) {
    const res = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, source: 'cli' }),
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();
    return data.answer;
  }

  // ── --ask mode: single question, print answer, exit ──
  if (inlineQuestion) {
    process.stdout.write(p.dim('  Thinking...\n'));
    try {
      const answer = await askAI(inlineQuestion);
      console.log('');
      for (const line of answer.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      console.log('');
      console.log(p.dim(`  Ask a follow-up: npx api debug ${displayId} --ask "your question here"`));
      console.log('');
    } catch {
      console.log('  Could not generate a response.\n');
    }
  } else if (isTTY) {
    // ── Interactive chat mode ──
    const separator = dim('─'.repeat(72));
    console.log(separator);
    console.log(`  ${bold(cyan('Ask AI'))}  ${dim('Ask anything about this request in plain English')}`);
    console.log(`  ${dim('Examples: "why did this fail?" · "show me a working curl" · "what headers am I missing?"')}`);
    console.log(`  ${dim('Type "exit" to quit.')}`);
    console.log(separator);
    console.log('');

    // Chat input using raw stdin (avoids readline issues after AI calls)
    function chatAsk(promptStr) {
      return new Promise((resolve) => {
        process.stdout.write(promptStr);
        let buffer = '';

        try { process.stdin.setRawMode(true); } catch {}
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (key) => {
          if (key === '\r' || key === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(buffer);
          } else if (key === '\x7f' || key === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (key === '\x03') {
            process.stdin.setRawMode(false);
            process.stdout.write('\n');
            process.exit(0);
          } else if (key.charCodeAt(0) >= 32) {
            buffer += key;
            process.stdout.write(key);
          }
        };

        process.stdin.on('data', onData);
      });
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const question = await chatAsk(`  ${bold(green('You ❯'))} `);
      if (!question || !question.trim()) continue;
      if (question.trim().toLowerCase() === 'exit') {
        console.log(`\n  ${dim('Goodbye!')}\n`);
        break;
      }

      const spinner = startSpinner('Thinking...');

      try {
        const answer = await askAI(question.trim());

        spinner.stop();

        const lines = answer.trim().split('\n');
        console.log('');
        for (const line of lines) {
          console.log(`  ${cyan('✦')} ${line}`);
        }
        console.log('');
      } catch {
        spinner.stop();
        console.log(`\n  ${red('✗')} Could not generate a response. Try again.\n`);
      }
    }
  }

} else if (command === 'skill') {
  // npx api skill <docs-url>            → fetch /skill.md, preview, prompt, install
  // npx api skill <docs-url> --manual   → just print the skill + target path

  const rawUrl = process.argv[3];
  const manualFlag = process.argv.includes('--manual') || process.argv.includes('--print');

  if (!rawUrl) {
    console.log(red('\n  ✗ Missing docs URL.\n'));
    console.log('  Usage: npx api skill <docs-url>\n');
    console.log(`  Example: npx api skill ${dim('docs.example.com/docs/my-project')}\n`);
    process.exit(1);
  }

  // Accept "docs.site.com", "https://docs.site.com/docs/x", "docs.site.com/docs/x/skill.md".
  // We always fetch <input>/skill.md unless the input already ends in skill.md.
  function buildSkillUrl(input) {
    let s = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    if (!/\/skill\.md$/i.test(s)) s = `${s}/skill.md`;
    return s;
  }

  const skillUrl = buildSkillUrl(rawUrl);
  process.stdout.write(`\n  ${dim('Fetching')} ${cyan(skillUrl)}${dim('…')}\n`);

  let body;
  try {
    const res = await fetch(skillUrl);
    if (!res.ok) {
      console.log(`\n  ${red('✗')} ${red(`HTTP ${res.status}`)} ${dim(`from ${skillUrl}`)}\n`);
      console.log(dim('  Make sure the URL points at a project on a Restless docs deployment.\n'));
      process.exit(1);
    }
    body = await res.text();
  } catch (err) {
    console.log(`\n  ${red('✗')} Could not reach ${cyan(skillUrl)}: ${err.message}\n`);
    process.exit(1);
  }

  // Pull `name:` from the frontmatter so the install path matches whatever
  // the server picked. Fallback to a slug derived from the URL host if the
  // frontmatter is missing or malformed.
  function parseSkillName(md) {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return null;
    const nameLine = m[1].split('\n').find((l) => /^name:\s*/.test(l));
    if (!nameLine) return null;
    return nameLine.replace(/^name:\s*/, '').trim() || null;
  }

  const skillName = parseSkillName(body)
    || rawUrl.replace(/^https?:\/\//i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const targetDir = path.join(os.homedir(), '.claude', 'skills', skillName);
  const targetPath = path.join(targetDir, 'SKILL.md');

  // Preview block — same in auto and manual modes so the user always
  // sees what's about to land on disk before any side effect.
  console.log();
  console.log(`  ${dim('─'.repeat(64))}`);
  for (const line of body.split('\n')) {
    console.log(`  ${dim('│')} ${line}`);
  }
  console.log(`  ${dim('─'.repeat(64))}`);
  console.log();

  const home = os.homedir();
  const prettyTarget = targetPath.startsWith(home) ? `~${targetPath.slice(home.length)}` : targetPath;

  if (manualFlag) {
    console.log(`  ${bold('Manual install')}\n`);
    console.log(`  Save the markdown above to:\n`);
    console.log(`    ${cyan(prettyTarget)}\n`);
    console.log(`  Quick way:\n`);
    console.log(`    ${dim('mkdir -p ~/.claude/skills/' + skillName + ' && curl -sSL ' + skillUrl + ' > ' + prettyTarget)}\n`);
    process.exit(0);
  }

  console.log(`  ${dim('This will install to')} ${cyan(prettyTarget)}\n`);
  process.stdout.write(`  Install? ${dim('[Y/n] ')}`);
  const ok = await askYesNo('', { defaultValue: true });
  if (!ok) {
    console.log(dim('\n  Cancelled. To grab it manually, rerun with --manual.\n'));
    process.exit(0);
  }

  // Refuse to overwrite an existing skill silently — could clobber an
  // edited copy. Confirm the overwrite explicitly.
  if (fs.existsSync(targetPath)) {
    console.log();
    console.log(`  ${yellow('!')} ${prettyTarget} already exists.`);
    process.stdout.write(`  Overwrite? ${dim('[y/N] ')}`);
    const overwrite = await askYesNo('', { defaultValue: false });
    if (!overwrite) {
      console.log(dim('\n  Left existing file alone.\n'));
      process.exit(0);
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, body, 'utf8');

  console.log(`\n  ${green('✓')} Installed ${bold(skillName)} → ${cyan(prettyTarget)}\n`);

  console.log(`  ${bold('How to use it')}`);
  console.log();
  console.log(`  Claude Code picks the skill up automatically — start a new session`);
  console.log(`  (or reload the running one) and ask anything about this API.`);
  console.log();
  console.log(`  Try:`);
  console.log(`    ${dim('"using ' + skillName + ', show me the public endpoints"')}`);
  console.log();
  console.log(`  The skill points at the project's MCP server, so live endpoint`);
  console.log(`  details flow in on demand. To uninstall, just delete the file.`);
  console.log();

} else {
  console.log(`Unknown command: ${command}`);
  console.log('Usage: api setup | clear | debug <request-id> | skill <docs-url>');
}
