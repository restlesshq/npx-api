#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, yellow, orange, ask, askYesNo, startSpinner, singleSelect, typeLine, typeOut, inlineStatus, waitForKey, animateLogoIn, printLogo } from '../lib/ui.js';
import { runAI, loadPrompt, setProvider } from '../lib/ai.js';
import { createPlanManager } from '../lib/runner.js';
import { resolveProjectDirs, findGitRoot } from '../lib/project.js';
import { setGitRoot } from '../lib/pathGuard.js';
import generateOas from '../steps/generate-oas.js';
import prepareAccount, { resolveApiDir } from '../steps/prepare-account.js';
import installSdk, { resolveInstallDir } from '../steps/install-sdk.js';
import { createSetupContext, redactSetupContext, getSdkLineSpec } from '../lib/setup-context.js';
import verifyOwnerId from '../steps/verify-owner-id.js';
import finalChecks from '../steps/final-checks.js';
import setupAccount from '../steps/setup-account.js';
import testSetup from '../steps/test-setup.js';
import { SITE_URL, CALENDLY_URL, CLI_NAME } from '../lib/config.js';
import { loadSettings, saveSettings, formatRequestId, stripRequestIdPrefix } from '../lib/settings.js';
import { fatalError, isFatalExit } from '../lib/errors.js';
import { findSdkReferences } from '../lib/grep-sdk.js';
import * as debug from '../lib/debug.js';

// Initialize debug capture FIRST, before anything else writes to stdout -
// the stream wrappers need to be in place to record the welcome screen.
const debugEnabled = debug.init({ argv: process.argv });
debug.attachExitHandlers();

// Hard ceiling: no fs write, AI tool, or helper anywhere in this process
// is allowed to touch a path outside the git root the user invoked us
// from. Set BEFORE any user-flow code runs so even early bootstrap
// writes pass through the guard.
setGitRoot(findGitRoot(process.cwd()));

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
    console.log(dim(`\n  Setup interrupted. Run \`npx ${CLI_NAME} init\` again to resume.\n`));
  }
  debug.flushAndExit(0);
});

// Last-resort safety net. Any thrown error or rejected promise that nothing
// else caught funnels into fatalError so the user always sees something
// concrete instead of a silent exit / red step with no message.
function _surfaceFatal(err) {
  // FatalExit is the sentinel `fatalError` throws to stop the calling
  // stack - the error has already been reported and an async exit is in
  // flight. Just keep the screen alive while the exit completes.
  if (isFatalExit(err)) {
    process.stdout.write('\x1b[?25h');
    return;
  }
  process.stdout.write('\x1b[?25h'); // make sure the cursor is visible
  const message = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack).split('\n').slice(0, 4) : [];
  try {
    fatalError(`Unexpected error: ${message}`, stack);
  } catch (e) {
    // fatalError throws FatalExit by design - swallow so the handler
    // doesn't re-fire on itself.
    if (!isFatalExit(e)) throw e;
  }
}
process.on('uncaughtException', _surfaceFatal);
process.on('unhandledRejection', _surfaceFatal);

