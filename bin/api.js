#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, yellow, ask, startSpinner } from '../lib/ui.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import { createPlanManager } from '../lib/runner.js';
import { resolveProjectDirs } from '../lib/project.js';
import generateOas from '../steps/generate-oas.js';
import installSdk from '../steps/install-sdk.js';
import setupSdk from '../steps/setup-sdk.js';
import setupAccount from '../steps/setup-account.js';
import testSetup from '../steps/test-setup.js';
import { SITE_URL } from '../lib/config.js';

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

const command = process.argv[2];

if (command === 'setup') {
  console.log('');
  console.log(`  We're going to add ${bold('superpowers')} to your API and make it ${bold('AI-first')}.`);
  console.log(`  ${dim("We'll handle all the setup — just confirm and we'll take care of the rest.")}\n`);

  const plan = createPlanManager();

  // Show the initial plan as static output (not managed by the redraw system)
  plan.drawInitial();

  if (!hasClaude()) {
    console.log('');
    console.log(red('  ✗ Claude is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @anthropic-ai/claude-code\n'));
    process.exit(1);
  }

  console.log('');
  const answer = await ask("  We'll use Claude to set this up. Proceed? (Y/n) ");
  if (answer.toLowerCase() === 'n') {
    console.log('\n  Setup cancelled.\n');
    process.exit(0);
  }
  // packageDir = where the user ran the command (scopes what we analyze)
  // rootDir = git root (where .api/ lives)
  const { packageDir, rootDir } = resolveProjectDirs(process.cwd());

  // Set the header (static content above the plan) and pin — from here on, render() manages the whole screen.
  plan.setHeader([
    '',
    `  We're going to add ${bold('superpowers')} to your API and make it ${bold('AI-first')}.`,
    `  ${dim("We'll handle all the setup — just confirm and we'll take care of the rest.")}`,
    '',
  ]);
  plan.pin();
  setupInProgress = true;

  const { setSpinner } = plan;

  // Check what's already done
  const settings = (await import('../lib/settings.js')).loadSettings(rootDir);
  const hasOas = settings.apis.length > 0 && settings.apis.some(a => fs.existsSync(path.join(rootDir, a.oasFile)));
  // Check for the SDK package in node_modules
  const sdkPath1 = path.join(packageDir, 'node_modules', 'sdk', 'dist', 'index.js');
  const sdkPath2 = path.join(packageDir, 'node_modules', '@restless', 'sdk', 'dist', 'index.js');
  const sdkPath3 = path.join(packageDir, 'node_modules', 'readmeio');
  const hasSDKPackage = fs.existsSync(sdkPath1) || fs.existsSync(sdkPath2) || fs.existsSync(sdkPath3);

  // Check if the SDK is actually wired up in source code (not just installed)
  let hasSDKConfigured = false;
  try {
    const { execSync: execCheck } = await import('child_process');
    const grepResult = execCheck(`grep -r "@restless/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`, { cwd: packageDir, encoding: 'utf8' });
    const sourceFiles = grepResult.trim().split('\n').filter(f => f && !f.includes('node_modules'));
    hasSDKConfigured = sourceFiles.length > 0;
  } catch {}

  let oasResult;

  // Step 1: Generate OAS file
  if (hasOas) {
    const specNames = settings.apis.map(a => a.name).join(', ');
    plan.makeUpdater(0)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done' }, message: [
      dim(`  Skipping — found existing OAS: ${specNames}`),
      dim('  Press Enter to continue.'),
    ]});
    await ask('');
    oasResult = {
      detectedLanguage: settings.apis[0].language,
      detectedFramework: settings.apis[0].framework,
      domain: settings.apis[0].baseUrl,
    };
  } else {
    oasResult = await generateOas({
      packageDir,
      rootDir,
      update: plan.makeUpdater(0),
      setSpinner,
    });
  }

  // Step 2: Install SDK (detect language, install package, configure)
  if (hasSDKPackage && hasSDKConfigured) {
    // Both installed and wired up — skip entirely
    plan.makeUpdater(1)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done' }, message: [
      dim('  Skipping — SDK is already installed and configured.'),
      dim('  Press Enter to continue.'),
    ]});
    await ask('');
  } else if (hasSDKPackage && !hasSDKConfigured) {
    // Package installed but not wired into source code — just run setup
    plan.makeUpdater(1)({ status: 'active', sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      dim('  SDK package found but not configured in source code. Setting up...'),
    ]});

    const guideLanguage = oasResult.detectedLanguage || 'javascript';

    await setupSdk({
      packageDir,
      rootDir,
      update: plan.makeUpdater(1),
      setSpinner,
      detectedLanguage: oasResult.detectedLanguage || 'javascript',
      detectedFramework: oasResult.detectedFramework,
      guideLanguage,
    });
  } else {
    // Not installed at all — do both install and setup
    const sdkResult = await installSdk({
      packageDir,
      rootDir,
      update: plan.makeUpdater(1),
      setSpinner,
      detectedLanguage: oasResult.detectedLanguage,
      detectedFramework: oasResult.detectedFramework,
    });

    // setupSdk handles sub 2 (configure)
    await setupSdk({
      packageDir,
      rootDir,
      update: plan.makeUpdater(1), // same step, continues from sub 2
      setSpinner,
      detectedLanguage: sdkResult.detectedLanguage,
      detectedFramework: sdkResult.detectedFramework,
      guideLanguage: sdkResult.guideLanguage,
    });
  }

  // Generate API key and register with the site
  const apiKey = 'rdme_' + crypto.randomBytes(32).toString('hex');
  const writeKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  let projectId, setupKey;
  console.log(dim('  Registering project...'));
  try {
    const res = await fetch(`${SITE_URL}/api/projects/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write_key_hash: writeKeyHash }),
    });
    if (res.ok) {
      const data = await res.json();
      projectId = data.project_id;
      setupKey = data.setup_key;
    } else {
      const text = await res.text();
      console.error(red(`  ✗ Failed to initialize project: ${res.status} ${text}`));
      process.exit(1);
    }
  } catch (err) {
    console.error(red(`  ✗ Could not reach the site at ${SITE_URL}. Is it running?`));
    process.exit(1);
  }
  console.log(dim('  Project registered.'));

  // Upload the OAS file to the site (pre-claim, so it's ready when the user logs in)
  const settings2 = (await import('../lib/settings.js')).loadSettings(rootDir);
  const oasApi = settings2.apis[0];
  if (oasApi?.oasFile) {
    try {
      const oasPath = path.join(rootDir, oasApi.oasFile);
      const oasRaw = fs.readFileSync(oasPath, 'utf8');
      const isJson = oasPath.endsWith('.json');

      const uploadRes = await fetch(`${SITE_URL}/api/projects/${projectId}/oas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key: setupKey, oas_raw: oasRaw, format: isJson ? 'json' : 'yaml' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!uploadRes.ok) {
        // Non-fatal
      }
    } catch {
      // Non-fatal — the project will just not have an OAS until they sync manually
    }
  }

  // Find the .env file and offer to append the API key
  const envCandidates = ['.env', '.env.local'].map(f => path.join(packageDir, f));
  let envFile = envCandidates.find(f => fs.existsSync(f));
  if (!envFile) envFile = path.join(packageDir, '.env');
  const envRelative = path.relative(packageDir, envFile);
  const appendLine = `README_API_KEY=${apiKey}`;
  const appendCmd = `echo 'README_API_KEY=...' >> ${envRelative}`;

  plan.makeUpdater(1)({ status: 'done', message: [
    `  We'll add your API key to ${bold(envRelative)} by running:`,
    '',
    `    ${cyan(appendCmd)}`,
    '',
    dim('  This just appends one line — we never read the file.'),
    '',
    `  ${bold('y')} ${dim('run it')}  ·  ${bold('n')} ${dim("I'll add it myself")}`,
  ]});

  const envAnswer = await ask('  ');
  if (envAnswer.trim().toLowerCase() !== 'n') {
    fs.appendFileSync(envFile, `\n${appendLine}\n`);
    plan.makeUpdater(1)({ status: 'done', message: [
      `  ${green('✓')} Added ${bold('README_API_KEY')} to ${bold(envRelative)}.`,
      `  ${cyan('Restart your server')} so the SDK picks it up.`,
      dim('  Press Enter when ready to test.'),
    ]});
  } else {
    plan.makeUpdater(1)({ status: 'done', message: [
      `  Add this to your ${bold(envRelative)} file:`,
      '',
      `    ${bold(`README_API_KEY=${apiKey}`)}`,
      '',
      `  Then ${cyan('restart your server')} so the SDK picks it up.`,
      dim('  Press Enter when ready to test.'),
    ]});
  }
  await ask('');

  // Step 3: Test your setup (with live log polling)
  await testSetup({
    packageDir,
    rootDir,
    setSpinner,
    update: plan.makeUpdater(2),
    domain: oasResult.domain,
    projectId,
    setupKey,
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
    const hasRestless = '@restless/sdk' in deps || 'sdk' in deps;
    const hasReadme = 'readmeio' in deps;

    if (hasRestless || hasReadme) {
      const toRemove = [
        hasRestless && ('@restless/sdk' in deps ? '@restless/sdk' : 'sdk'),
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
  const requestId = process.argv[3];
  if (!requestId) {
    console.log(red('\n  ✗ Missing request ID.\n'));
    console.log('  Usage: npx api debug <request-id>\n');
    process.exit(1);
  }

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


  // Fetch log by request ID (UUID)
  let log;
  try {
    const res = await fetch(`${SITE_URL}/api/logs/${requestId}/public`);
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
        const res = await fetch(`${SITE_URL}/api/logs/${requestId}/public`);
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
  console.log(`  ${p.bold(log.method)} ${log.url} ${statusLabel} ${p.dim(`${Math.round(log.duration)}ms`)}`);
  console.log(p.dim(`  ${new Date(log.createdAt + 'Z').toLocaleString()}  •  ${log.requestId}`));

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
    console.log(`  npx api debug ${requestId} --ask "why did this fail?"`);
    console.log(`  npx api debug ${requestId} --ask "how do I fix this?"`);
    console.log(`  npx api debug ${requestId} --ask "show me a working curl command"`);
  }
  console.log('');

  // ── AI: shared setup ──
  const logSummary = JSON.stringify({
    method: log.method,
    url: log.url,
    status: log.status,
    duration: log.duration,
    requestId: log.requestId,
    user: log.user,
    request: { headers: req.headers, body: req.postData?.text },
    response: { status: res.status, statusText: res.statusText, headers: res.headers, body: res.content?.text },
  }, null, 2);

  // Run AI in a child process so the Agent SDK doesn't steal stdin
  const { spawn: spawnChild } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const __filename = fileURLToPath(import.meta.url);
  const workerPath = path.resolve(path.dirname(__filename), '..', 'lib', 'ai-worker.js');

  function askAI(promptText, onStatus) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(process.execPath, [workerPath], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: process.env,
      });

      let raw = '';
      child.stdout.on('data', (chunk) => { raw += chunk.toString(); });

      child.stdin.write(JSON.stringify({ prompt: promptText, cwd: process.cwd() }) + '\n');
      child.stdin.end();

      child.on('close', (code) => {
        // Parse prefixed lines: STATUS: for progress, RESULT: for answer text
        const result = raw.split('\n')
          .filter(l => l.startsWith('RESULT:'))
          .map(l => l.slice(7))
          .join('\n');
        if (code === 0 && result.trim()) resolve(result.trim());
        else reject(new Error('AI worker failed'));
      });
    });
  }

  // ── --ask mode: single question, print answer, exit ──
  if (inlineQuestion) {
    const prompt = loadPrompt('debug-chat', { logData: logSummary, question: inlineQuestion });

    process.stdout.write(p.dim('  Thinking...\n'));
    try {
      const answer = await askAI(prompt);
      console.log('');
      for (const line of answer.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      console.log('');
      console.log(p.dim(`  Ask a follow-up: npx api debug ${requestId} --ask "your question here"`));
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
        const prompt = loadPrompt('debug-chat', { logData: logSummary, question: question.trim() });
        const answer = await askAI(prompt, (text) => spinner.update(text));

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

} else {
  console.log(`Unknown command: ${command}`);
  console.log('Usage: api setup | clear | debug <request-id>');
}
