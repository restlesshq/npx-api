import { dim, bold, green, yellow, red, cyan, orange, renderLogoLine, LOGO_HEIGHT, LOGO_WIDTH } from './ui.js';
import * as debug from './debug.js';

const STEPS = [
  {
    label: 'Map out APIs',
    description: ['Find every endpoint and generate an OpenAPI spec.'],
    children: ['Locate APIs', 'Generate OAS file', 'Write to .restless/'],
  },
  {
    label: 'Install SDK',
    description: ['Install @restlessai/sdk and wire it into your server.'],
    children: ['Install package', 'Generate API key', 'Configure SDK', 'Verify owner.id', 'Run final checks'],
  },
  {
    label: 'Test your setup',
    description: ['Send a real request and watch the log appear live.'],
  },
  {
    label: 'Set up account',
    description: ['Upload your specs and sign in to claim the project.'],
    children: ['Upload specs', 'Log in'],
  },
];

// Concentric circles breathing in and out. Matches the welcome screen's
// loading animation so the visual language stays consistent.
const SPINNER_FRAMES = ['◌', '○', '◎', '●', '◎', '○'];

// Green dominant, with warm accents on the off-beats. Each color holds for
// a full breathing loop before advancing - so you see a complete green
// breath, then a complete yellow breath, then green, then orange, etc.
const SPINNER_COLORS = [green, yellow, green, orange, green, red];

function getTermWidth() {
  try { return process.stdout.columns || 80; } catch { return 80; }
}

function rule() {
  return dim('─'.repeat(getTermWidth()));
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function buildLines(statuses, subStatuses, activeSubs, activeStep, workingLines, spinnerFrame, spinnerPhase, spinnerDetail, spinnerStartTime, errorLines) {
  const lines = [];

  // Logo on the left, one step per row on the right. When a step is active
  // its sub-items "open up" indented underneath, pushing later steps down.
  // The logo column keeps printing line by line for as long as we have logo
  // rows; rows beyond the logo height get padded with spaces.
  let logoRow = 0;
  const logoCol = (n = 1) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      out.push(logoRow < LOGO_HEIGHT ? renderLogoLine(logoRow) : ' '.repeat(LOGO_WIDTH));
      logoRow++;
    }
    return out;
  };

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    const status = statuses[i];
    let icon;
    let label;
    const numbered = `Step ${i + 1}: ${s.label}`;
    if (status === 'done') { icon = green('✓'); label = green(numbered); }
    else if (status === 'failed') { icon = red('✗'); label = red(numbered); }
    else if (status === 'active') { icon = yellow('❯'); label = bold(yellow(numbered)); }
    else { icon = dim('○'); label = bold(numbered); }
    const [logo] = logoCol();
    lines.push(`  ${logo}    ${icon} ${label}`);

    // Sub-items "open" under the active step. Once the step finishes, fold
    // them away again so the final frame stays compact - the parent step's
    // green checkmark already implies the subs all succeeded.
    if (i === activeStep && s.children?.length && status !== 'done') {
      for (let j = 0; j < s.children.length; j++) {
        const subStatus = subStatuses[i]?.[j];
        const isActiveSub = activeSubs[i] === j && subStatus !== 'done' && subStatus !== 'failed';
        const subIcon = subStatus === 'done'
          ? green('✓')
          : subStatus === 'failed'
            ? red('✗')
            : isActiveSub
              ? (status === 'failed' ? red('❯') : yellow('❯'))
              : dim('○');
        const subLabel = subStatus === 'done'
          ? s.children[j]
          : subStatus === 'failed'
            ? red(s.children[j])
            : isActiveSub
              ? (status === 'failed' ? red(s.children[j]) : s.children[j])
              : dim(s.children[j]);
        const [subRowLogo] = logoCol();
        lines.push(`  ${subRowLogo}      ${subIcon} ${subLabel}`);
      }
    }
  }

  // Below-the-plan area: always a rule under the steps panel, then the
  // working content (explanation), a blank separator, the running spinner
  // (high-level phase + elapsed), and a dim detail line under it.
  lines.push(rule());
  for (const l of workingLines) {
    lines.push(l);
  }
  if (spinnerPhase || spinnerDetail) {
    if (workingLines.length) lines.push('');
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const color = SPINNER_COLORS[Math.floor(spinnerFrame / SPINNER_FRAMES.length) % SPINNER_COLORS.length];
    const elapsed = spinnerStartTime ? ` ${dim(`(${formatElapsed(Date.now() - spinnerStartTime)})`)}` : '';
    if (spinnerPhase) {
      lines.push(`  ${color(frame)} ${spinnerPhase}${elapsed}`);
    } else {
      lines.push(`  ${color(frame)} ${spinnerDetail}${elapsed}`);
    }
    if (spinnerPhase && spinnerDetail) {
      lines.push(`    ${dim(spinnerDetail)}`);
    }
  }

  // Error block lives at the bottom of the frame so a stale spinner tick
  // can never wipe it. Set by reportError via plan.setError().
  if (errorLines && errorLines.length) {
    lines.push('');
    for (const l of errorLines) lines.push(l);
  }

  return lines;
}

