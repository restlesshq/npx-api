import path from 'path';
import { bold, dim, green, red, yellow, cyan, withSuppressedOutput } from '../lib/ui.js';
import { loadSettings, saveSettings, validateApiField } from '../lib/settings.js';
import { CLI_NAME } from '../lib/config.js';
import { getCliToken, clearCachedToken, loadCachedToken } from '../lib/cli-token.js';
import { countOasEndpoints, describeOasSource, hashOasFile } from '../lib/oas-source.js';
import {
  NO_AGENT_KINDS,
  adoptSpecFromArg,
  checkForSpecChanges,
  cleanRefreshTemp,
  compareWithDashboard,
  describeCheck,
  describeDashboardGap,
  fetchDashboardSpec,
  readCurrentSpec,
  pushOas,
  pushSettings,
  recordPushedFingerprint,
  recordSpec,
  refreshFromRecordedSource,
} from './update-oas.js';
import * as debug from '../lib/debug.js';

/**
 * `npx api update` driven by flags instead of pickers.
 *
 * `init` grew an agent-aware path a while ago; `update` had none, so a coding
 * agent that wanted to change a base URL or re-sync a spec landed in a
 * full-screen TTY picker it could not drive. This is that path, and nothing in
 * this file may prompt.
 *
 * Everything here goes through the same helpers the interactive flow uses -
 * `validateApiField` for the settings fields, `checkForSpecChanges` and
 * `refreshFromRecordedSource` for the spec - so a flag can't accept something
 * the editor would reject, and a headless run can't reach a different answer
 * than a human would.
 */

/** Read the flag values off argv. Returns null when no directive was given,
 *  meaning the caller should run the interactive flow instead. */
export function parseUpdateFlags(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) return null;
    return v;
  };
  const has = (flag) => argv.includes(flag);

  const edits = {};
  const name = value('--name');
  if (name !== null) edits.name = name;
  const baseUrl = value('--base-url');
  if (baseUrl !== null) edits.baseUrl = baseUrl;
  const prefix = value('--prefix');
  if (prefix !== null) edits.requestIdPrefix = prefix.toUpperCase();
  if (has('--internal')) edits.internal = true;
  if (has('--external')) edits.internal = false;

  const flags = {
    edits,
    oas: value('--oas'),
    refresh: has('--refresh'),
    syncOnly: has('--sync'),
    status: has('--status'),
    json: has('--json'),
  };

  const directed =
    Object.keys(edits).length > 0 ||
    flags.oas ||
    flags.refresh ||
    flags.syncOnly ||
    flags.status;
  return directed ? flags : null;
}

function report({ json, ok, lines = [], ...rest }) {
  if (json) {
    // `lines` is the human rendering, ANSI codes and all - it has no business
    // in a payload something else is going to parse.
    console.log(JSON.stringify({ ok, ...rest }, null, 2));
    return;
  }
  console.log('');
  for (const line of lines) console.log(line);
  console.log('');
}

/**
 * `--status`: report the spec's state and whether it changed, writing nothing
 * and pushing nothing.
 *
 * This is the headless half of the up-front check the interactive flow does.
 * An agent needs to be able to ask "is anything out of date?" and then decide,
 * rather than having to run a mutating command to find out. Read-only by
 * contract: the URL check downloads to a scratch file and deletes it again.
 *
 * Narrower than the interactive check on purpose. The interactive flow also
 * re-derives `describe` and `native` specs, which means running an agent - fine
 * with a human watching a spinner who can interrupt it, wrong for the cheap
 * probe an agent calls before deciding anything. Those report `checkable:
 * false` here and point at `--refresh`, which is the explicit "yes, do the
 * expensive thing" request.
 */
