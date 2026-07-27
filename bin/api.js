#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, yellow, orange, brand, white, muted, ask, askYesNo, startSpinner, singleSelect, actionPicker, typeLine, typeOut, inlineStatus, waitForKey, animateLogoIn, printLogo, suppressInput, clearScreen } from '../lib/ui.js';
import { runAI, loadPrompt, setProvider } from '../lib/ai.js';
import { createPlanManager } from '../lib/runner.js';
import { resolveProjectDirs, findGitRoot, isGitIgnored } from '../lib/project.js';
import { countOperations } from '../lib/oas-parse.js';
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
import { isInteractive, isAgent, detectAgent } from '../lib/env.js';
import { buildAgentPlan } from '../lib/agent-plan.js';
import { loadSettings, saveSettings, upsertApi, generatePrefix, formatRequestId, stripRequestIdPrefix } from '../lib/settings.js';
import { findExistingEnvFile, existingRestlessKey } from '../steps/prepare-account.js';
import { generateWriteKey, ensureProject, loadProjectCreds, pollForLandedLog } from '../lib/project-init.js';
import { normalizeBaseUrl, parseStatus, describeDiagnosis, diagnoseFromHeaders, splitCurlIncludeOutput, fixContext } from '../lib/test-diagnosis.js';
import { checkOasServers, guessBaseUrl, isPlausibleBaseUrl } from '../lib/base-url.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';
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

/**
 * Default screen. Shown when the CLI is run with no command (`npx api`)
 * or an explicit `help` / `--help` / `-h`. Leads with the logo + the
 * one-liner pitch, then lists every command with a short hint, and ends
 * by pointing first-timers at `init`. Mirrors the welcome copy so the
 * brand voice is consistent whether you land here or in the setup flow.
 */
/**
 * Read the package version from this package's package.json. Resolved
 * relative to this file (not cwd) so it reports the installed CLI's
 * version no matter where the user ran it from. Falls back to a
 * placeholder if the file can't be read - the version string is
 * informational and should never be able to crash the CLI.
 */
// Root of the installed package - where the guides and prompts we ship live.
const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Put text on the system clipboard. Returns false when there's no clipboard
 * tool available (headless Linux, a container, an SSH session), so callers
 * can fall back to printing the text instead of claiming a copy that never
 * happened.
 */
function copyToClipboard(text) {
  const cmds = process.platform === 'darwin' ? ['pbcopy']
    : process.platform === 'win32' ? ['clip']
    : ['wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input'];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {}
  }
  return false;
}

/**
 * Read `--flag value` off argv. Returns null when the flag is absent or is
 * the last argument (so `--dir` with nothing after it doesn't swallow the
 * next flag as its value).
 */
function flagValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const val = process.argv[i + 1];
  if (!val || val.startsWith('--')) return null;
  return val;
}

