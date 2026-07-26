import { describe, it, expect } from 'vitest';
import { startStep } from '../lib/step-template.js';

// Strip ANSI sequences so the assertions don't wrestle with color codes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI_RE, '');

function captureMessage() {
  let captured = null;
  return {
    update: ({ message }) => { captured = message; },
    get message() { return captured; },
  };
}

describe('startStep template', () => {
  it('renders the step header with the given number and title', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 3,
      title: 'Test your setup',
      intro: '',
      sections: [],
      skipWait: true,
    });
    const all = cap.message.map(strip).join('\n');
    expect(all).toContain('── Step 3: Test your setup ──');
  });

  it('renders Why / What we\'ll do sections with bold labels', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 1,
      title: 'X',
      intro: 'intro',
      sections: [
        { label: 'Why', body: 'reason' },
        { label: "What we'll do", body: 'action' },
      ],
      skipWait: true,
    });
    const all = cap.message.map(strip).join('\n');
    expect(all).toContain('Why: reason');
    expect(all).toContain("What we'll do: action");
  });

  it('renders the actionRequired block with a friendly cyan ▸ glyph and label', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 3,
      title: 'X',
      intro: '',
      sections: [],
      actionRequired: 'Make sure your server is running.',
      skipWait: true,
    });
    const all = cap.message.map(strip).join('\n');
    expect(all).toContain('▸ Action required: Make sure your server is running.');
    // The only line on the screen addressed to the user rather than
    // describing what we'll do, so it's amber and bold - in cyan it read as
    // just more prose and people missed that a server had to be started.
    const glyphLine = cap.message.find((l) => l.includes('Action required'));
    expect(glyphLine).toContain('\x1b[38;2;255;190;0m'); // amber
    expect(glyphLine).toContain('\x1b[1m');              // bold
    // Still not the ⚠ treatment - nothing has gone wrong yet.
    expect(glyphLine).not.toContain('⚠');
  });

  it('places actionRequired AFTER all sections (so it sits next to "Ready to ...")', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 3,
      title: 'X',
      intro: '',
      sections: [
        { label: 'Why', body: 'because' },
        { label: "What we'll do", body: 'do' },
      ],
      actionRequired: 'Start the server.',
      skipWait: true,
    });
    const all = cap.message.map(strip).join('\n');
    const whatIdx = all.indexOf("What we'll do");
    const actionIdx = all.indexOf('Action required');
    expect(actionIdx).toBeGreaterThan(whatIdx);
  });

  it('omits the actionRequired block entirely when not provided', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 3,
      title: 'X',
      intro: '',
      sections: [{ label: 'Why', body: 'because' }],
      skipWait: true,
    });
    const all = cap.message.map(strip).join('\n');
    expect(all).not.toContain('Action required');
  });

  it('handles multi-line actionRequired by indenting continuation lines', async () => {
    const cap = captureMessage();
    await startStep({
      update: cap.update,
      stepNum: 3,
      title: 'X',
      intro: '',
      sections: [],
      actionRequired: 'Line one.\nLine two.',
      skipWait: true,
    });
    const all = cap.message.map(strip);
    const firstIdx = all.findIndex((l) => l.includes('Action required: Line one.'));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(all[firstIdx + 1]).toContain('Line two.');
  });
});