export async function reportStatus({ rootDir, apiEntry, json }) {
  const kind = apiEntry.oasSource?.kind || null;
  const out = {
    projectId: apiEntry.projectId,
    name: apiEntry.name,
    oasFile: apiEntry.oasFile || null,
    oasSource: apiEntry.oasSource || null,
    specChanged: null,
    checkable: NO_AGENT_KINDS.has(kind),
  };

  if (!apiEntry.oasFile) {
    out.status = 'no-spec';
    report({ json, ok: true, ...out, lines: [dim('  No spec recorded for this API yet.')] });
    return 0;
  }

  if (!out.checkable) {
    // describe / native / ai / agent all need an agent pass to re-derive the
    // spec. `update` does run that for describe and native when a human is
    // watching; here it would mean an agent spawning an agent, so it is an
    // explicit `--refresh` instead.
    out.status = 'not-checkable';
    out.endpoints = countOasEndpoints(path.join(rootDir, apiEntry.oasFile));
    report({
      json, ok: true, ...out,
      lines: [
        `  ${bold(apiEntry.oasFile)} ${dim(`(${out.endpoints} endpoints, ${describeOasSource(apiEntry.oasSource)})`)}`,
        dim(`  Re-deriving this spec runs an agent over your code, so it isn't checked automatically.`),
        dim(`  Run \`npx ${CLI_NAME} update --refresh\` to do it.`),
      ],
    });
    return 0;
  }

  // What the dashboard has. Cached token only - `--status` promises no auth,
  // and an agent calling this shouldn't trigger a browser. Reported separately
  // from the local answer because they are different questions: `specChanged`
  // is "is my file stale", `dashboardBehind` is "is what you're serving stale".
  const cached = loadCachedToken(apiEntry.projectId);
  if (cached) {
    const remote = await fetchDashboardSpec({
      projectId: apiEntry.projectId, token: cached.token,
    });
    const cmp = compareWithDashboard({
      localOas: readCurrentSpec(rootDir, apiEntry.oasFile),
      localHash: hashOasFile(path.join(rootDir, apiEntry.oasFile)),
      remote,
    });
    if (cmp) {
      out.dashboard = {
        status: cmp.status,
        behind: cmp.status !== 'in-sync',
        endpoints: cmp.endpoints ?? 0,
        missing: cmp.missing || [],
        extra: cmp.extra || [],
        oasSyncedAt: cmp.oasSyncedAt ?? null,
      };
    } else if (remote.error) {
      out.dashboard = { status: 'unavailable', reason: remote.error };
    }
  } else {
    out.dashboard = { status: 'unauthorized', reason: 'no cached CLI session on this machine' };
  }

  const check = await withSuppressedOutput(json, () => checkForSpecChanges({ rootDir, apiEntry }));
  cleanRefreshTemp(rootDir);

  out.status = check.status;
  out.endpoints = check.endpoints ?? null;
  out.specChanged =
    check.status === 'changed' ? true : check.status === 'unchanged' ? false : null;
  if (check.status === 'changed' && check.diff) {
    out.added = check.diff.added;
    out.removed = check.diff.removed;
  }
  if (check.reason) out.reason = check.reason;

  const lines = [`  ${bold(apiEntry.oasFile)} ${dim(`(${describeOasSource(apiEntry.oasSource)})`)}`];
  if (out.dashboard?.behind) {
    lines.push(
      ...describeDashboardGap({
        status: out.dashboard.status,
        missing: out.dashboard.missing,
        extra: out.dashboard.extra,
        contentOnly: out.dashboard.missing.length === 0 && out.dashboard.extra.length === 0,
        endpoints: out.dashboard.endpoints,
      }),
    );
  }
  if (check.status === 'changed') {
    lines.push(...describeCheck(check));
    lines.push(dim(`  Run \`npx ${CLI_NAME} update --refresh\` to apply and push it.`));
  } else if (check.status === 'unchanged') {
    lines.push(`  ${green('✓')} Unchanged ${dim(`(${out.endpoints} endpoints)`)}.`);
  } else if (check.status === 'unknown') {
    lines.push(
      dim(`  ${out.endpoints} endpoints. No record of pushing it, so we can't tell whether it changed.`),
    );
  } else {
    lines.push(`  ${yellow('!')} Couldn't check: ${check.reason}`);
  }
  report({ json, ok: true, ...out, lines });
  return 0;
}