function readVersion() {
  try {
    const pkgPath = path.join(PKG_DIR, 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  console.log('');
  printLogo();
  console.log('');
  console.log(`  ${white('Restless makes sure every API call turns out')} ${green('200 Okay')}${white('.')}`);
  console.log('');
  console.log(`  ${bold('Usage')}`);
  console.log(`    ${cyan(`npx ${CLI_NAME}`)} ${dim('<command>')}`);
  console.log('');
  console.log(`  ${bold('Commands')}`);
  const rows = [
    ['init', 'Set up Restless here: scan your code, install the SDK, wire it in'],
    ['debug <request-id>', 'Inspect a request, ask AI about it, or have it fixed for you'],
    ['update [projectId]', 'Edit project settings and sync them to the dashboard'],
    ['skill <docs-url>', 'Install an API skill into Claude Code'],
    ['reset', 'Remove Restless from this project'],
    ['help', 'Show this help'],
    ['--version', 'Print the installed CLI version'],
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, hint] of rows) {
    console.log(`    ${cyan(name.padEnd(width))}  ${dim(hint)}`);
  }
  console.log('');
  // Listed apart from the main commands: these are the pieces a coding agent
  // calls while doing the setup itself (run `init` inside one and it prints
  // the plan that uses them). A human running setup never needs them.
  console.log(`  ${bold('For coding agents')}`);
  const agentRows = [
    ['guide [oas|sdk]', 'Print the instructions for writing the spec / wiring the SDK'],
    ['key', 'Register the project and put RESTLESS_KEY in .env'],
    ['register --oas <f>', 'Record a spec in .restless/settings.json'],
    ['verify --url <u>', 'Send one request, confirm the SDK saw it and the log landed'],
    ['login', 'Print the URL the user opens to claim the project'],
  ];
  const agentWidth = Math.max(...agentRows.map(([name]) => name.length));
  for (const [name, hint] of agentRows) {
    console.log(`    ${cyan(name.padEnd(agentWidth))}  ${dim(hint)}`);
  }
  console.log('');
  console.log(`  ${dim('New here? Run')} ${cyan(`npx ${CLI_NAME} init`)} ${dim('to get started.')}`);
  console.log('');
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(readVersion());
  await debug.flushAndExit(0);
} else if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  await debug.flushAndExit(0);
} else if (
  (command === 'init' || command === 'setup' || command === 'supercharge') &&
  isAgent() &&
  !process.argv.includes('--self-drive')
) {
  // ── Driven by a coding agent: hand over instructions, don't self-drive ──
  // Running our own model here means editing the caller's repo from inside a
  // child process: no diffs in their session, nothing to interrupt, and a
  // second agent re-deriving context the caller already has. Print the
  // playbook and let them do the code work in the open. `--self-drive`
  // restores the old behaviour for CI and for agents that would rather
  // delegate the whole thing.
  const { rootDir: agentRoot } = resolveProjectDirs(process.cwd());
  const agentName = detectAgent() === 'codex' ? 'Codex' : 'Claude Code';
  console.log(buildAgentPlan({ rootDir: agentRoot, cli: CLI_NAME, agent: agentName }));
  debug.log('init.agent-plan', { agent: detectAgent(), rootDir: agentRoot });
  await debug.flushAndExit(0);

} else if (command === 'init' || command === 'setup' || command === 'supercharge') {
  // ── Welcome screen ────────────────────────────────────────────────────
  // Clear viewport + scrollback so the welcome starts at the top of the
  // terminal, matching where every subsequent screen lands after each
  // transition clears + homes the cursor.
  if (isInteractive()) {
  clearScreen();
  console.log('');
  // Swallow keystrokes for the whole animated intro so they don't echo into
  // the text being typed out (and don't queue up to skip the CTA). Restored
  // in the `finally` right before we start listening for the real keypress.
  const restoreInput = suppressInput();
  let arrowInterval = null;
  let welcomeKey;
  try {
  await animateLogoIn();
  console.log('');

  // "Restless helps make [400 Bad Request] into [200 Okay]."
  // Each status code shows a brief spinner, then settles into a colored
  // circle + the code, and typing continues. No erase-and-replace -
  // the spinner lands in place where the circle ends up.
  // Swap `spinnerStyle` to try: arc, halfcircle, piefill, pulse, sparkle, concentric, braille
  const spinnerStyle = 'concentric';

  await typeOut(white(`  Restless makes sure every `));
  await inlineStatus({ code: '400 Bad Request', success: false, style: spinnerStyle });
  await typeOut(white(` turns out `));
  await inlineStatus({ code: '200 Okay', success: true, style: spinnerStyle });
  await typeLine(white(`.`));
  console.log('');

  await typeLine(muted(`  It's not just another observability platform (although you can use it`), { delay: 11 });
  await typeLine(muted(`  to see what your users are up to!).`), { delay: 11 });
  console.log('');
  await typeLine(muted(`  Think of us more as an API success platform. We give humans, AI and`), { delay: 11 });
  await typeLine(muted(`  you the tools to quickly make successful calls.`), { delay: 11 });
  console.log('');
  await typeLine(`  ${bold('Ready to supercharge your API?')}`);
  console.log('');

  // Boxed CTA: the focal point of the welcome. The trailing ⏎ pulses while
  // we wait for input, so we hide the native blinking cursor - one cue
  // instead of two. Box, label, and ⏎ all use the brand blue so the
  // call to action ties back to the logo.
  const ctaText = 'Press ENTER to get started';
  const boxBody = `  ${ctaText}  ⏎  `;
  const w = boxBody.length;
  console.log(`  ${brand('╭' + '─'.repeat(w) + '╮')}`);
  console.log(`  ${brand('│')}  ${brand(ctaText)}  ${brand('⏎')}  ${brand('│')}`);
  console.log(`  ${brand('╰' + '─'.repeat(w) + '╯')}`);
  console.log('');
  console.log(`  ${dim("We use AI for the setup, but we'll ask permission before we do anything.")}`);
  console.log(`  ${dim(`Press [${bold('d')}${'\x1b[2m'}] to try this on a demo repo · Press [${bold('h')}${'\x1b[2m'}] to set up time with a human`)}`);

  process.stdout.write('\x1b[?25l'); // hide terminal cursor while we own the screen
  process.stdout.write('\x1b7');     // save current row as the home position for the animation

  // Pulse: dim → blue → bold blue → blue, repeat. Cycles through ~1.1s.
  // The ⏎ lives 5 rows above the saved cursor (3 box rows + blank + 2 dim
  // copy rows). Its column is the box content offset: 2 indent + 1 border +
  // 2 pad + label + 2 pad = ctaText.length + 8.
  const iconCol = ctaText.length + 8;
  const enterFrames = [dim('⏎'), brand('⏎'), bold(brand('⏎')), brand('⏎')];
  let enterFrame = 0;
  arrowInterval = setInterval(() => {
    enterFrame = (enterFrame + 1) % enterFrames.length;
    process.stdout.write(`\x1b8\x1b[5A\x1b[${iconCol}G` + enterFrames[enterFrame] + '\x1b8');
  }, 280);
  } finally {
    // Hand stdin back the way waitForKey expects it (cooked, paused).
    restoreInput();
  }

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
  clearScreen();
  } else {
    // Non-interactive (agent / CI / pipe): skip the animated welcome and its
    // ENTER / demo / human-handoff gate entirely - there's no TTY to drive
    // any of it, and an agent just needs setup to proceed.
    console.log('');
    console.log(`  ${bold('Restless')} — setting up in non-interactive mode.`);
    console.log('');
  }
  // ──────────────────────────────────────────────────────────────────────

  const plan = createPlanManager();

  // Logo + the four steps: the fixed part of the pre-setup screen. Anything
  // below it is a question, and questions get replaced rather than stacked -
  // so this is redrawable.
  function drawSetupHeader() {
    console.log('');
    // No separate printLogo() here - drawInitial draws the logo beside the
    // steps, the same frame the run itself uses, so nothing jumps when the
    // setup starts.
    plan.drawInitial();
    console.log('');
  }

  drawSetupHeader();
  const claudeInstalled = hasClaude();
  const codexInstalled = hasCodex();
  // Three short promises beat a paragraph: the old copy explained the
  // architecture ("talks to our SDKs directly") when all anyone wants to know
  // is whose machine the AI runs on and whether anything leaves it.
  console.log(`  ${bold("Let's get you set up!")} Here's how it works:`);
  console.log('');
  console.log(`  ${dim('·')} We use your local Agent for setup`);
  console.log(`  ${dim('·')} Your code is never seen by Restless`);
  console.log(`  ${dim('·')} We won't upload anything until the end`);
  // No blank line here - the picker opens with one of its own.

  // Name the agent the user actually has. Offering "Claude or Codex" as a
  // first decision makes them choose a tool before they've agreed to the
  // approach; the alternatives live one level down, behind "No".
  const preferred = claudeInstalled || !codexInstalled ? 'claude' : 'codex';
  const preferredLabel = preferred === 'claude' ? 'Claude' : 'Codex';

  // `choice` keeps the meanings the branches below already handle:
  // 0 = Claude, 1 = Codex, 2 = book a call, 3 = learn more, 4 = copy a
  // prompt, 5 = manual setup.
  let choice;
  if (!isInteractive()) {
    // Non-interactive: never offer anything that needs a human. Prefer the
    // agent actually driving us - if Codex is running the CLI, `claude` may
    // not even be installed - then fall back to whatever's available so we
    // still surface a clear "install X" message if neither is.
    const agent = detectAgent();
    if (agent === 'codex' && codexInstalled) choice = 1;
    else if (agent === 'claude' && claudeInstalled) choice = 0;
    else if (claudeInstalled) choice = 0;
    else if (codexInstalled) choice = 1;
    else choice = 0;
    console.log(`  ${dim(`Using ${['Claude', 'Codex'][choice]} to run setup.`)}`);
  } else {
    const useAgent = await singleSelect(
      [
        {
          label: `Yes, use ${preferredLabel} ${dim('(recommended)')}`,
          hint: (preferred === 'claude' ? claudeInstalled : codexInstalled)
            ? `Runs locally on your machine. You'll see every change.`
            : `${preferredLabel} isn't installed yet - we'll show you how.`,
        },
        { label: 'No, other options', hint: 'Copy a prompt, set it up by hand, or talk to us first.' },
      ],
      { message: 'Is it okay if we set up using your Agent?', defaultIndex: 0 },
    );

    if (useAgent === 0) {
      choice = preferred === 'claude' ? 0 : 1;
    } else {
      // Replace, don't append. The three promises are about handing work to
      // their agent - moot once they've declined - and leaving the answered
      // question above the new one reads as two open questions at once.
      clearScreen();
      drawSetupHeader();
      const alt = await singleSelect(
        [
          { label: 'Copy a prompt for your Agent', hint: 'Paste it into any agent and it runs the setup itself.' },
          { label: 'Manual setup', hint: 'Do it by hand - we print the steps and the commands.' },
          { label: 'Book a quick installation call', hint: "We'll pair on it with you." },
          { label: 'Learn more', hint: 'Ask us anything about what setup does before deciding.' },
        ],
        { message: 'How would you like to set this up?', defaultIndex: 0 },
      );
      choice = [4, 5, 2, 3][alt];
    }
  }

  // Clear the viewport so after-selection stuff starts clean at the top.
  // Skip in non-interactive mode - clearing the scrollback just destroys the
  // output an agent is reading.
  if (isInteractive()) clearScreen();

  if (choice === 3) {
    // "Learn more" - a Q&A loop rather than a wall of text. Someone who
    // picked this has a specific worry (what gets read? what gets uploaded?
    // what happens to my middleware?), and a static page answers whichever
    // three we guessed at.
    console.log('');
    console.log(`  ${bold('Ask us anything about the setup')}`);
    console.log('');
    console.log(dim(`  What we touch, what we upload, how to undo it - anything.`));
    console.log(dim(`  Answered locally by ${preferredLabel}. Press ENTER on an empty line to leave.`));
    console.log('');

    const canAnswer = preferred === 'claude' ? claudeInstalled : codexInstalled;
    if (!canAnswer) {
      console.log(`  ${yellow('!')} ${preferredLabel} isn't installed, so we can't answer questions here.`);
      console.log('');
      console.log(`  The short version: we read your code locally to write an OpenAPI spec and`);
      console.log(`  wire in the SDK. Nothing is uploaded until the last step, when you sign in`);
      console.log(`  to claim the project. ${bold(`npx ${CLI_NAME} reset`)} undoes all of it.`);
      console.log('');
      await debug.flushAndExit(0);
    }
    setProvider(preferred);

    while (true) {
      const q = (await ask(`  ${cyan('?')} `)).trim();
      if (!q) break;
      console.log('');
      let answer;
      try {
        answer = await runAI(loadPrompt('learn-more-chat', { question: q, cli: CLI_NAME }), process.cwd());
      } catch (err) {
        answer = `Couldn't reach ${preferredLabel} (${err.message}).`;
      }
      for (const line of String(answer).trim().split('\n')) console.log(`  ${line}`);
      console.log('');
    }
    console.log('');
    console.log(`  Run ${cyan(`npx ${CLI_NAME} init`)} again when you're ready.`);
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 4) {
    // "Copy a prompt for your Agent" - the same playbook `init` prints when
    // it detects it's being run inside an agent, handed over for a paste.
    const { rootDir: promptRoot } = resolveProjectDirs(process.cwd());
    const promptText = buildAgentPlan({ rootDir: promptRoot, cli: CLI_NAME, agent: 'your agent' });
    const copied = copyToClipboard(promptText);

    console.log('');
    if (copied) {
      console.log(`  ${green('✓')} Copied to your clipboard.`);
      console.log('');
      console.log(`  Paste it into Claude Code, Codex, Cursor, or whatever you use. It has`);
      console.log(`  everything they need: the steps, the rules, and the commands to call.`);
    } else {
      console.log(`  ${bold('Paste this into your agent:')}`);
      console.log('');
      console.log(dim('  ─'.repeat(34)));
      for (const line of promptText.split('\n')) console.log(`  ${line}`);
      console.log(dim('  ─'.repeat(34)));
    }
    console.log('');
    console.log(dim(`  Your agent can also just run ${bold(`npx ${CLI_NAME} init`)}${'\x1b[2m'} itself - it prints these`));
    console.log(dim(`  same instructions when it detects an agent driving it.`));
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 5) {
    // "Manual setup" - real instructions now that each deterministic piece
    // has its own command. Previously this just offered to book a call.
    console.log('');
    console.log(`  ${bold('Setting up by hand')}`);
    console.log('');
    console.log(`  ${green('1.')} ${bold('Write an OpenAPI spec')} for your API at ${cyan('.restless/openapi.json')}, then:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} register --oas .restless/openapi.json --dir <your-api-dir>`)}`);
    console.log(dim(`     Already have a spec? Point that command at it - any path works.`));
    console.log('');
    console.log(`  ${green('2.')} ${bold('Get your key')} (registers the project, writes ${cyan('RESTLESS_KEY')} to ${cyan('.env')}):`);
    console.log(`     ${cyan(`npx ${CLI_NAME} key`)}`);
    console.log('');
    console.log(`  ${green('3.')} ${bold('Install and wire the SDK.')} Install ${cyan('@restlessai/sdk')}, then follow:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} guide sdk`)}`);
    console.log(dim(`     The one thing to get right: register the middleware above any auth`));
    console.log(dim(`     guard, so a rejected 401 still reaches the SDK.`));
    console.log('');
    console.log(`  ${green('4.')} ${bold('Check it.')} Start your server, then:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} verify --url http://localhost:3000`)}`);
    console.log('');
    console.log(`  ${green('5.')} ${bold('Claim the project:')} ${cyan(`npx ${CLI_NAME} login`)}`);
    console.log('');
    console.log(dim(`  Stuck? ${bold(`npx ${CLI_NAME} init`)}${'\x1b[2m'} does all of this for you, and ${bold(`npx ${CLI_NAME} reset`)}${'\x1b[2m'} undoes it.`));
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

  // Pick the AI provider before any step calls runAI(). Manual / Learn-more
  // never reach here.
  if (choice === 0) setProvider('claude');
  else if (choice === 1) setProvider('codex');

  // "Book a quick installation call" - hand off to a human.
  if (choice === 2) {
    console.log('');
    console.log(`  ${bold("Let's set it up together.")}`);
    console.log('');
    console.log(`  Pick a time that works and we'll walk through it with you - bring`);
    console.log(`  whatever's odd about your setup.`);
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

  // Step 1: Generate OAS file - always run so the user sees the intro screen,
  // even on re-runs where an OAS already exists. generateOas decides internally
  // whether to re-scan or reuse.
  const oasResult = await generateOas({
    packageDir,
    rootDir,
    update: plan.makeUpdater(0),
    setSpinner,
    aiTool: ['Claude Code', 'Codex'][choice] || 'Claude Code',
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
    aiTool: ['Claude Code', 'Codex'][choice] || 'Claude Code',
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

  // Still part of "Configure SDK" (sub 2), not a row of its own: semantic
  // verification of owner.id is an AI pass over the block the configure step
  // just wrote. It catches what the static heuristic in final-checks can't -
  // a tenant id pulled from req.body in a codebase where the static check
  // sees `req.user.tenantId` but the user object came from unsigned input
  // upstream.
  const verifyUpdate = plan.makeUpdater(1);
  verifyUpdate({ activeSub: 2, sub: { 0: 'done', 1: 'done' } });
  await verifyOwnerId({ ctx, update: (msg) => verifyUpdate({ ...msg, activeSub: 2 }), setSpinner });

  // Step 2 sub 3: Run final checks. Verifies the install is correct and
  // surfaces issues for the user to opt into fixing - it never edits the
  // SDK init line itself (that's the CLI's responsibility, not the AI's).
  await finalChecks({
    ctx,
    update: plan.makeUpdater(1),
    setSpinner,
    subIndex: 3,
    prevSubs: { 0: 'done', 1: 'done', 2: 'done' },
  });
  plan.makeUpdater(1)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done', 3: 'done' } });

  // Step 3: Test your setup (auto-detect the server, confirm the SDK sees
  // requests, and offer an AI fix loop when it doesn't).
  await testSetup({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    setSpinner,
    update: plan.makeUpdater(2),
    domain: oasResult.domain,
    projectId: ctx.projectId,
    setupKey: ctx.setupKey,
    ctx,
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

} else if (command === 'guide') {
  // ── npx api guide [oas|sdk|<language>] ────────────────────────────
  // Hands out the same instruction sets the CLI's own model runs on, so a
  // calling agent works from the tested wording rather than an improvised
  // summary of it. Plain markdown on stdout - meant to be read by a model.
  const topic = (process.argv[3] || '').toLowerCase();

  if (topic === 'oas' || topic === 'spec' || topic === 'openapi') {
    const { rootDir: guideRoot, packageDir: guidePkgDir } = resolveProjectDirs(process.cwd());
    const guideSettings = loadSettings(guideRoot);
    const guideApi = guideSettings.apis?.[0];
    // Same deterministic base-URL guess the guided flow prefolds into its
    // user prompt - deploy manifests, env templates, the README. Handing the
    // agent a vetted candidate is what keeps localhost out of servers[0].url.
    const guess = guideApi?.baseUrl ? null : guessBaseUrl({ dirs: [guidePkgDir, guideRoot] });
    const domainInstruction = guess
      ? `${guess.url} (deterministic guess from ${guess.source} - verify it against the code; if it's wrong and you can't confirm the real public URL, ask the user)`
      : '(unknown. Ask the user for the API\'s PUBLIC base URL - never put localhost, 127.0.0.1, or a dev port in servers[0].url. If the user confirms no public URL exists, use a relative mount path like "/" instead)';
    // The prompt is normally rendered with values the guided run has already
    // worked out. Here the agent is the one who works them out, so the
    // placeholders that would carry them become instructions instead.
    const rendered = loadPrompt('generate-oas', {
      name: guideApi?.name || path.basename(guideRoot),
      oasFile: path.join(guideRoot, '.restless', 'openapi.json'),
      domain: guideApi?.baseUrl || domainInstruction,
      existingOasNote: '',
      internalNote: '',
      // The guided run pre-computes a route checklist and pastes it here.
      // You're the one reading the code, so the instruction takes its place -
      // otherwise the coverage rule below refers to a checklist that isn't there.
      endpointChecklist: 'Enumerate the routes yourself from the code first, and treat that list as the coverage checklist referred to below.',
      frameworkNote: '',
    });
    // Belt and braces: never leak raw template syntax into a model's context
    // if the prompt grows a placeholder this command doesn't know about.
    console.log(rendered.replace(/\{\{[a-zA-Z]+\}\}/g, '').replace(/\n{3,}/g, '\n\n'));
    await debug.flushAndExit(0);
  }

  const langAliases = { sdk: 'javascript', js: 'javascript', node: 'javascript', typescript: 'javascript', ts: 'javascript' };
  const lang = langAliases[topic] || topic || 'javascript';
  const guidePath = path.join(PKG_DIR, 'docs', 'sdks', `${lang}.md`);
  if (!fs.existsSync(guidePath) || lang.startsWith('_')) {
    // `_`-prefixed files are archived guides, not something to offer.
    const available = fs.readdirSync(path.join(PKG_DIR, 'docs', 'sdks'))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .map((f) => f.replace(/\.md$/, ''));
    console.log(red(`\n  ✗ No guide for "${topic}".\n`));
    console.log(`  Try: ${cyan(`npx ${CLI_NAME} guide oas`)} or ${cyan(`npx ${CLI_NAME} guide <${available.join('|')}>`)}\n`);
    await debug.flushAndExit(1);
  }
  console.log(fs.readFileSync(guidePath, 'utf8'));
  await debug.flushAndExit(0);

} else if (command === 'key') {
  // ── npx api key [--json] [--inline] [--dir <apiRootDir>] ──────────
  // Mint + register a project and put the key where the SDK will find it.
  // Ours to own: it generates a credential and registers it server-side,
  // which is not something a calling agent should improvise.
  const asJson = process.argv.includes('--json');
  const inline = process.argv.includes('--inline');
  const dirFlag = flagValue('--dir');
  const { rootDir: keyRoot, packageDir: keyPkgDir } = resolveProjectDirs(process.cwd());
  setGitRoot(findGitRoot(keyRoot) || keyRoot);

  const settingsForKey = loadSettings(keyRoot);
  const apiRootDir = dirFlag || settingsForKey.apis?.[0]?.rootDir || '.';
  const apiDir = resolveApiDir(keyPkgDir, apiRootDir);

  // Reuse a key that's already on disk rather than minting a second one for
  // the same project - a re-run that swaps the key underneath a running
  // server sends its logs to a project nobody is looking at.
  const existingEnvFile = findExistingEnvFile(apiDir, keyRoot);
  const existingKey = existingEnvFile ? existingRestlessKey(existingEnvFile) : null;
  const apiKey = existingKey || generateWriteKey();

  let projectId, reusedProject;
  try {
    ({ projectId, reused: reusedProject } = await ensureProject({ rootDir: keyRoot, apiRootDir, apiKey }));
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.log(red(`\n  ✗ ${err.message}\n`));
    await debug.flushAndExit(1);
  }

  let envFile = null;
  if (!inline && !existingKey) {
    envFile = existingEnvFile || path.join(apiDir, '.env');
    const line = `RESTLESS_KEY=${apiKey}`;
    if (existingEnvFile) safeAppendFileSync(envFile, `\n${line}\n`);
    else safeWriteFileSync(envFile, `${line}\n`);
  } else if (existingKey) {
    envFile = existingEnvFile;
  }

  const rel = envFile ? path.relative(keyPkgDir, envFile) : null;
  // Whether a naive `git add -A` would stage the key. true = safe, false =
  // it would, null = no git here so the question doesn't apply.
  const envIgnoredByGit = envFile ? isGitIgnored(envFile, keyRoot) : null;
  if (asJson) {
    const payload = {
      ok: true, projectId, envFile: rel, envIgnoredByGit, reusedExistingKey: !!existingKey, reusedProject: !!reusedProject,
    };
    // The plaintext key reaches stdout only when --inline asked for exactly
    // that. In the default flow it's already in .env; echoing it again would
    // put a live credential in agent transcripts and shell history.
    if (inline) payload.apiKey = apiKey;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log(`  ${green('✓')} ${reusedProject ? 'Using the project from your last setup' : 'Project registered'} ${dim(`(${projectId})`)}.`);
    if (rel) console.log(`  ${green('✓')} ${existingKey ? 'Using the key already in' : 'Wrote RESTLESS_KEY to'} ${bold(rel)}.`);
    else console.log(`  ${bold('RESTLESS_KEY')}=${apiKey}`);
    if (envIgnoredByGit === false) {
      console.log(`  ${yellow('!')} ${bold(rel)} is ${bold('not')} ignored by git - add it to ${bold('.gitignore')} before you commit.`);
    }
    console.log('');
    console.log(dim(`  Keep this key out of source control. Restart your server so it picks it up.`));
    console.log('');
  }
  await debug.flushAndExit(0);

} else if (command === 'register') {
  // ── npx api register --oas <file> [--dir <d>] [--name <n>] ────────
  // Record a spec an agent just wrote into `.restless/settings.json`, which
  // is what the SDK reads at startup and what later commands look up.
  const oasFlag = flagValue('--oas');
  if (!oasFlag) {
    console.log(red('\n  ✗ Missing --oas <file>.\n'));
    console.log(`  Usage: ${cyan(`npx ${CLI_NAME} register --oas .restless/openapi.json --dir api --name "My API"`)}\n`);
    await debug.flushAndExit(1);
  }
  const { rootDir: regRoot, packageDir: regPkgDir } = resolveProjectDirs(process.cwd());
  setGitRoot(findGitRoot(regRoot) || regRoot);

  const oasAbs = path.isAbsolute(oasFlag) ? oasFlag : path.resolve(process.cwd(), oasFlag);
  if (!fs.existsSync(oasAbs)) {
    console.log(red(`\n  ✗ No such file: ${oasFlag}\n`));
    await debug.flushAndExit(1);
  }
  let oasDoc;
  try {
    oasDoc = JSON.parse(fs.readFileSync(oasAbs, 'utf8'));
  } catch (err) {
    console.log(red(`\n  ✗ ${oasFlag} is not valid JSON: ${err.message}\n`));
    console.log(dim('  Fix the spec and re-run - the SDK and the dashboard both parse this file.\n'));
    await debug.flushAndExit(1);
  }

  // The spec's servers[0].url becomes the API's public base URL on the
  // dashboard, and the spec itself gets uploaded. Localhost and dev ports
  // must not ship - refuse here, where the agent still has to fix it before
  // the flow can continue, rather than warn and hope.
  const serverCheck = checkOasServers(oasDoc);
  if (!serverCheck.ok && !process.argv.includes('--allow-local-servers')) {
    console.log(red(`\n  ✗ servers[0].url is ${bold(serverCheck.url)} - a local/dev address, not a public base URL.`));
    console.log(`  This spec gets uploaded to the dashboard, so localhost and dev ports can't ship in it.`);
    console.log(`  Set ${cyan('servers[0].url')} to the API's real public URL - ask your user if you can't`);
    console.log(`  confirm it - or use a relative mount path like ${cyan('"/"')} if no public URL exists.`);
    console.log(dim(`  Intentional? Re-run with --allow-local-servers.\n`));
    await debug.flushAndExit(1);
  }

  const apiRootDir = flagValue('--dir') || '.';
  const name = flagValue('--name') || oasDoc?.info?.title || path.basename(regRoot);
  const oasRel = path.relative(regRoot, oasAbs);
  const settings = loadSettings(regRoot);
  const existing = settings.apis?.find((a) => (a.rootDir || '.') === apiRootDir);
  // Only a plausible public URL is worth recording as baseUrl. Relative
  // servers and --allow-local-servers overrides keep whatever was there -
  // and a local address recorded by an older CLI gets scrubbed rather than
  // carried forward. A local URL never becomes the dashboard's idea of
  // this API.
  const publicBaseUrl = serverCheck.ok && !serverCheck.relative ? serverCheck.url : null;
  const keptBaseUrl = isPlausibleBaseUrl(existing?.baseUrl) ? existing.baseUrl : undefined;
  upsertApi(settings, {
    ...(existing || {}),
    name,
    rootDir: apiRootDir,
    oasFile: oasRel,
    oasSource: existing?.oasSource || { kind: 'agent' },
    baseUrl: publicBaseUrl || keptBaseUrl,
    requestIdPrefix: existing?.requestIdPrefix || generatePrefix(name),
    lastSyncedAt: new Date().toISOString(),
  });
  saveSettings(regRoot, settings);

  const ops = countOperations(oasDoc);
  console.log('');
  console.log(`  ${green('✓')} Registered ${bold(name)} ${dim(`(${ops} endpoint${ops === 1 ? '' : 's'})`)}.`);
  console.log(`  ${dim(`.restless/settings.json now points at ${oasRel}. Commit .restless/ with your code.`)}`);
  console.log('');
  await debug.flushAndExit(0);

} else if (command === 'verify') {
  // ── npx api verify --url <base> [--path /x] [--json] ──────────────
  // One real request, then read the response headers. Ours to own because
  // the verdict comes from headers the SDK sets, not from the status code -
  // a captured 401 is a pass, and that trips people (and agents) up.
  const asJson = process.argv.includes('--json');
  const urlFlag = flagValue('--url') || 'http://localhost:3000';
  const pathFlag = flagValue('--path') || '/';
  const base = normalizeBaseUrl(urlFlag) || urlFlag;
  const target = `${base}${pathFlag.startsWith('/') ? '' : '/'}${pathFlag}`;

  // Taken before the probe fires; the 15s back-window absorbs clock skew and
  // the SDK's upload batching, same as the guided test step.
  const since = new Date(Date.now() - 15000).toISOString();

  let raw = null;
  try {
    raw = execSync(`curl -i -sS --max-time 10 ${JSON.stringify(target)}`, {
      encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    raw = null;
  }

  const result = { url: target };
  if (raw === null) {
    result.state = 'unreachable';
    result.detail = 'Nothing answered at that address.';
  } else {
    const { headers } = splitCurlIncludeOutput(raw);
    const diag = diagnoseFromHeaders(headers);
    result.state = diag.state;
    result.status = parseStatus(raw);
    if (diag.requestId) result.requestId = diag.requestId;

    // Second half of the verdict. A clean header only proves the SDK
    // captured the request; a log arriving in the registered project proves
    // the key maps where this setup thinks it does. Nothing landing after a
    // clean header is the stale-key signature - the exact failure that used
    // to sail through this command and surface as an empty dashboard.
    // `landed: null` = no registered project to poll, header is all we have.
    if (diag.state === 'ok') {
      const { rootDir: verifyRoot } = resolveProjectDirs(process.cwd());
      const entry = loadSettings(verifyRoot).apis?.find((a) => a.projectId) || null;
      const creds = entry?.projectId ? loadProjectCreds(entry.projectId) : null;
      if (creds?.setupKey) {
        result.landed = await pollForLandedLog({ projectId: entry.projectId, setupKey: creds.setupKey, since });
        if (!result.landed) result.state = 'stale-key';
      } else {
        result.landed = null;
      }
    }

    if (result.state !== 'ok') {
      const { guidance } = fixContext(result.state, { localBase: base, cli: CLI_NAME });
      if (guidance) result.fix = guidance;
    }
  }
  result.ok = result.state === 'ok';

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const desc = describeDiagnosis(result.state, { localBase: base, attempt: 99 });
    console.log('');
    console.log(`  ${desc.icon}  ${desc.lines[0]}`);
    for (const l of desc.lines.slice(1)) console.log(`     ${l}`);
    if (result.landed) console.log(`     ${green('✓')} The log landed in your project too.`);
    if (result.status) console.log(dim(`     (HTTP ${result.status} - a rejected request still counts, as long as the SDK saw it.)`));
    console.log('');
  }
  await debug.flushAndExit(result.ok ? 0 : 1);

} else if (command === 'login' || command === 'claim') {
  // ── npx api login ─────────────────────────────────────────────────
  // Prints the claim URL. The setup key is handed to the server up front
  // and keyed by an opaque token, so it never lands in browser history,
  // an OAuth referer, or a screen share.
  const asJson = process.argv.includes('--json');
  const { rootDir: loginRoot } = resolveProjectDirs(process.cwd());
  const loginSettings = loadSettings(loginRoot);
  const entry = loginSettings.apis?.find((a) => a.projectId) || null;
  const creds = entry?.projectId ? loadProjectCreds(entry.projectId) : null;

  if (!creds?.setupKey) {
    const msg = entry?.projectId
      ? `No stored setup key for project ${entry.projectId}.`
      : 'This project has no Restless project yet.';
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else {
      console.log(red(`\n  ✗ ${msg}\n`));
      console.log(`  Run ${cyan(`npx ${CLI_NAME} key`)} first.\n`);
    }
    await debug.flushAndExit(1);
  }

  const token = crypto.randomBytes(16).toString('hex');
  try {
    const res = await fetch(`${SITE_URL}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, projectId: entry.projectId, setupKey: creds.setupKey }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const msg = `Couldn't prepare the login link (${err.message}).`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.log(red(`\n  ✗ ${msg}\n`));
    await debug.flushAndExit(1);
  }

  // Short form of `/login?token=<token>`; the site redirects it there.
  // People retype this out of a terminal, so keep it as short as possible.
  const loginUrl = `${SITE_URL}/init/${token}`;
  if (asJson) {
    console.log(JSON.stringify({ ok: true, loginUrl, projectId: entry.projectId }, null, 2));
  } else {
    console.log('');
    console.log(`  ${bold('Open this to claim your project:')}`);
    console.log(`  ${cyan(loginUrl)}`);
    console.log('');
  }
  await debug.flushAndExit(0);

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
    if (!claudeOk && !codexOk) {
      console.log(yellow('  ! No AI tool available - skipped source cleanup. References remain in:'));
      for (const f of sdkFiles) console.log(dim(`      ${f}`));
    } else {
      setProvider(claudeOk ? 'claude' : 'codex');
      console.log('');
      console.log(`  ${dim('Asking')} ${cyan(claudeOk ? 'Claude' : 'Codex')} ${dim('to strip SDK setup code from your source...')}`);
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
    clearScreen();
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
  // Each picker row is a field with its current value; navigating to
  // one and pressing Enter opens an inline editor. Submit (distinct
  // from the field rows) ends the loop and continues to the sync.
  // Chat lets the developer describe a change in plain English; we
  // hand the message + current settings to the AI provider and apply
  // whatever JSON patch comes back, after a y/n confirm.
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

  // Best-effort extraction of a single JSON object from a model
  // response. Tolerates ```json fences, leading prose, trailing prose.
  function parseJsonBlock(text) {
    if (typeof text !== 'string') return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fenced ? fenced[1] : text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }

  // Validate a single proposed field value. Returns an error string
  // or null on success. Keeps validation co-located with the field
  // list so the AI path and the manual path can't diverge.
  function validateChange(key, value) {
    if (key === 'name') {
      if (typeof value !== 'string' || !value.trim()) return 'name must be a non-empty string';
      return null;
    }
    if (key === 'baseUrl') {
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return 'baseUrl must start with http:// or https://';
      return null;
    }
    if (key === 'internal') {
      if (typeof value !== 'boolean') return 'internal must be a boolean';
      return null;
    }
    if (key === 'requestIdPrefix') {
      if (typeof value !== 'string' || !REQUEST_PREFIX_RE.test(value)) return 'requestIdPrefix must be 1-7 uppercase letters or digits';
      return null;
    }
    return `unknown field "${key}"`;
  }

  // AI-driven edit path. The user types a sentence; we ship the
  // editable subset of settings + their message to the provider and
  // expect a JSON patch back. The patch is validated, diffed, and
  // only applied after an explicit y/n.
  async function chatEdit() {
    console.log('');
    const msg = (await ask(
      `  ${bold('What do you want to change?')} ${dim('(blank to cancel)')}\n  > `,
    )).trim();
    if (!msg) return;

    const view = {
      name: apiEntry.name ?? null,
      baseUrl: apiEntry.baseUrl ?? null,
      internal: apiEntry.internal === true,
      requestIdPrefix: apiEntry.requestIdPrefix ?? null,
    };
    const prompt = loadPrompt('update-settings-chat', {
      currentSettings: JSON.stringify(view, null, 2),
      userMessage: msg,
    });

    let raw;
    try {
      raw = await runAI(prompt, updateRoot);
    } catch (err) {
      console.log('');
      console.log(red(`  ✗ Couldn't reach the AI: ${err.message}`));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }

    const parsed = parseJsonBlock(raw);
    if (!parsed) {
      console.log('');
      console.log(red(`  ✗ The AI didn't return a JSON patch. Try rephrasing.`));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }
    if (parsed.error) {
      console.log('');
      console.log(yellow(`  ! ${parsed.error}`));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }

    const changes = parsed.changes && typeof parsed.changes === 'object' ? parsed.changes : {};
    const violations = [];
    for (const [k, v] of Object.entries(changes)) {
      const err = validateChange(k, v);
      if (err) violations.push(err);
    }
    if (violations.length) {
      console.log('');
      console.log(red(`  ✗ Proposed change is invalid:`));
      for (const v of violations) console.log(red(`    · ${v}`));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }

    const keys = Object.keys(changes);
    if (keys.length === 0) {
      console.log('');
      console.log(yellow(`  ! No changes proposed. ${parsed.summary || ''}`));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }

    console.log('');
    if (parsed.summary) console.log(`  ${bold(parsed.summary)}`);
    console.log('');
    for (const k of keys) {
      const before = displayValue(apiEntry[k]);
      const after = displayValue(changes[k]);
      console.log(`    ${dim(k.padEnd(16))} ${before}  ${green('→')}  ${green(after)}`);
    }
    console.log('');
    const ok = await askYesNo(`  Apply these changes? ${dim('(Y/n) ')}`, { defaultValue: true });
    if (!ok) {
      console.log(dim('  Skipped.'));
      console.log(dim('  Press any key to continue.'));
      await waitForKey();
      return;
    }

    for (const k of keys) apiEntry[k] = changes[k];
    saveSettings(updateRoot, updateSettings);
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
    const result = await actionPicker(
      [
        { label: 'Name',           value: apiEntry.name },
        { label: 'Base URL',       value: apiEntry.baseUrl },
        { label: 'Visibility',     value: visibilityOf(apiEntry) },
        { label: 'Request prefix', value: apiEntry.requestIdPrefix },
      ],
      {
        message: 'Use ↑↓ to navigate, Enter to edit:',
        actions: [
          { key: 'submit', label: 'Submit',          hint: 'Save & sync to the dashboard.', primary: true },
          { key: 'chat',   label: 'Chat about this', afterthought: true },
        ],
        defaultIndex: lastIndex,
      },
    );

    if (result.kind === 'action') {
      if (result.key === 'submit') break;
      if (result.key === 'chat') {
        await chatEdit();
        // Park the cursor on Chat for follow-up edits. Indices:
        // 0-3 are fields, 4 is Submit, 5 is Chat.
        lastIndex = 5;
        continue;
      }
    }

    lastIndex = result.index;
    const fieldChoice = result.index;

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
      // Merge, don't overwrite: this file is shared with the setup key that
      // `api key` stores for the same project (same path by design - one file
      // per project). A blind write here would drop it and leave `api login`
      // unable to prove ownership.
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch {}
      fs.writeFileSync(
        credsFile,
        JSON.stringify({ ...existing, token, projectId: projectIdForSync, expiresAt }, null, 2) + '\n',
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
} else if (command === 'submit-debug') {
  // Hidden command (intentionally absent from `printHelp`). Every run
  // writes a local debug log to ~/.restless/debug/; this uploads the
  // most recent one to the Restless team so support can ask for it
  // after the fact instead of asking the user to reproduce with
  // --debug. An explicit file path can be passed to send a specific log.
  const explicitPath = process.argv[3];
  const file = explicitPath || debug.findLatestLocalLog();
  if (!file) {
    console.log('');
    console.log(`  ${dim('No local debug logs found.')}`);
    console.log(`  ${dim(`Run \`npx ${CLI_NAME} init\` first, then re-run this to send the log.`)}`);
    console.log('');
    await debug.flushAndExit(1);
  }
  console.log('');
  console.log(`  ${dim(`Submitting ${file}`)}`);
  const res = await debug.submitLocalLog(file);
  console.log('');
  if (res.ok) {
    console.log(`  ${green('✓')} Debug log sent. Thanks - this helps us debug your setup.`);
  } else {
    console.log(`  ${red('✗')} Couldn't send the debug log. Check your connection and try again.`);
  }
  console.log('');
  await debug.flushAndExit(res.ok ? 0 : 1);
} else {
  console.log('');
  console.log(`  ${red(`Unknown command: ${command}`)}`);
  console.log('');
  printHelp();
  await debug.flushAndExit(1);
}
