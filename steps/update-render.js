import { bold, dim, green, red, yellow } from '../lib/ui.js';

/**
 * How `update` says what it found.
 *
 * Separated from the flows so the interactive screens and the flag-driven
 * output can't describe the same result differently, and so a change to the
 * wording is one edit. Every function here is pure: result in, lines out.
 */

/** How many operations we list before summarising the rest. */
const MAX_LISTED = 10;

/**
 * A list of operations under a glyph, truncated. This was written out six
 * times across four functions, each with its own `slice(0, 10)` and its own
 * phrasing for the remainder.
 */
export function bulletList(ops, glyph, colour, { label = 'more' } = {}) {
  const lines = ops.slice(0, MAX_LISTED).map((op) => `    ${colour(glyph)} ${op}`);
  if (ops.length > MAX_LISTED) {
    lines.push(`    ${dim(`… and ${ops.length - MAX_LISTED} ${label}`)}`);
  }
  return lines;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Plain-English names for the spec's top-level sections, so a report says
 *  "the title, description or version" rather than "info". */
const SECTION_LABELS = {
  info: 'the title, description or version',
  servers: 'the server URL',
  components: 'shared schemas',
  security: 'the auth scheme',
  tags: 'the tags',
  externalDocs: 'the external docs link',
  webhooks: 'the webhooks',
};

function namedSections(sections = []) {
  const named = sections.map((s) => SECTION_LABELS[s] || s);
  if (named.length === 0) return null;
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/**
 * The human summary of a check result, at the level someone can act on.
 *
 * Switches once on `check.kind`. The four renderings below used to be selected
 * by testing combinations of `status`, `countOnly`, `contentOnly` and
 * `diff.metadataOnly`, which meant reading all four to know what any one of
 * them printed.
 */
export function describeCheck(check) {
  const n = check.endpoints ?? 0;

  // The developer's own file moved. We have a hash but no operation list - a
  // hash can't reconstruct one - so the count delta is all we can honestly say.
  if (check.kind === 'on-disk') {
    const from = check.previousEndpoints;
    return [
      `  ${bold('Your spec changed')} since you last pushed it.`,
      from !== null && from !== undefined && from !== n
        ? `  ${dim(`${from} to ${plural(n, 'endpoint')}.`)}`
        : `  ${dim(`${plural(n, 'endpoint')}.`)}`,
    ];
  }

  if (check.kind === 'unchanged') {
    return [`  ${green('✓')} Unchanged ${dim(`(${plural(n, 'endpoint')})`)}.`];
  }
  if (check.kind === 'unknown') {
    return [dim(`  ${plural(n, 'endpoint')}. No record of pushing it, so we can't tell whether it changed.`)];
  }
  if (check.kind === 'failed') {
    return [`  ${yellow('!')} Couldn't check: ${check.reason}`];
  }

  const diff = check.diff || { added: [], removed: [], modified: [], changedSections: [] };
  const mod = diff.modified.length;
  const moved = diff.added.length > 0 || diff.removed.length > 0;

  // Same endpoints, different content. Say WHICH endpoints changed rather than
  // "the same endpoints are in it", which reads as "nothing happened" and then
  // leaves a confusing question underneath it.
  if (!moved) {
    if (mod === 0) {
      // Name the sections. "Something outside your endpoints changed" makes
      // someone go and diff the file themselves; "the title changed" answers it.
      const where = namedSections(diff.changedSections);
      return [
        `  ${bold('The spec changed')} outside your endpoints.`,
        `  ${dim(where
          ? `Same ${plural(n, 'endpoint')}; ${where} changed.`
          : `Same ${plural(n, 'endpoint')}, and only formatting differs.`)}`,
      ];
    }
    return [
      `  ${bold(`${mod} of your ${plural(n, 'endpoint')} changed`)} ${dim('(none added or removed)')}`,
      `  ${dim('Updated descriptions, parameters, or response shapes.')}`,
      '',
      ...bulletList(diff.modified, '~', yellow),
    ];
  }

  return [
    `  ${bold('Your spec changed')} ${dim(`(${plural(n, 'endpoint')} now)`)}`,
    '',
    ...bulletList(diff.added, '+', green, { label: 'more added' }),
    ...bulletList(diff.removed, '-', red, { label: 'more removed' }),
    // Added/removed is the headline, but a refresh usually revises existing
    // operations at the same time, and that is most of what a re-sync is for.
    ...(mod ? [`    ${yellow('~')} ${dim(`${plural(mod, 'existing endpoint')} revised`)}`] : []),
  ];
}

/**
 * How to say the dashboard is behind. Returns [] when there is nothing worth
 * saying - in-sync, or we couldn't look.
 */
export function describeDashboardGap(cmp) {
  if (!cmp) return [];
  if (cmp.status === 'in-sync') return [];
  if (cmp.status === 'no-remote-spec') {
    return [`  ${yellow('!')} ${bold('Your dashboard has no spec yet.')} Pushing will add it.`];
  }
  if (cmp.status !== 'behind') return []; // unauthorized / unavailable: say less, not wrong.

  if (cmp.contentOnly) {
    return [
      `  ${yellow('!')} ${bold('Your dashboard has an older version')} of this spec.`,
      `  ${dim('Same endpoints, but the descriptions or schemas it serves are out of date.')}`,
    ];
  }

  const lines = [];
  const missing = cmp.missing || [];
  if (missing.length) {
    lines.push(
      `  ${yellow('!')} ${bold(`Your dashboard is missing ${plural(missing.length, 'endpoint')}`)} that your spec has:`,
      ...bulletList(missing, '+', green),
    );
  }
  if (cmp.extra?.length) {
    lines.push(`  ${dim(`${plural(cmp.extra.length, 'endpoint')} on the dashboard are no longer in your spec.`)}`);
  }
  return lines;
}

/** Is this comparison worth showing at all? */
export function dashboardIsBehind(cmp) {
  return cmp?.status === 'behind' || cmp?.status === 'no-remote-spec';
}
