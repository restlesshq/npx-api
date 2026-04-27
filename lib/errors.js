import { red, dim, cyan, bold } from './ui.js';
import { CALENDLY_URL } from './config.js';
import { getActivePlan } from './runner.js';
import * as debug from './debug.js';

/**
 * Print a two-part error block: the specific failure on top, then a
 * consistent "we can help, book a call" fallback underneath. Every
 * surface that bails out of setup should funnel through this so users
 * never hit a dead end.
 *
 * `details` is an optional array of extra context lines to print dimmed
 * between the headline and the Calendly link (e.g. HTTP status, URL).
 *
 * Also paints whatever step/sub-step is currently active red, so the
 * plan at the top of the screen visually reflects where we died.
 */
export function reportError(headline, details = []) {
  const plan = getActivePlan();
  if (plan) plan.markActiveFailed();

  debug.log('error', { headline, details });

  console.log('');
  console.log(`  ${red('✗')} ${headline}`);
  for (const line of details) {
    console.log(`    ${dim(line)}`);
  }
  console.log('');
  console.log(`  ${bold("Stuck? Let's get on a call, we'll fix it together.")}`);
  console.log(`  ${cyan(CALENDLY_URL)}`);
  console.log('');
}

/**
 * Same as reportError, but exits the process afterward. Use for unrecoverable
 * failures that block the rest of setup.
 */
export function fatalError(headline, details = []) {
  reportError(headline, details);
  debug.flushAndExit(1);
}
