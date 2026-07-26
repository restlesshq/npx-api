import { bold, dim, brand, cyan, yellow, waitForKey } from './ui.js';
import { isInteractive } from './env.js';

/** Per-line delay for the intro reveal. Fast enough not to be a wait. */
const REVEAL_MS = 45;

/**
 * Render a step's intro screen. Every step uses this so the visual
 * structure is consistent. Only the copy changes.
 *
 *   ── Step N: Title ──
 *
 *   Intro line.
 *
 *   Why: ...
 *   What we'll do: ...
 *   Privacy: ...
 *
 *   ⚠ Action required: <do this thing in another window before continuing>
 *
 *   Ready to <action>? (press any key to continue)
 *
 * `sections` is an array of `{ label, body }`. Body may contain newlines
 * and color codes; they're rendered as-is, indented to match.
 *
 * `actionRequired` is an optional string for things the user must do
 * outside the CLI before pressing the key (e.g. start a dev server).
 * Rendered with a cyan ▸ glyph - readable as "next, do this" rather
 * than "warning"; a blank line on each side keeps it from blending
 * into the section bodies.
 *
 * Pass `skipWait: true` to render without the "Ready to ..." keypress
 * pause (e.g. when the next action shouldn't require confirmation).
 */
export async function startStep({
  update,
  stepNum,
  title,
  intro,
  sections = [],
  actionRequired,
  action,
  skipWait = false,
}) {
  const message = [
    '',
    `  ${brand(bold(`── Step ${stepNum}: ${title} ──`))}`,
    '',
  ];

  if (intro) {
    for (const line of intro.split('\n')) message.push(`  ${line}`);
    message.push('');
  }

  for (const section of sections) {
    if (!section || !section.body) continue;
    const bodyLines = section.body.split('\n');
    message.push(`  ${bold(section.label + ':')} ${bodyLines[0]}`);
    for (const line of bodyLines.slice(1)) {
      message.push(`  ${line}`);
    }
    message.push('');
  }

  if (actionRequired) {
    // This is the one line on the screen that's addressed to the user rather
    // than describing what we'll do, and it was styled like the prose around
    // it. Amber + bold makes it the thing your eye lands on; without it,
    // people sat waiting for a server they hadn't started.
    const lines = String(actionRequired).split('\n');
    message.push(`  ${yellow('▸')} ${yellow(bold('Action required:'))} ${bold(lines[0])}`);
    for (const line of lines.slice(1)) {
      message.push(`    ${line}`);
    }
    message.push('');
  }

  // Reveal a line at a time rather than snapping the whole block in. The
  // step screens replace everything below the plan at once, and a full screen
  // of new text appearing in a single frame reads as a jump - you can't tell
  // whether it's new content or the same screen re-rendered. Staggering it
  // gives the eye somewhere to start. Blank lines don't get a beat of their
  // own, so the pacing follows the prose rather than the whitespace.
  if (isInteractive() && message.length > 1) {
    for (let i = 1; i <= message.length; i++) {
      update({ status: 'active', message: message.slice(0, i) });
      if (message[i - 1].trim()) await new Promise((r) => setTimeout(r, REVEAL_MS));
    }
  } else {
    update({ status: 'active', message });
  }

  if (!skipWait && action) {
    console.log('');
    process.stdout.write(`  ${bold(`Ready to ${action}?`)} ${dim('(press any key to continue, Ctrl-C to bail)')}`);
    await waitForKey();
    console.log('\n');
  }
}
