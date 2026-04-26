import { bold, dim, cyan, waitForKey } from './ui.js';

/**
 * Render a step's intro screen. Every step uses this so the visual
 * structure is consistent — the only thing that changes is the copy.
 *
 *   ── Step N: Title ──
 *
 *   Intro line.
 *
 *   Why: ...
 *   What we'll do: ...
 *   Privacy: ...
 *
 *   Ready to <action>? (press any key to continue)
 *
 * `sections` is an array of `{ label, body }`. Body may contain newlines
 * and color codes — they're rendered as-is, indented to match.
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
  action,
  skipWait = false,
}) {
  const message = [
    '',
    `  ${cyan(bold(`── Step ${stepNum}: ${title} ──`))}`,
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

  update({ status: 'active', message });

  if (!skipWait && action) {
    console.log('');
    process.stdout.write(`  ${bold(`Ready to ${action}?`)} ${dim('(press any key to continue, Ctrl-C to bail)')}`);
    await waitForKey();
    console.log('\n');
  }
}
