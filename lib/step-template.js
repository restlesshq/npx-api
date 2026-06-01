import { bold, dim, brand, cyan, waitForKey } from './ui.js';

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
    const lines = String(actionRequired).split('\n');
    message.push(`  ${cyan('▸')} ${bold('Action required:')} ${lines[0]}`);
    for (const line of lines.slice(1)) {
      message.push(`    ${line}`);
    }
    message.push('');
  }

  update({ status: 'active', message });

  if (!skipWait && action) {
    console.log('');
    process.stdout.write(`  ${bold(`Ready to ${action}?`)} ${dim('(press any key to continue, Ctrl-C to bail)')}`);
    await waitForKey();
    console.log('\n');
  }
}