function hasClaude() {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the prompt sent to Claude (either via the local SDK on "yes" or
 * printed for the user to paste elsewhere on "no"). The prompt is the
 * same in both cases so what the user sees if they pick "give me a
 * prompt" matches what they'd have gotten from the SDK run.
 */
function buildFixPrompt(log) {
  const har = log.har || {};
  const req = har.request || {};
  const res = har.response || {};
  const reqHeaders = Array.isArray(req.headers)
    ? req.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
    : '';
  const resHeaders = Array.isArray(res.headers)
    ? res.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
    : '';
  const reqBody = req.postData?.text || '(empty)';
  const resBody = res.content?.text || '(empty)';
  return [
    'A developer just got an HTTP error from their API and is asking for help fixing it.',
    '',
    '--- ERROR DETAILS ---',
    `Method: ${log.method || req.method || '?'}`,
    `URL: ${log.url || req.url || '?'}`,
    `Status: ${log.status || res.status || '?'}${res.statusText ? ' ' + res.statusText : ''}`,
    '',
    'Request headers:',
    reqHeaders || '(none captured)',
    '',
    'Request body:',
    reqBody,
    '',
    'Response headers:',
    resHeaders || '(none captured)',
    '',
    'Response body:',
    resBody,
    '--- END ---',
    '',
    'Your task:',
    '1. Find the code in this project that handles this endpoint or makes this call.',
    '2. Diagnose what went wrong, using the error code, response body, and any validation messages.',
    '3. Apply a minimal fix. Edit files in place; show the diff via your normal tools.',
    '',
    'If the failing endpoint is a third-party / upstream API (not in this repo), explain what the caller in THIS repo should change instead (different params, headers, payload shape, etc.).',
    '',
    'Keep the change tightly scoped to this error. Do not refactor surrounding code.',
  ].join('\n');
}

/**
 * Fire-and-forget telemetry. Sends an event name + tiny structured
 * context (method/status/fingerprint) so we can count auto-fix usage
 * without ever seeing the user's code, prompts, or bodies. Failures
 * are swallowed so a tracking outage never breaks the debug flow.
 */
async function trackDebugEvent(requestId, event, { log, source = 'cli' } = {}) {
  try {
    const payload = { event, source };
    if (log) {
      if (typeof log.method === 'string') payload.method = log.method;
      if (typeof log.status === 'number') payload.status = log.status;
      const fp = log.errorFingerprint?.key;
      if (typeof fp === 'string') payload.fingerprintKey = fp;
    }
    await fetch(`${SITE_URL}/api/logs/${requestId}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Don't block the user on slow telemetry.
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    /* swallow */
  }
}

/**
 * 3-way edit-permission picker. Only reached after the user has
 * already opted into "Fix it for me" at the top level — so by this
 * point they want help; the question is just whether they want the
 * Claude SDK to apply the edit, or they prefer to copy a prompt.
 *
 * Yes  -> run Claude Agent SDK in the user's repo (their tokens, their
 *         machine; the prompt is the only thing that leaves).
 * No   -> print the same prompt the SDK would have used so the dev
 *         can paste it into the AI of their choice.
 * Maybe-> explain the trust model, then re-prompt.
 */
async function offerFix({ log, requestId, cwd, p, CLI_NAME, displayId }) {
  const prompt = buildFixPrompt(log);

  while (true) {
    const choice = await singleSelect(
      [
        { label: 'Yes, use Claude SDK to edit', hint: 'Run Claude on your machine to find and fix the bug.' },
        { label: 'No, give me a prompt to fix it', hint: 'Print a prompt you can paste into any AI.' },
        { label: 'Maybe, tell me more first', hint: 'See exactly what happens before deciding.' },
      ],
      { message: 'Can I edit code directly?', defaultIndex: 0 },
    );

    if (choice === 0) {
      console.log('');
      void trackDebugEvent(requestId, 'fix.start', { log });
      try {
        await runAI(prompt, cwd);
        console.log('');
        console.log(`  ${p.green('✓')} Done. Review the changes with ${p.cyan('git diff')} before keeping them.`);
        console.log('');
        void trackDebugEvent(requestId, 'fix.complete', { log });
      } catch (err) {
        console.log(`\n  ${p.red('✗')} The fix run failed: ${err?.message || err}\n`);
        void trackDebugEvent(requestId, 'fix.failed', { log });
      }
      return;
    }

    if (choice === 1) {
      console.log('');
      console.log(`  ${p.bold('Paste this into your AI of choice:')}`);
      console.log(p.dim('  ' + '─'.repeat(60)));
      for (const line of prompt.split('\n')) console.log('  ' + line);
      console.log(p.dim('  ' + '─'.repeat(60)));
      console.log('');
      console.log(`  ${p.dim('Or re-run with:')} npx ${CLI_NAME} debug ${displayId}`);
      console.log('');
      void trackDebugEvent(requestId, 'fix.prompt_only', { log });
      return;
    }

    // Maybe: explain and loop back to the menu.
    console.log('');
    console.log(`  ${p.bold('Here\'s what "Yes" actually does:')}`);
    console.log(`    • Runs your locally-installed ${p.cyan('claude')} CLI in this repo (${cwd}).`);
    console.log(`    • Uses ${p.cyan('your')} Anthropic tokens. The request goes to ${p.cyan('api.anthropic.com')} and nowhere else.`);
    console.log(`    • Does not contact Restless servers, third parties, or upload anything.`);
    console.log(`    • File edits are confined to this git repo (path guard rejects writes outside it).`);
    console.log(`    • You can review every change with ${p.cyan('git diff')} before keeping it.`);
    console.log('');
    void trackDebugEvent(requestId, 'fix.explained', { log });
  }
}

function hasCodex() {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Codex stores auth in ~/.codex/auth.json after `codex login`. We also accept
// OPENAI_API_KEY as a fallback because env-only setups skip the login dance
// entirely. We check both rather than running `codex` itself, since spawning
// the CLI just to validate auth is slow and noisy.
function hasCodexAuth() {
  if (process.env.OPENAI_API_KEY) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  } catch {
    return false;
  }
}

// The Cursor *agent* is `cursor-agent`, NOT `cursor` (which is the IDE
// launcher). We must check the agent binary specifically.
function hasCursor() {
  try {
    execSync('which cursor-agent', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Cursor stores its login under ~/.cursor/ after `cursor-agent login`; we also
// accept CURSOR_API_KEY. Same rationale as hasCodexAuth: check artifacts on
// disk instead of spawning the CLI just to validate auth.
function hasCursorAuth() {
  if (process.env.CURSOR_API_KEY) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), '.cursor', 'cli-config.json'));
  } catch {
    return false;
  }
}


const command = process.argv[2];

/**
 * One-shot banner shown when `--debug` is on. Makes it impossible to
 * miss that the run is being captured and uploaded - keeps the user
 * in control even though they enabled it themselves. Returns nothing
 * when debug is off.
 */
async function showDebugBanner() {
  if (!debugEnabled) return;
  console.log('');
  console.log(`  ${bold(yellow('⚠  Debug mode is on.'))}`);
  console.log(`  ${dim('Everything in this run - your input, the AI tool calls, output, and errors -')}`);
  console.log(`  ${dim('will be uploaded to the Restless team when the CLI exits.')}`);
  console.log(`  ${dim('Normal runs send nothing. Re-run without --debug to disable.')}`);
  console.log('');
}

await showDebugBanner();

if (command === 'init' || command === 'setup' || command === 'supercharge') {
  // ── Welcome screen ────────────────────────────────────────────────────
  // Clear viewport + scrollback so the welcome starts at the top of the
  // terminal, matching where every subsequent screen lands after each
  // transition clears + homes the cursor.
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
  console.log('');
  await animateLogoIn();
  console.log('');

  // "Restless helps make [400 Bad Request] into [200 Okay]."
  // Each status code shows a brief spinner, then settles into a colored
  // circle + the code, and typing continues. No erase-and-replace -
  // the spinner lands in place where the circle ends up.
  // Swap `spinnerStyle` to try: arc, halfcircle, piefill, pulse, sparkle, concentric, braille
  const spinnerStyle = 'concentric';

  await typeOut(`  Restless makes sure every `);
  await inlineStatus({ code: '400 Bad Request', success: false, style: spinnerStyle });
  await typeOut(` turns out `);
  await inlineStatus({ code: '200 Okay', success: true, style: spinnerStyle });
  await typeLine(`.`);
  console.log('');

  await typeLine(`  It's not just another observability platform (although you can use it`);
  await typeLine(`  to see what your users are up to!).`);
  console.log('');
  await typeLine(`  Think of us more as an API success platform. We give humans, AI and`);
  await typeLine(`  you the tools to quickly make successful calls.`);
  console.log('');
  await typeLine(`  ${bold(yellow('Ready to supercharge your API?'))}`);
  console.log('');

  // Boxed CTA: the focal point of the welcome. The ▸ inside pulses while
  // we wait for input, so we hide the native blinking cursor - one cue
  // instead of two.
  const ctaText = 'Press ENTER to get started';
  const boxBody = `  ▸  ${ctaText}  `;
  const w = boxBody.length;
  console.log(`  ${dim('╭' + '─'.repeat(w) + '╮')}`);
  console.log(`  ${dim('│')}  ${green('▸')}  ${green(ctaText)}  ${dim('│')}`);
  console.log(`  ${dim('╰' + '─'.repeat(w) + '╯')}`);
  console.log('');
  console.log(`  ${dim("We use AI for the setup, but we'll ask permission before we do anything.")}`);
  console.log(`  ${dim(`Press [${bold('d')}${'\x1b[2m'}] to try this on a demo repo · Press [${bold('h')}${'\x1b[2m'}] to set up time with a human`)}`);

  process.stdout.write('\x1b[?25l'); // hide terminal cursor while we own the screen
  process.stdout.write('\x1b7');     // save current row as the home position for the animation

  // Pulse: dim → green → bold green → green, repeat. Cycles through ~1.1s.
  // Arrow lives 5 rows above the saved cursor (3 box rows + blank + 2 dim
  // copy rows), at column 6 inside the box.
  const arrowFrames = [dim('▸'), green('▸'), bold(green('▸')), green('▸')];
  let arrowFrame = 0;
  const arrowInterval = setInterval(() => {
    arrowFrame = (arrowFrame + 1) % arrowFrames.length;
    process.stdout.write('\x1b8\x1b[5A\x1b[6G' + arrowFrames[arrowFrame] + '\x1b8');
  }, 280);

  let welcomeKey;
  while (true) {
    welcomeKey = await waitForKey();
    if (
      welcomeKey === '\r' || welcomeKey === '\n' ||
      welcomeKey === 'd' || welcomeKey === 'D' ||
      welcomeKey === 'h' || welcomeKey === 'H'
    ) break;
  }

  clearInterval(arrowInterval);
  process.stdout.write('\x1b[?25h'); // show cursor again
  process.stdout.write('\n');         // start subsequent output on a fresh line

  if (welcomeKey === 'd' || welcomeKey === 'D') {
    console.log('');
    console.log(`  ${dim('Demo repo flow is coming soon. In the meantime, clone')}`);
    console.log(`  ${dim(`https://github.com/restlessai/demo and run \`npx ${CLI_NAME} init\` there.`)}`);
    console.log('');
    await debug.flushAndExit(0);
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
    await debug.flushAndExit(0);
  }

  // ENTER: continue normal setup.
  // Clear the viewport + scrollback so the welcome doesn't linger.
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
  // ──────────────────────────────────────────────────────────────────────

  const plan = createPlanManager();

  console.log('');
  printLogo();
  console.log('');

  // Show the initial plan as static output (not managed by the redraw system)
  plan.drawInitial();

  console.log('');
  const claudeInstalled = hasClaude();
  const codexInstalled = hasCodex();
  const cursorInstalled = hasCursor();
  console.log(`  We use your local AI tooling (Claude, Codex, or Cursor) to set up the project.`);
  console.log(`  None of your code is ever seen by us. The AI runs on your machine and`);
  console.log(`  talks to our SDKs directly. We won't upload anything to our servers`);
  console.log(`  without checking with you first.`);
  console.log('');
  const claudeLabel = claudeInstalled
    ? `Claude ${dim('(Recommended)')}`
    : `${dim('Claude (Recommended)')}`;
  const codexLabel = codexInstalled ? 'Codex' : dim('Codex');
  const cursorLabel = cursorInstalled ? 'Cursor' : dim('Cursor');
  const choice = await singleSelect(
    [
      { label: claudeLabel, hint: claudeInstalled ? 'Use Claude Code running locally on your machine.' : "Claude Code isn't installed - we'll show you how." },
      { label: codexLabel, hint: codexInstalled ? 'Use the Codex CLI running locally on your machine.' : "Codex isn't installed - we'll show you how." },
      { label: cursorLabel, hint: cursorInstalled ? 'Use the Cursor agent (cursor-agent) running locally on your machine.' : "Cursor isn't installed - we'll show you how." },
      { label: 'Manual install', hint: "We'll book a quick call so we can pair on it together." },
      { label: 'Learn more', hint: "Read about how setup works and what we touch before deciding." },
    ],
    { message: 'How would you like to set this up?', defaultIndex: 0 },
  );

  // Clear the viewport so after-selection stuff starts clean at the top.
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');

  if (choice === 4) {
    // "Learn more" - explain how it works
    console.log('');
    console.log(`  ${bold('What this does')}`);
    console.log('');
    console.log(`  Restless wires your API up so you can see what's happening in real time and`);
    console.log(`  help your users make successful calls. This CLI does the boring part: scans`);
    console.log(`  your code, generates an OpenAPI spec, installs the SDK, and hooks it into`);
    console.log(`  your server's middleware.`);
    console.log('');
    console.log(`  When it finishes, you sign in to claim the project and your logs start`);
    console.log(`  showing up on the dashboard.`);
    console.log('');
    console.log(`  ${bold('How we keep it safe')}`);
    console.log('');
    console.log(`  ${green('1.')} ${bold('Your code never leaves your machine.')} Scanning is done by Claude,`);
    console.log(`     Codex, or Cursor running locally via the CLI you already have installed. We don't`);
    console.log(`     proxy it, upload it, or see any of it.`);
    console.log('');
    console.log(`  ${green('2.')} ${bold('We handle the fiddly bits.')} Framework-specific middleware placement,`);
    console.log(`     auth-header redaction, env wiring, and OAS generation are all done for you.`);
    console.log('');
    console.log(`  ${green('3.')} ${bold('Nothing runs without your OK.')} You see every file change and command`);
    console.log(`     before it happens, and can bail at any point.`);
    console.log('');
    console.log(`  Run ${cyan(`npx ${CLI_NAME} init`)} again when you're ready.`);
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 0 && !claudeInstalled) {
    console.log('');
    console.log(red('  ✗ Claude is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @anthropic-ai/claude-code'));
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 1 && !codexInstalled) {
    console.log('');
    console.log(red('  ✗ Codex is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @openai/codex'));
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 1 && !hasCodexAuth()) {
    console.log('');
    console.log(red("  ✗ Codex isn't logged in.\n"));
    console.log('  Sign in with:');
    console.log(cyan('    codex login'));
    console.log('');
    console.log(`  ${dim(`Or set ${cyan('OPENAI_API_KEY')}${'\x1b[2m'} in your env.`)}`);
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 2 && !cursorInstalled) {
    console.log('');
    console.log(red('  ✗ Cursor is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    curl https://cursor.com/install -fsS | bash'));
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 2 && !hasCursorAuth()) {
    console.log('');
    console.log(red("  ✗ Cursor isn't logged in.\n"));
    console.log('  Sign in with:');
    console.log(cyan('    cursor-agent login'));
    console.log('');
    console.log(`  ${dim(`Or set ${cyan('CURSOR_API_KEY')}${'\x1b[2m'} in your env.`)}`);
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  // Pick the AI provider before any step calls runAI(). Manual / Learn-more
  // never reach here.
  if (choice === 0) setProvider('claude');
  else if (choice === 1) setProvider('codex');
  else if (choice === 2) setProvider('cursor');

  // Manual: not supported yet - punt to Calendly so they can talk to a human.
  if (choice === 3) {
    const { execSync } = await import('child_process');
    console.log('');
    console.log(`  We don't support a manual setup currently, but book time with a`);
    console.log(`  human if you'd want!`);
    console.log('');
    process.stdout.write(`  ${dim(`Press ENTER to open ${CALENDLY_URL} in your browser`)}`);
    while (true) {
      const k = await waitForKey();
      if (k === '\r' || k === '\n') break;
    }
    console.log('');
    console.log('');
    try {
      if (process.platform === 'darwin') execSync(`open "${CALENDLY_URL}"`);
      else if (process.platform === 'win32') execSync(`start "${CALENDLY_URL}"`);
      else execSync(`xdg-open "${CALENDLY_URL}"`);
    } catch {}
    await debug.flushAndExit(0);
  }
  // packageDir = where the user ran the command (scopes what we analyze)
  // rootDir = git root (where .restless/ lives)
  const { packageDir, rootDir } = resolveProjectDirs(process.cwd());

  // Pin the plan view; from here on, render() manages the whole screen.
  // No textual header - the logo + step list inside the plan is the heading.
  plan.setHeader(['']);
  plan.pin();
  setupInProgress = true;

  const { setSpinner } = plan;

  const settings = loadSettings(rootDir);
  const hasOas = settings.apis.length > 0 && settings.apis.some(a => a.oasFile && fs.existsSync(path.join(rootDir, a.oasFile)));

  // Step 1: Generate OAS file - always run so the user sees the intro screen,
  // even on re-runs where an OAS already exists. generateOas decides internally
  // whether to re-scan or reuse.
  const oasResult = await generateOas({
    packageDir,
    rootDir,
    update: plan.makeUpdater(0),
    setSpinner,
    aiTool: ['Claude Code', 'Codex', 'Cursor'][choice] || 'Claude Code',
    existingOas: hasOas,
  });

  debug.log('discovered', {
    language: oasResult.detectedLanguage,
    framework: oasResult.detectedFramework,
    domain: oasResult.domain,
    apiRootDir: oasResult.apiRootDir,
  });

  // Build the SetupContext once we know the project shape. Every step
  // downstream reads from this object and writes back into it - no step
  // re-derives keyDelivery / envLoader / sdkLineSpec.
  const ctx = createSetupContext({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    installDir: resolveInstallDir(packageDir, oasResult.apiRootDir),
    apiDir: resolveApiDir(packageDir, oasResult.apiRootDir),
    language: oasResult.detectedLanguage,
    framework: oasResult.detectedFramework,
    aiTool: ['Claude Code', 'Codex', 'Cursor'][choice] || 'Claude Code',
  });
  debug.log('setup-context', redactSetupContext(ctx));

  // Step 2: Install SDK. Order of subs (matches what the user sees):
  //   0. Install package
  //   1. Generate API key (delegated to prepareAccount via callback so the
  //      visible substep order matches the actual run order - install
  //      happens first, then key gen, then the AI wires the middleware)
  //   2. Configure SDK
  // The source-file edit in Configure SDK still triggers a watcher restart
  // that picks up the just-written .env from step 1.
  await installSdk({
    ctx,
    update: plan.makeUpdater(1),
    setSpinner,
    prepareAccountStep: () => prepareAccount({ ctx, update: plan.makeUpdater(1), setSpinner }),
  });
  debug.log('setup-context-after-install', redactSetupContext(ctx));

  // Tag the debug log with the metrics project id so staff can join
  // back to the dashboard once the user claims this project (the same
  // UUID becomes Project.metricsId at claim time).
  const projectApi = loadSettings(rootDir).apis?.find((a) => a.projectId === ctx.projectId);
  debug.log('project', {
    id: ctx.projectId,
    name: projectApi?.name || null,
    domain: projectApi?.baseUrl || oasResult.domain || null,
  });

  // Step 2 sub 3: Semantic verification of owner.id. Runs an AI pass that
  // re-reads the wired file, traces the data flow, and confirms the chosen
  // id is server-verified and immutable. Catches what the static heuristic
  // in final-checks can't: tenant ids pulled from req.body in a codebase
  // where the static check sees `req.user.tenantId` but the user object
  // was attached from unsigned input upstream.
  const verifyUpdate = plan.makeUpdater(1);
  verifyUpdate({ activeSub: 3, sub: { 0: 'done', 1: 'done', 2: 'done' } });
  await verifyOwnerId({ ctx, update: (msg) => verifyUpdate({ ...msg, activeSub: 3 }), setSpinner });

  // Step 2 sub 4: Run final checks. Verifies the install is correct and
  // surfaces issues for the user to opt into fixing - it never edits the
  // SDK init line itself (that's the CLI's responsibility, not the AI's).
  await finalChecks({
    ctx,
    update: plan.makeUpdater(1),
    setSpinner,
    subIndex: 4,
    prevSubs: { 0: 'done', 1: 'done', 2: 'done', 3: 'done' },
  });
  plan.makeUpdater(1)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done', 3: 'done', 4: 'done' } });

  // Step 3: Test your setup (with live log polling)
  await testSetup({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    setSpinner,
    update: plan.makeUpdater(2),
    domain: oasResult.domain,
    projectId: ctx.projectId,
    setupKey: ctx.setupKey,
  });

  // Step 4: Set up account (log in + upload OAS specs).
  await setupAccount({
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    update: plan.makeUpdater(3),
    setSpinner,
    apiKey: ctx.apiKey,
    projectId: ctx.projectId,
    setupKey: ctx.setupKey,
  });

  setupInProgress = false;

} else if (command === 'reset') {
  const cwd = process.cwd();
  const { rootDir: resetRoot } = resolveProjectDirs(cwd);

  console.log('');
  console.log(`  ${bold(yellow('This will reset Restless from this project.'))}`);
  console.log('');
  console.log(`  About to:`);
  console.log(`    ${dim('•')} Remove the ${cyan('.restless/')} directory`);
  console.log(`    ${dim('•')} Uninstall ${cyan('@restlessai/sdk')} from every ${cyan('package.json')} found`);
  console.log(`    ${dim('•')} Ask AI to strip SDK setup code from your source files`);
  console.log(`    ${dim('•')} Remove ${cyan('RESTLESS_KEY')} from any ${cyan('.env*')} files`);
  console.log('');
  process.stdout.write(`  Continue? ${dim('[y/N] ')}`);
  const confirmed = await askYesNo('', { defaultValue: false });
  if (!confirmed) {
    console.log(dim('\n  Cancelled.\n'));
    await debug.flushAndExit(0);
  }

  console.log('');

  // a. Remove .restless/
  const restlessDir = path.join(resetRoot, '.restless');
  if (fs.existsSync(restlessDir)) {
    fs.rmSync(restlessDir, { recursive: true, force: true });
    console.log(green('  ✓ Removed .restless/'));
  } else {
    console.log(dim('  • No .restless/ directory found.'));
  }

  // b. Uninstall @restlessai/sdk from every package.json in the tree
  // (excluding node_modules and other obvious skip dirs). Walks via `find`
  // so we don't have to roll our own recursive scanner.
  function findPackageJsons(root) {
    try {
      const out = execSync(
        "find . -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.restless/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.next/*'",
        { cwd: root, encoding: 'utf8' },
      );
      return out.trim().split('\n').filter(Boolean).map((f) => path.resolve(root, f));
    } catch {
      return [];
    }
  }

  const pkgFiles = findPackageJsons(resetRoot);
  let uninstalledCount = 0;
  for (const pkgPath of pkgFiles) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const inDeps = pkg.dependencies && '@restlessai/sdk' in pkg.dependencies;
      const inDev = pkg.devDependencies && '@restlessai/sdk' in pkg.devDependencies;
      if (!inDeps && !inDev) continue;
      const pkgDir = path.dirname(pkgPath);
      const rel = path.relative(resetRoot, pkgPath) || 'package.json';
      try {
        execSync('npm uninstall @restlessai/sdk', { cwd: pkgDir, stdio: 'pipe' });
        console.log(green(`  ✓ Uninstalled @restlessai/sdk in ${rel}`));
        uninstalledCount++;
      } catch {
        console.log(yellow(`  ! Could not run npm uninstall in ${rel} - remove manually.`));
      }
    } catch {}
  }
  if (uninstalledCount === 0) {
    console.log(dim('  • @restlessai/sdk not listed in any package.json.'));
  }

  // d. Strip RESTLESS_KEY from .env files (no AI - we never let the model
  // read secret files). Plain regex on every .env* we can find.
  function findEnvFiles(root) {
    try {
      const out = execSync(
        "find . -type f -name '.env*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.restless/*'",
        { cwd: root, encoding: 'utf8' },
      );
      return out.trim().split('\n').filter(Boolean).map((f) => path.resolve(root, f));
    } catch {
      return [];
    }
  }

  const envFiles = findEnvFiles(resetRoot);
  let envStripped = 0;
  for (const envPath of envFiles) {
    try {
      const original = fs.readFileSync(envPath, 'utf8');
      const next = original
        .split('\n')
        .filter((line) => !/^\s*(export\s+)?RESTLESS_KEY\s*=/.test(line))
        .join('\n');
      if (next !== original) {
        fs.writeFileSync(envPath, next);
        const rel = path.relative(resetRoot, envPath);
        console.log(green(`  ✓ Removed RESTLESS_KEY from ${rel}`));
        envStripped++;
      }
    } catch {}
  }
  if (envStripped === 0) {
    console.log(dim('  • No RESTLESS_KEY entries found in .env files.'));
  }

  // c. Ask AI to remove SDK setup code from source files. Run last so
  // the model sees a project that's already half-cleaned (no .restless,
  // no package dep) - lower chance it tries to "fix" what we just
  // removed. We never tell it about the .env step; the prompt forbids
  // reading those anyway.
  const sdkFiles = findSdkReferences(resetRoot);
  if (sdkFiles.length === 0) {
    console.log(dim('  • No @restlessai/sdk references in source files.'));
  } else {
    const claudeOk = hasClaude();
    const codexOk = hasCodex() && hasCodexAuth();
    const cursorOk = hasCursor() && hasCursorAuth();
    // Priority order: Claude, then Codex, then Cursor - pick the first one
    // that's installed and authed.
    const picked = claudeOk
      ? { name: 'claude', label: 'Claude' }
      : codexOk
        ? { name: 'codex', label: 'Codex' }
        : cursorOk
          ? { name: 'cursor', label: 'Cursor' }
          : null;
    if (!picked) {
      console.log(yellow('  ! No AI tool available - skipped source cleanup. References remain in:'));
      for (const f of sdkFiles) console.log(dim(`      ${f}`));
    } else {
      setProvider(picked.name);
      console.log('');
      console.log(`  ${dim('Asking')} ${cyan(picked.label)} ${dim('to strip SDK setup code from your source...')}`);
      try {
        const prompt = loadPrompt('remove-sdk', {
          files: sdkFiles.map((f) => `- ${f}`).join('\n'),
        });
        await runAI(prompt, resetRoot);
        console.log(green('  ✓ Source cleanup complete.'));
      } catch (err) {
        console.log(yellow(`  ! AI cleanup failed: ${err.message}`));
        console.log(dim('    References that may remain:'));
        for (const f of sdkFiles) console.log(dim(`      ${f}`));
      }
    }
  }

  console.log('');
  console.log(green('  ✓ Reset complete.'));
  console.log('');
  await debug.flushAndExit(0);
} else if (command === 'clear') {
  const cwd = process.cwd();
  const { rootDir: clearRoot } = resolveProjectDirs(cwd);

  // Reset the site DB
  try {
    const res = await fetch(`${SITE_URL}/api/reset`, { method: 'POST' });
    if (res.ok) console.log(green('  ✓ Site database cleared.'));
  } catch {
    console.log(dim('  Site not running - skipped DB reset.'));
  }

  // Remove .restless/ directory
  const target = path.join(clearRoot, '.restless');
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true });
    console.log(green('  ✓ .restless/ removed.'));
  } else {
    console.log(dim('  No .restless/ directory found.'));
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
        console.log(dim(`  Could not uninstall ${toRemove} - remove manually.`));
      }
    }
  }
} else if (command === 'debug') {
  const rawRequestIdArg = process.argv[3];
  if (!rawRequestIdArg) {
    console.log(red('\n  ✗ Missing request ID.\n'));
    console.log(`  Usage: npx ${CLI_NAME} debug <request-id>\n`);
    await debug.flushAndExit(1);
  }

  // Strip decorative prefix (e.g. "TST-abc123" → "abc123") - the prefix is interchangeable
  const requestId = stripRequestIdPrefix(rawRequestIdArg);

  // Load prefix for display - check per-API first, fall back to top-level for backwards compat
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


  // Fetch log by request ID (UUID) - no projectId needed, the server searches all projects
  const logUrl = `${SITE_URL}/api/logs/${requestId}/public`;
  let log;
  let expired = null;
  // The server's 404 response also carries a `dashboardUrl` (resolved
  // against the matching project's verified custom domain when found,
  // primary host otherwise). Keep the most-recent one so we can hand
  // the visitor a branded URL even when we never saw the log itself.
  let notFoundDashboardUrl = null;
  async function fetchOnce() {
    try {
      const res = await fetch(logUrl);
      if (res.ok) return { log: await res.json() };
      if (res.status === 410) {
        const body = await res.json().catch(() => ({}));
        return { expired: body };
      }
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        if (body?.dashboardUrl) notFoundDashboardUrl = body.dashboardUrl;
      }
    } catch {}
    return null;
  }

  const first = await fetchOnce();
  if (first?.log) log = first.log;
  else if (first?.expired) expired = first.expired;

  // If not found AND not expired, wait for the SDK to flush and retry
  if (!log && !expired) {
    process.stdout.write(p.dim('\n  Waiting for log to be ingested...'));
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const got = await fetchOnce();
      if (got?.log) { log = got.log; break; }
      if (got?.expired) { expired = got.expired; break; }
      process.stdout.write('.');
    }
    console.log('');
  }

  if (expired || !log) {
    const dashboardUrl =
      (expired && expired.dashboardUrl) ||
      notFoundDashboardUrl ||
      `${SITE_URL}/logs/${requestId}`;
    console.log('');
    if (expired) {
      console.log(`  ${p.bold('This request is older than 5 minutes.')}`);
    } else {
      console.log(`  ${p.bold("Couldn't load that request from here.")}`);
    }
    console.log('');
    console.log(`  ${p.dim('For security, `npx api debug` only works for the first 5 minutes')}`);
    console.log(`  ${p.dim('after a request. After that, the log is only viewable when')}`);
    console.log(`  ${p.dim("you're signed in.")}`);
    console.log('');
    console.log(`  ${p.bold('Open it on the dashboard:')}`);
    console.log(`  ${p.cyan(dashboardUrl)}`);
    if (!expired) {
      console.log('');
      console.log(p.dim('  (If this is a brand-new request, also confirm your API server is'));
      console.log(p.dim('  running and the SDK is wired up.)'));
    }
    console.log('');
    await debug.flushAndExit(1);
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

  // Footer. Prefer the server-resolved dashboardUrl (built against the
  // owning project's verified custom domain when set, primary host
  // otherwise) so the URL we print matches the customer's brand.
  const viewUrl = log.dashboardUrl || `${SITE_URL}/logs/${requestId}`;
  console.log(`\n  ${p.dim('View in browser:')} ${viewUrl}`);
  if (isPlain && !inlineQuestion) {
    console.log(`\n  ${p.bold('Ask AI about this request')} - ask a question in plain English about this log:`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "why did this fail?"`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "how do I fix this?"`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "show me a working curl command"`);
  }
  console.log('');

  // ── Top-level "what next?" picker ──
  // After showing the error, give the user a clean fork: take an
  // active fix path (which then drills into the edit-permission
  // sub-menu) or chat about the log. The edit machinery is hidden
  // until the user actually opts into fixing, so people who just
  // want to read the log or ask a quick question never see it.
  //
  // Gated on: error log, interactive TTY, and the `claude` CLI being
  // on PATH locally (no point offering an edit flow that depends on a
  // tool the user doesn't have).
  let skipChat = false;
  if (isError && isTTY && hasClaude()) {
    const action = await singleSelect(
      [
        { label: 'Fix it for me', hint: 'Use your local Claude SDK to find and apply a fix.' },
        { label: 'Ask about it', hint: 'Open an interactive chat about this request.' },
      ],
      { message: 'What do you want to do?', defaultIndex: 0 },
    );
    if (action === 0) {
      await offerFix({
        log,
        requestId,
        cwd: debugRootDir || process.cwd(),
        p,
        CLI_NAME,
        displayId,
      });
      skipChat = true;
    }
    // action === 1 ("Ask about it") falls through to the chat block
    // below; nothing else to do here.
  }

  // ── AI: ask via site server ──
  const askUrl = `${SITE_URL}/api/logs/${requestId}/ask`;

  async function askAI(question) {
    const res = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, source: 'cli' }),
    });
    if (res.status === 410) {
      const body = await res.json().catch(() => ({}));
      const err = new Error('expired');
      err.expired = body;
      throw err;
    }
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
      console.log(p.dim(`  Ask a follow-up: npx ${CLI_NAME} debug ${displayId} --ask "your question here"`));
      console.log('');
    } catch (err) {
      if (err && err.expired) {
        const expBody = err.expired;
        console.log(p.red(`\n  ✗ This request has expired (over 5 minutes old).\n`));
        console.log(`  ${p.bold('Next:')} log in to ask about it on the dashboard:`);
        console.log(`  ${p.cyan(expBody.dashboardUrl || `${SITE_URL}/logs/${requestId}`)}\n`);
      } else {
        console.log('  Could not generate a response.\n');
      }
    }
  } else if (isTTY && !skipChat) {
    // ── Interactive chat mode ──
    const separator = dim('─'.repeat(72));
    const claudeReady = hasClaude();
    console.log(separator);
    console.log(`  ${bold(cyan('Ask AI'))}  ${dim('Ask anything about this request in plain English')}`);
    console.log(`  ${dim('Examples: "why did this fail?" · "show me a working curl" · "what headers am I missing?"')}`);
    if (claudeReady) {
      console.log(`  ${dim('Type')} ${cyan('/fix')} ${dim('to have Claude apply a fix, or')} ${cyan('exit')} ${dim('to quit.')}`);
    } else {
      console.log(`  ${dim('Type "exit" to quit.')}`);
    }
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
            // Sync handler: fire-and-forget. Nothing runs after, the inner
            // process.exit lands once the flush settles.
            debug.flushAndExit(0);
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
      const trimmedQ = question.trim();
      const lowerQ = trimmedQ.toLowerCase();
      if (lowerQ === 'exit') {
        console.log(`\n  ${dim('Goodbye!')}\n`);
        break;
      }
      // Chat-mode shortcut: drop straight into the fix flow. Skips the
      // need to exit, re-run, and re-pick "Fix it for me" from the top
      // menu after the AI's answer has clarified what's wrong.
      if (lowerQ === '/fix' || lowerQ === 'fix it') {
        if (!claudeReady) {
          console.log(`\n  ${red('✗')} ${dim('Claude CLI not installed; install it to use /fix.')}\n`);
          continue;
        }
        console.log('');
        await offerFix({
          log,
          requestId,
          cwd: debugRootDir || process.cwd(),
          p: { bold, dim, green, red, cyan },
          CLI_NAME,
          displayId,
        });
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
      } catch (err) {
        spinner.stop();
        if (err && err.expired) {
          const expBody = err.expired;
          console.log(`\n  ${red('✗')} This request has expired (over 5 minutes old).`);
          console.log(`  ${dim('Log in to keep going:')} ${cyan(expBody.dashboardUrl || `${SITE_URL}/logs/${requestId}`)}\n`);
          break;
        }
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
    console.log(`  Usage: npx ${CLI_NAME} skill <docs-url>\n`);
    console.log(`  Example: npx ${CLI_NAME} skill ${dim('docs.example.com/docs/my-project')}\n`);
    await debug.flushAndExit(1);
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
      await debug.flushAndExit(1);
    }
    body = await res.text();
  } catch (err) {
    console.log(`\n  ${red('✗')} Could not reach ${cyan(skillUrl)}: ${err.message}\n`);
    await debug.flushAndExit(1);
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

  // Preview block - same in auto and manual modes so the user always
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
    await debug.flushAndExit(0);
  }

  console.log(`  ${dim('This will install to')} ${cyan(prettyTarget)}\n`);
  process.stdout.write(`  Install? ${dim('[Y/n] ')}`);
  const ok = await askYesNo('', { defaultValue: true });
  if (!ok) {
    console.log(dim('\n  Cancelled. To grab it manually, rerun with --manual.\n'));
    await debug.flushAndExit(0);
  }

  // Refuse to overwrite an existing skill silently - could clobber an
  // edited copy. Confirm the overwrite explicitly.
  if (fs.existsSync(targetPath)) {
    console.log();
    console.log(`  ${yellow('!')} ${prettyTarget} already exists.`);
    process.stdout.write(`  Overwrite? ${dim('[y/N] ')}`);
    const overwrite = await askYesNo('', { defaultValue: false });
    if (!overwrite) {
      console.log(dim('\n  Left existing file alone.\n'));
      await debug.flushAndExit(0);
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, body, 'utf8');

  console.log(`\n  ${green('✓')} Installed ${bold(skillName)} → ${cyan(prettyTarget)}\n`);

  console.log(`  ${bold('How to use it')}`);
  console.log();
  console.log(`  Claude Code picks the skill up automatically - start a new session`);
  console.log(`  (or reload the running one) and ask anything about this API.`);
  console.log();
  console.log(`  Try:`);
  console.log(`    ${dim('"using ' + skillName + ', show me the public endpoints"')}`);
  console.log();
  console.log(`  The skill points at the project's MCP server, so live endpoint`);
  console.log(`  details flow in on demand. To uninstall, just delete the file.`);
  console.log();

} else if (command === 'update') {
  // ── npx api update [projectId] ────────────────────────────────────
  // Post-claim editor. Lets the user edit a handful of safe fields
  // (name, base URL, visibility, request-id prefix) via the same
  // input helpers the setup flow uses, then uploads the resulting
  // `.restless/settings.json` blob to the site so the dashboard's
  // "settings last synced" timestamp + any UI that reads from the
  // blob stay current.
  //
  // The optional positional argument scopes the run to one project
  // by its `projectId` so multi-API repos can skip the picker.
  //
  // Auth: hashes RESTLESS_KEY from .env and sends the digest to
  // `POST /api/projects/<projectId>/sync`. First sync per project
  // stamps `Project.writeKeyHash`; every later sync must match.
  const cwd = process.cwd();
  const { rootDir: updateRoot } = resolveProjectDirs(cwd);
  const updateSettings = loadSettings(updateRoot);

  if (!updateSettings.apis || updateSettings.apis.length === 0) {
    console.log('');
    console.log(red(`  ✗ No Restless project found in this directory.`));
    console.log(dim(`  Looking in: ${updateRoot}/.restless/settings.json`));
    console.log('');
    console.log(`  Run ${cyan(`npx ${CLI_NAME} init`)} first to set one up.`);
    console.log('');
    await debug.flushAndExit(1);
  }

  // Optional positional arg: `npx api update <projectId>`. When
  // present, we skip the picker - useful for multi-API repos where
  // someone already knows which one they're editing (e.g. the
  // dashboard's settings page deep-links a copy command with the
  // project id baked in).
  const requestedProjectId = process.argv[3];
  let chosenApi;
  if (requestedProjectId) {
    chosenApi = updateSettings.apis.find((a) => a.projectId === requestedProjectId);
    if (!chosenApi) {
      console.log('');
      console.log(red(`  ✗ No API with projectId ${cyan(requestedProjectId)} found in .restless/settings.json.`));
      console.log('');
      const known = updateSettings.apis
        .filter((a) => a.projectId)
        .map((a) => `    ${dim('•')} ${a.projectId} ${dim(`(${a.name || a.rootDir || a.id})`)}`);
      if (known.length) {
        console.log(dim('  Known project IDs in this workspace:'));
        for (const line of known) console.log(line);
        console.log('');
      }
      await debug.flushAndExit(1);
    }
  } else if (updateSettings.apis.length === 1) {
    chosenApi = updateSettings.apis[0];
  } else {
    const labels = updateSettings.apis.map((a) => ({
      label: a.name || a.rootDir || a.id || '(unnamed)',
      hint: a.projectId ? dim(a.projectId) : '',
    }));
    const idx = await singleSelect(labels, {
      message: 'Which API are you updating?',
      defaultIndex: 0,
    });
    chosenApi = updateSettings.apis[idx];
  }

  if (!chosenApi?.projectId) {
    console.log('');
    console.log(red(`  ✗ That API has no projectId yet.`));
    console.log(dim(`  Finish ${cyan(`npx ${CLI_NAME} init`)} first - the projectId is set during setup.`));
    console.log('');
    await debug.flushAndExit(1);
  }

  // Helper: clear the viewport + scrollback and reprint the logo +
  // "Editing X / projectId" header. Called before every picker
  // iteration so the screen doesn't accumulate stale renders from
  // previous edits + sub-prompts. Same clear-home sequence the
  // `init` flow uses between screens.
  function repaintHeader() {
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    console.log('');
    printLogo();
    console.log('');
    const projectName = chosenApi.name || chosenApi.rootDir || 'this project';
    console.log(`  ${bold('Editing')} ${cyan(projectName)}`);
    console.log(dim(`  ${chosenApi.projectId}`));
    console.log('');
  }

  // ── Top-level menu ────────────────────────────────────────────────
  // Two choices only - everything `update` does is either editing
  // settings or refreshing the OAS. Ctrl-C bails at any prompt;
  // there's no explicit "cancel" option.
  repaintHeader();
  const topChoice = await singleSelect(
    [
      { label: 'Update Settings', hint: 'Edit name, base URL, visibility, or request prefix' },
      { label: 'Update OAS file', hint: 'Re-scan your routes (re-runs the setup OAS step)' },
    ],
    { message: 'What do you want to update?', defaultIndex: 0 },
  );

  if (topChoice === 1) {
    console.log('');
    console.log(`  ${yellow('!')} OpenAPI regeneration isn't wired into ${cyan('update')} yet.`);
    console.log('');
    console.log(`  For now, re-run ${cyan(`npx ${CLI_NAME} init`)} - it detects the existing`);
    console.log(`  ${cyan('.restless/')} setup and walks the OAS step again without touching`);
    console.log(`  your code.`);
    console.log('');
    await debug.flushAndExit(0);
  }

  // ── Field-editor flow ─────────────────────────────────────────────
  // The picker IS the values panel - each row shows `label  value`
  // so the user navigates up/down across fields and hits Enter to
  // edit the highlighted one. Last row is "Done!" which exits the
  // loop and continues to the sync. No Cancel - Ctrl-C from any
  // prompt is the bail.
  const REQUEST_PREFIX_RE = /^[A-Z0-9]{1,7}$/;

  // Re-find the entry inside `updateSettings` so mutations
  // propagate back into the structure we'll save + upload.
  const apiEntry = updateSettings.apis.find((a) => a.projectId === chosenApi.projectId);

  function visibilityOf(entry) {
    // generate-oas writes either `internal: true` (internal API)
    // or `internal: false` / unset (external/customer-facing).
    return entry.internal === true ? 'Internal' : 'External';
  }

  function displayValue(value) {
    if (value === undefined || value === null || value === '') return dim('—');
    return String(value);
  }

  // Pad the label column so values line up. singleSelect prepends
  // `❯ N. ` to each label - the padding is purely between our
  // logical "label" and "value" within one row.
  const LABEL_WIDTH = 'Request prefix'.length;
  function row(label, value) {
    const pad = ' '.repeat(LABEL_WIDTH - label.length);
    return `${dim(label)}${pad}   ${value}`;
  }

  let lastIndex = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Clear + reprint logo/header at the top of every loop tick so
    // each round of editing starts on a fresh screen. Without this,
    // sub-prompts (Visibility selector, inline input) leave their
    // output above the next picker render and the terminal fills up
    // with stale state.
    repaintHeader();
    const fieldChoice = await singleSelect(
      [
        { label: row('Name',           displayValue(apiEntry.name)) },
        { label: row('Base URL',       displayValue(apiEntry.baseUrl)) },
        { label: row('Visibility',     visibilityOf(apiEntry)) },
        { label: row('Request prefix', displayValue(apiEntry.requestIdPrefix)) },
        { label: bold(green('Done!')), hint: 'Save & sync to the dashboard' },
      ],
      { message: 'Use ↑↓ to navigate, Enter to edit:', defaultIndex: lastIndex },
    );
    lastIndex = fieldChoice;

    if (fieldChoice === 4) break;       // Done! - save & sync

    if (fieldChoice === 0) {
      const next = (await ask(`  ${bold('Name')}: `, { defaultValue: apiEntry.name || '' })).trim();
      if (next && next !== apiEntry.name) apiEntry.name = next;
    } else if (fieldChoice === 1) {
      const next = (await ask(`  ${bold('Base URL')}: `, { defaultValue: apiEntry.baseUrl || '' })).trim();
      if (next && !/^https?:\/\//i.test(next)) {
        console.log(red(`  ✗ Base URL must start with http:// or https://`));
      } else if (next && next !== apiEntry.baseUrl) {
        apiEntry.baseUrl = next;
      }
    } else if (fieldChoice === 2) {
      const visIdx = await singleSelect(
        [
          { label: 'External', hint: 'Customer-facing - appears on the public docs.' },
          { label: 'Internal', hint: 'Admin-only - hidden from the public docs.' },
        ],
        {
          message: 'Visibility',
          defaultIndex: apiEntry.internal === true ? 1 : 0,
        },
      );
      apiEntry.internal = visIdx === 1;
    } else if (fieldChoice === 3) {
      const next = (await ask(
        `  ${bold('Request prefix')} ${dim('(1-7 letters/digits)')}: `,
        { defaultValue: apiEntry.requestIdPrefix || '' },
      )).trim().toUpperCase();
      if (next && !REQUEST_PREFIX_RE.test(next)) {
        console.log(red(`  ✗ Prefix must be 1-7 uppercase letters or digits (e.g. TST).`));
      } else if (next && next !== apiEntry.requestIdPrefix) {
        apiEntry.requestIdPrefix = next;
      }
    }

    // Persist after every successful edit so a Ctrl-C mid-flow
    // doesn't throw away changes the user already confirmed.
    saveSettings(updateRoot, updateSettings);
  }

  // Reload from disk so we send whatever's on disk now. Saves in the
  // loop above already mirrored each edit, but reloading is the
  // belt-and-suspenders move.
  const freshSettings = loadSettings(updateRoot);

  const projectIdForSync = chosenApi.projectId;

  // ── Device-auth token cache (~/.restless/projects/<id>.json) ───
  // Tokens are valid for 24h after browser approval, so a developer
  // running `npx api update` repeatedly during the day only sees the
  // browser once. We cache `{ token, expiresAt }` under the user's
  // home dir (not the repo) so credentials never travel with code.
  const credsDir = path.join(os.homedir(), '.restless', 'projects');
  const credsFile = path.join(credsDir, `${projectIdForSync}.json`);
  // 60s buffer so we don't try to use a token that's about to
  // expire mid-request.
  const CACHE_BUFFER_MS = 60 * 1000;
  function loadCachedToken() {
    try {
      const raw = fs.readFileSync(credsFile, 'utf8');
      const parsed = JSON.parse(raw);
      const expiresAt = parsed?.expiresAt ? Date.parse(parsed.expiresAt) : 0;
      if (typeof parsed?.token === 'string' && expiresAt - CACHE_BUFFER_MS > Date.now()) {
        return { token: parsed.token, expiresAt };
      }
    } catch {}
    return null;
  }
  function saveCachedToken(token, expiresAt) {
    try {
      fs.mkdirSync(credsDir, { recursive: true });
      fs.writeFileSync(
        credsFile,
        JSON.stringify({ token, projectId: projectIdForSync, expiresAt }, null, 2) + '\n',
        { mode: 0o600 },
      );
    } catch (err) {
      // Non-fatal - we'll just re-do the browser dance next time.
      console.log(dim(`  ! Couldn't cache CLI token at ${credsFile}: ${err.message}`));
    }
  }

  // ── Device-auth handshake ──────────────────────────────────────
  // Skipped if we have a cached token that's still valid.
  let cliToken = loadCachedToken()?.token || null;

  if (!cliToken) {
    cliToken = crypto.randomBytes(32).toString('hex');
    setupInProgress = false;

    // Step 1: register the token + projectId on the site.
    try {
      const startRes = await fetch(`${SITE_URL}/api/auth/cli/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cliToken, projectId: projectIdForSync }),
        signal: AbortSignal.timeout(10000),
      });
      if (!startRes.ok) {
        const text = await startRes.text().catch(() => '');
        console.log('');
        console.log(red(`  ✗ Couldn't start CLI auth (HTTP ${startRes.status}).`));
        if (text) console.log(dim(`    ${text.slice(0, 200)}`));
        console.log('');
        await debug.flushAndExit(1);
      }
    } catch (err) {
      console.log('');
      console.log(red(`  ✗ Couldn't reach ${SITE_URL}: ${err.message}`));
      console.log('');
      await debug.flushAndExit(1);
    }

    // Step 2: open the browser to /api/auth/cli?token=... and ask
    // the user to approve. Print the URL too in case the browser
    // didn't open (SSH session, headless dev container, etc.).
    const authUrl = `${SITE_URL}/api/auth/cli?token=${cliToken}`;
    console.log('');
    console.log(`  ${bold('Authorize this CLI session in your browser.')}`);
    console.log('');
    console.log(`    ${cyan(authUrl)}`);
    console.log('');
    console.log(dim('  The session is good for 24 hours after you approve.'));
    console.log('');
    try {
      if (process.platform === 'darwin') execSync(`open "${authUrl}"`, { stdio: 'ignore' });
      else if (process.platform === 'win32') execSync(`start "" "${authUrl}"`, { stdio: 'ignore' });
      else execSync(`xdg-open "${authUrl}"`, { stdio: 'ignore' });
    } catch {
      // Browser open is best-effort - the URL is already printed.
    }

    // Step 3: poll until approved (or token expires).
    const pollSpinner = startSpinner('Waiting for approval');
    const POLL_INTERVAL_MS = 2000;
    const POLL_DEADLINE = Date.now() + 10 * 60 * 1000; // matches the 10m pending TTL on the server
    let approvedExpiresAt = null;
    while (Date.now() < POLL_DEADLINE) {
      try {
        const checkRes = await fetch(
          `${SITE_URL}/api/auth/cli/check?token=${cliToken}`,
          { cache: 'no-store' },
        );
        if (checkRes.status === 410) {
          pollSpinner.stop();
          console.log(red(`  ✗ The auth token expired before you approved it.`));
          console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} update`)}.`));
          console.log('');
          await debug.flushAndExit(1);
        }
        if (checkRes.ok) {
          const data = await checkRes.json();
          if (data.status === 'authorized') {
            approvedExpiresAt = Date.parse(data.expiresAt);
            break;
          }
        }
      } catch {
        // Network blip - keep polling within the deadline.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    pollSpinner.stop();

    if (!approvedExpiresAt) {
      console.log(red(`  ✗ Timed out waiting for browser approval.`));
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} update`)} when you're ready.`));
      console.log('');
      await debug.flushAndExit(1);
    }

    saveCachedToken(cliToken, new Date(approvedExpiresAt).toISOString());
    console.log(green(`  ✓ CLI authorized.`));
  }

  // ── Upload ─────────────────────────────────────────────────────
  console.log('');
  console.log(dim(`  Uploading settings to ${SITE_URL}...`));
  try {
    const res = await fetch(`${SITE_URL}/api/projects/${projectIdForSync}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cliToken, settings: freshSettings }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      // Cached token went stale (server-side expiry doesn't always
      // line up with our cache, e.g. if the admin revoked rows).
      // Wipe the cache so the next run re-authorizes from scratch.
      try { fs.unlinkSync(credsFile); } catch {}
      console.log(red(`  ✗ Authorization expired or was revoked.`));
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} update`)} to re-authorize.`));
      console.log('');
      await debug.flushAndExit(1);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log(red(`  ✗ Sync failed (HTTP ${res.status}).`));
      if (errText) console.log(dim(`    ${errText.slice(0, 200)}`));
      console.log('');
      await debug.flushAndExit(1);
    }
    console.log(green(`  ✓ Settings synced.`));
    console.log('');
  } catch (err) {
    console.log(red(`  ✗ Sync failed: ${err.message}`));
    console.log('');
    await debug.flushAndExit(1);
  }

  await debug.flushAndExit(0);
} else {
  console.log(`Unknown command: ${command}`);
  console.log(`Usage: ${CLI_NAME} init | update | clear | debug <request-id> | skill <docs-url>`);
}
