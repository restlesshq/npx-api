import { dim, bold, green, yellow } from './ui.js';

const STEPS = [
  {
    label: 'Generate OAS file',
    summary: 'Detect APIs and generate OpenAPI specs',
    children: ['Detect endpoints', 'Generate OAS file', 'Write to .api/'],
  },
  {
    label: 'Install SDK',
    summary: 'Detect language, install the package, and wire it up',
    children: ['Detect language', 'Install package', 'Configure SDK'],
  },
  {
    label: 'Test your setup',
    summary: 'Make a test request and watch the logs come in',
    children: ['Find test endpoint', 'Verify'],
  },
  {
    label: 'Set up account',
    summary: 'Log in to ReadMe and upload your API specs',
    children: ['Log in', 'Upload specs'],
  },
  {
    label: 'Done!',
  },
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getTermWidth() {
  try { return process.stdout.columns || 80; } catch { return 80; }
}

function rule() {
  return dim('─'.repeat(getTermWidth()));
}

function buildLines(statuses, subStatuses, activeSubs, activeStep, workingLines, spinnerFrame, spinnerText) {
  const lines = [];

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    const status = statuses[i];
    const icon = status === 'done' ? green('●') : status === 'active' ? yellow('◐') : dim('○');

    if (status === 'active' && s.children) {
      lines.push(`  ${icon} ${bold(s.label)}`);
      for (let j = 0; j < s.children.length; j++) {
        const branch = '├──';
        const subStatus = subStatuses[i]?.[j];
        const isActiveSub = activeSubs[i] === j && subStatus !== 'done';
        const subIcon = subStatus === 'done'
          ? green('✓')
          : isActiveSub
            ? yellow(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
            : dim('○');
        const subLabel = subStatus === 'done'
          ? s.children[j]
          : isActiveSub
            ? yellow(s.children[j])
            : dim(s.children[j]);
        lines.push(`  ${dim(branch)} ${subIcon} ${subLabel}`);
      }
    } else if (status === 'done') {
      lines.push(`  ${icon} ${s.label}`);
    } else {
      lines.push(`  ${icon} ${bold(s.label)}`);
      if (s.summary) {
        lines.push(`  ${dim('│')} ${dim(s.summary)}`);
      }
    }
  }

  if (workingLines.length) {
    lines.push(rule());
    for (const l of workingLines) {
      lines.push(l);
    }
    if (spinnerText) {
      lines.push(`  ${dim(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])} ${dim(spinnerText)}`);
    }
  }

  return lines;
}

export function createPlanManager() {
  const statuses = new Array(STEPS.length).fill(null);
  const subStatuses = STEPS.map(() => ({}));
  const activeSubs = new Array(STEPS.length).fill(-1);
  let activeStep = -1;
  let spinnerFrame = 0;
  let spinnerText = '';
  let spinnerInterval = null;
  let lastMessage = [];
  let headerLines = []; // static lines above the plan (intro, etc.)
  let pinned = false;

  function render() {
    // Hide cursor, jump to top-left, clear screen, draw everything, show cursor
    // This prevents the flash between clear and redraw
    const header = headerLines.length ? headerLines.join('\n') + '\n' : '';
    const lines = buildLines(statuses, subStatuses, activeSubs, activeStep, lastMessage, spinnerFrame, spinnerText);
    const frame = header + lines.join('\n') + '\n';
    process.stdout.write('\x1b[?25l\x1b[H\x1b[J' + frame + '\x1b[?25h');
  }

  function drawInitial() {
    const lines = buildLines(statuses, subStatuses, activeSubs, activeStep, [], 0, '');
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
    }, 80);
  }

  function stopTicking() {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  }

  function setSpinner(text) {
    spinnerText = text;
    if (text) {
      startTicking();
    } else {
      stopTicking();
      if (pinned) render();
    }
  }

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
      }

      if (status === 'done') {
        statuses[stepIndex] = 'done';
        activeSubs[stepIndex] = -1;
        stopTicking();
        spinnerText = '';
      }

      if (activeSub !== undefined) {
        activeSubs[stepIndex] = activeSub;
      }

      if (sub) {
        for (const [key, val] of Object.entries(sub)) {
          subStatuses[stepIndex][key] = val;
        }
      }

      if (message !== undefined) {
        lastMessage = message;
      }

      if (pinned) render();
    };
  }

  return { drawInitial, pin, setHeader, makeUpdater, setSpinner };
}