/**
 * Run a flag-driven update. Returns the process exit code.
 *
 * Local edits are applied and saved before anything is pushed, so a failure to
 * reach the dashboard never loses them - and the result says which of the two
 * happened rather than collapsing both into "failed".
 */
export default async function runFlagUpdate({ rootDir, packageDir, apiEntry, flags }) {
  const { json } = flags;

  // Read-only, and deliberately first: `--status` must work with no
  // authorization, no network write, and nothing on disk changed.
  if (flags.status) return reportStatus({ rootDir, apiEntry, json });

  const lines = [];
  const out = { projectId: apiEntry.projectId, edited: [], synced: false, specSynced: false };

  // ── Validate every field before writing any of them ───────────────
  const violations = [];
  for (const [k, v] of Object.entries(flags.edits)) {
    const err = validateApiField(k, v);
    if (err) violations.push(err);
  }
  if (violations.length) {
    report({
      json, ok: false, ...out, errors: violations,
      lines: [red(`  ✗ Invalid values:`), ...violations.map((v) => red(`    · ${v}`))],
    });
    return 1;
  }

  // ── Settings fields ───────────────────────────────────────────────
  if (Object.keys(flags.edits).length) {
    const settings = loadSettings(rootDir);
    const entry = settings.apis.find((a) => a.projectId === apiEntry.projectId);
    if (!entry) {
      report({
        json, ok: false, ...out, error: 'API entry disappeared',
        lines: [red('  ✗ API entry not found.')],
      });
      return 1;
    }
    for (const [k, v] of Object.entries(flags.edits)) {
      if (entry[k] !== v) {
        entry[k] = v;
        out.edited.push(k);
      }
    }
    saveSettings(rootDir, settings);
    if (out.edited.length) lines.push(`  ${green('✓')} Updated ${out.edited.join(', ')}.`);
    else lines.push(`  ${dim('No settings changed - the values given already matched.')}`);
  }

  // ── Spec ──────────────────────────────────────────────────────────
  // `--oas` names a new spec; `--refresh` re-runs whatever produced the
  // current one. Both leave the file on disk and the entry pointing at it.
  let specFile = null;
  if (flags.oas) {
    const adopted = await withSuppressedOutput(json, () => adoptSpecFromArg({ rootDir, arg: flags.oas }));
    if (!adopted) {
      report({
        json, ok: false, ...out, error: `Couldn't use ${flags.oas} as a spec`,
        lines: [
          red(`  ✗ Couldn't use ${bold(flags.oas)} as an OpenAPI spec.`),
          dim('  Give a readable file path or an https URL.'),
        ],
      });
      return 1;
    }
    recordSpec({ rootDir, apiEntry, ...adopted });
    specFile = adopted.oasFile;
    out.oasFile = specFile;
    lines.push(`  ${green('✓')} Spec is now ${bold(specFile)}.`);
  } else if (flags.refresh) {
    const refreshed = await withSuppressedOutput(json, () =>
      refreshFromRecordedSource({ rootDir, packageDir, apiEntry }));
    out.action = refreshed.action;
    if (!refreshed.ok) {
      report({
        json, ok: false, ...out, error: `Refresh (${refreshed.action}) produced no spec`,
        lines: [
          red(`  ✗ Refresh (${refreshed.action}) didn't produce a spec.`),
          dim('  Your existing spec is untouched.'),
        ],
      });
      return 1;
    }
    recordSpec({ rootDir, apiEntry, oasFile: refreshed.oasFile, oasSource: refreshed.oasSource });
    specFile = refreshed.oasFile;
    out.oasFile = specFile;
    out.endpoints = refreshed.endpoints;
    out.added = refreshed.diff.added;
    out.removed = refreshed.diff.removed;
    lines.push(`  ${green('✓')} Refreshed ${bold(specFile)} ${dim(`(${refreshed.endpoints} endpoints)`)}.`);
    if (refreshed.diff.added.length) lines.push(`  ${green('+')} ${refreshed.diff.added.length} added`);
    // Never silent: a flag-driven run has no one watching, so a removal has
    // to appear in the output and in the JSON.
    if (refreshed.diff.removed.length) {
      lines.push(
        `  ${yellow('!')} ${refreshed.diff.removed.length} endpoint${refreshed.diff.removed.length === 1 ? '' : 's'} removed from your docs:`,
        ...refreshed.diff.removed.slice(0, 10).map((op) => `      ${dim(op)}`),
      );
    }
  }

  debug.log('update.flags', { edited: out.edited, spec: !!specFile, syncOnly: flags.syncOnly });

  // ── Push ──────────────────────────────────────────────────────────
  // A cached token only. Approving a new one needs a browser, and blocking a
  // scripted run on that for ten minutes is worse than reporting that the
  // local edits landed and the sync didn't.
  const tokenRes = await getCliToken({ projectId: apiEntry.projectId, interactive: false });
  if (!tokenRes.ok) {
    out.error = tokenRes.error;
    lines.push(
      `  ${yellow('!')} Saved locally, not synced: ${tokenRes.error}`,
      dim(`  Run ${cyan(`npx ${CLI_NAME} update`)} in a terminal once to authorize this machine.`),
    );
    // Exit 0: the edits applied. A non-zero code here would read as "the
    // change failed", which is wrong and would break scripted callers.
    report({ json, ok: true, ...out, lines });
    return 0;
  }

  if (specFile) {
    const push = await pushOas({
      rootDir, oasFile: specFile, projectId: apiEntry.projectId, token: tokenRes.token,
    });
    if (!push.ok) {
      if (push.expired) clearCachedToken(apiEntry.projectId);
      out.error = push.error;
      lines.push(`  ${red('✗')} ${push.error}`);
      report({ json, ok: false, ...out, lines });
      return 1;
    }
    // Fingerprint what landed. Without this the flag path never records one,
    // so a later `--status` on a spec the developer maintains could only ever
    // answer "no record of pushing it".
    recordPushedFingerprint({ rootDir, apiEntry, oasFile: specFile });
    out.specSynced = true;
    lines.push(`  ${green('✓')} Spec synced${push.endpoints !== null ? dim(` (${push.endpoints} endpoints)`) : ''}.`);
  }

  // The settings blob always goes up: it is what the dashboard reads for the
  // project name, and `--sync` exists to push it with no local edits at all.
  const synced = await pushSettings({
    rootDir, projectId: apiEntry.projectId, token: tokenRes.token,
  });
  if (!synced.ok) {
    if (synced.expired) clearCachedToken(apiEntry.projectId);
    out.error = synced.error;
    lines.push(`  ${red('✗')} ${out.error}`);
    report({ json, ok: false, ...out, lines });
    return 1;
  }
  out.synced = true;
  lines.push(`  ${green('✓')} Settings synced.`);

  report({ json, ok: true, ...out, lines });
  return 0;
}

/** The flag list, for `--help` and the agent-facing docs. */
export const UPDATE_FLAGS = [
  ['--status', "Report whether your spec changed. Writes nothing, pushes nothing"],
  ['--name <n>', 'Rename the API on the dashboard'],
  ['--base-url <u>', "Set the API's production base URL"],
  ['--internal / --external', 'Hide from or show on the public docs'],
  ['--prefix <P>', 'Set the request-ID prefix (1-7 letters/digits)'],
  ['--oas <file|url>', 'Point at a different spec and push it'],
  ['--refresh', 'Re-run whatever produced the current spec, then push it'],
  ['--sync', 'Push the current settings with no edits'],
  ['--json', 'Print the result as JSON'],
];