// Single active plan per process. The shared error reporter reaches into
// this so fatal exits can paint the active step red without having to
// thread the plan through every call site.
let activePlan = null;

export function getActivePlan() {
  return activePlan;
}

export function createPlanManager() {
  const statuses = new Array(STEPS.length).fill(null);
  const subStatuses = STEPS.map(() => ({}));
  const activeSubs = new Array(STEPS.length).fill(-1);
  let activeStep = -1;
  let spinnerFrame = 0;
  let spinnerPhase = '';
  let spinnerDetail = '';
  let spinnerInterval = null;
  let spinnerStartTime = 0;
  let lastMessage = [];
  let headerLines = []; // static lines above the plan (intro, etc.)
  let errorLines = []; // pinned error block from reportError - survives re-renders
  let pinned = false;

  function render() {
    // Hide cursor, jump to top-left, clear screen, draw everything, show cursor
    // This prevents the flash between clear and redraw
    const header = headerLines.length ? headerLines.join('\n') + '\n' : '';
    const lines = buildLines(statuses, subStatuses, activeSubs, activeStep, lastMessage, spinnerFrame, spinnerPhase, spinnerDetail, spinnerStartTime, errorLines);
    const frame = header + lines.join('\n') + '\n';
    process.stdout.write('\x1b[?25l\x1b[H\x1b[J' + frame + '\x1b[?25h');
  }

  function drawInitial() {
    // Pre-selection view: show each step's checkbox + label, plus a couple of
    // dim description lines under the title. The running view (buildLines)
    // intentionally drops these so the active plan stays compact.
    const lines = [];
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      lines.push(`  ${dim('○')} ${bold(`Step ${i + 1}: ${s.label}`)}`);
      if (s.description) {
        for (const desc of s.description) {
          lines.push(`       ${dim(desc)}`);
        }
      }
      if (i < STEPS.length - 1) lines.push('');
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  function pin() {
    // Capture everything currently on screen as the header.
    // We'll grab the terminal content by just storing what we want to keep.
    pinned = true;
  }

  function setHeader(lines) {
    headerLines = lines;
  }

  function startTicking() {
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame++;
      if (pinned) render();
    }, 180);
  }

  function stopTicking() {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  }

  /**
   * Accepts either a plain string (treated as the high-level phase) or an
   * object { phase, detail } where:
   *   - phase: high-level human description (first line, not dimmed)
   *   - detail: literal tool call or fine-grained status (second line, dimmed)
   *
   * Pass an empty string / empty object to clear the spinner.
   */
  function setSpinner(info) {
    const flatten = (s) => (s || '').replace(/\s*\n+\s*/g, ' ');
    const wasActive = !!(spinnerPhase || spinnerDetail);
    if (typeof info === 'string') {
      spinnerPhase = flatten(info);
      spinnerDetail = '';
    } else if (info && typeof info === 'object') {
      spinnerPhase = flatten(info.phase);
      spinnerDetail = flatten(info.detail);
    } else {
      spinnerPhase = '';
      spinnerDetail = '';
    }
    const isActive = !!(spinnerPhase || spinnerDetail);
    if (isActive && !wasActive) spinnerStartTime = Date.now();
    if (!isActive) spinnerStartTime = 0;
    if (isActive) {
      startTicking();
    } else {
      stopTicking();
      if (pinned) render();
    }
  }

  // Per-step start timestamps so step.end events carry a duration.
  const stepStartedAt = new Array(STEPS.length).fill(0);

  function makeUpdater(stepIndex) {
    return function update({ status, sub, activeSub, message }) {
      if (status === 'active' && activeStep !== stepIndex) {
        activeStep = stepIndex;
        statuses[stepIndex] = 'active';
        for (let i = 0; i < STEPS.length; i++) {
          if (i !== stepIndex && statuses[i] !== 'done') {
            statuses[i] = 'pending';
          }
        }
        stepStartedAt[stepIndex] = Date.now();
        debug.log('step.start', { index: stepIndex, label: STEPS[stepIndex].label });
      }

      if (status === 'done') {
        statuses[stepIndex] = 'done';
        activeSubs[stepIndex] = -1;
        stopTicking();
        spinnerPhase = '';
        spinnerDetail = '';
        spinnerStartTime = 0;
        const startedAt = stepStartedAt[stepIndex] || 0;
        debug.log('step.done', {
          index: stepIndex,
          label: STEPS[stepIndex].label,
          durationMs: startedAt ? Date.now() - startedAt : null,
        });
      }

      if (status === 'failed') {
        statuses[stepIndex] = 'failed';
        // Mark the currently active sub as failed too, if any.
        const sub = activeSubs[stepIndex];
        if (sub >= 0 && subStatuses[stepIndex][sub] !== 'done') {
          subStatuses[stepIndex][sub] = 'failed';
        }
        stopTicking();
        spinnerPhase = '';
        spinnerDetail = '';
        spinnerStartTime = 0;
        const startedAt = stepStartedAt[stepIndex] || 0;
        debug.log('step.failed', {
          index: stepIndex,
          label: STEPS[stepIndex].label,
          durationMs: startedAt ? Date.now() - startedAt : null,
        });
      }

      if (activeSub !== undefined) {
        activeSubs[stepIndex] = activeSub;
      }

      if (sub) {
        for (const [key, val] of Object.entries(sub)) {
          // Only log transitions into terminal states, and only when
          // the value is actually changing - re-asserting "done" on a
          // sub that's already done would just spam the log.
          if ((val === 'done' || val === 'failed') && subStatuses[stepIndex][key] !== val) {
            const child = STEPS[stepIndex].children?.[key];
            if (child) debug.log(`substep.${val}`, { step: STEPS[stepIndex].label, sub: child });
          }
          subStatuses[stepIndex][key] = val;
        }
      }

      if (message !== undefined) {
        lastMessage = message;
      }

      if (pinned) render();
    };
  }

  /**
   * Mark whichever step is currently active as failed. Used by the shared
   * error handler (`lib/errors.js`) so every fatal exit paints the step
   * red without every call site having to remember to do it.
   */
  function markActiveFailed() {
    if (activeStep < 0) return;
    const sub = activeSubs[activeStep];
    statuses[activeStep] = 'failed';
    if (sub >= 0 && subStatuses[activeStep][sub] !== 'done') {
      subStatuses[activeStep][sub] = 'failed';
    }
    stopTicking();
    spinnerPhase = '';
    spinnerDetail = '';
    spinnerStartTime = 0;
    if (pinned) render();
  }

  /**
   * Pin an error block at the bottom of the frame. Survives any subsequent
   * re-renders so a late spinner tick or message update can never wipe it.
   * Call once per fatal failure - `reportError` does this automatically.
   */
  function setError(lines) {
    errorLines = Array.isArray(lines) ? lines : [];
    if (pinned) render();
  }

  const plan = { drawInitial, pin, setHeader, makeUpdater, setSpinner, markActiveFailed, setError };
  activePlan = plan;
  return plan;
}
