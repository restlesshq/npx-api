import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, yellow, cyan, ask, singleSelect, askYesNo } from '../lib/ui.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { loadOas } from '../lib/oas-auth.js';
import { SITE_URL, CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { safeWriteFileSync, safeMkdirSync } from '../lib/pathGuard.js';
import {
  MANAGED_OAS_FILE,
  adoptOasFile,
  countOasEndpoints,
  describeOasSource,
  diffOperations,
  fetchOasFromUrl,
  fingerprintSpec,
  hashOasFile,
  isManagedSpec,
  operationSet,
} from '../lib/oas-source.js';
import { generateOasWithAi, locateOasWithAi, describeCoverageGap } from './generate-oas.js';
import * as debug from '../lib/debug.js';

/**
 * `npx api update` -> "Update OAS file".
 *
 * This used to be a stub that told you to re-run `init`, and the reason it
 * stayed a stub is that "refresh my spec" has no single meaning. A spec that
 * came from a URL wants re-fetching. A spec you maintain by hand wants
 * re-reading and re-validating, and must never be regenerated over. Only the
 * AI and framework-generator kinds want the routes read again.
 *
 * So the action offered here is chosen from `oasSource.kind`, which `init`
 * records for exactly this purpose. Regenerating is always available as an
 * explicit choice, never as the default for a spec we didn't write.
 */

/**
 * Kinds `update` re-derives on its own, before asking anything.
 *
 * The dividing line is whether the spec has a source we can go back to. A URL
 * can be re-fetched, a file the developer maintains can be re-read, a recorded
 * command can be run again, and a framework generator can be re-run. In every
 * one of those cases there is something to ask, so we ask it and open with the
 * answer.
 *
 * `ai` and `agent` are the exceptions, and the reason is specific: there is no
 * source to return to. The spec was authored by reading the whole codebase, so
 * "check for changes" means doing that again from scratch. That is a decision,
 * not a status check, so those two get an explicit action instead.
 */
export const AUTO_CHECK_KINDS = new Set(['url', 'file', 'found', 'describe', 'native']);

/**
 * The subset that needs no agent. `--status` is the cheap probe an agent calls
 * before deciding what to do, and having it spawn a second agent to answer
 * would defeat the point - so it checks these and reports the rest as needing
 * an explicit `--refresh`. The interactive flow has a human watching a spinner
 * who can interrupt, so it checks all of AUTO_CHECK_KINDS.
 */
export const NO_AGENT_KINDS = new Set(['url', 'file', 'found']);

/**
 * Scratch DIRECTORY for a refresh we haven't been given permission to keep.
 *
 * A directory rather than a file because `locateOasWithAi` copies a chosen
 * candidate to `openapi.<ext>` alongside whatever path it is handed - so
 * staging to a flat `.oas-refresh.json` would put that copy at
 * `.restless/openapi.json`, on top of the very spec the user is still deciding
 * whether to replace. Giving the whole operation its own directory means
 * nothing it does can reach their file.
 */
const REFRESH_DIR = '.restless/.oas-refresh';

/** Remove the scratch directory, and the flat files an older build used. */
export function cleanRefreshTemp(rootDir) {
  try { fs.rmSync(path.join(rootDir, REFRESH_DIR), { recursive: true, force: true }); } catch {}
  for (const ext of ['.json', '.yaml']) {
    try { fs.rmSync(path.join(rootDir, `${REFRESH_DIR}${ext}`)); } catch {}
  }
}

let _tempGuardRoot = null;

/**
 * Make sure a staged refresh can't outlive the process.
 *
 * The staging directory lives under `.restless/`, which is committed, so a run
 * abandoned at the confirm prompt leaves a stray directory someone could commit.
 * `cleanRefreshTemp` at the start of the next check makes it self-healing, but
 * only if there is a next check.
 *
 * Two handlers because they cover different exits: raw-mode prompts read Ctrl-C
 * as `\\x03` and call `process.exit`, which runs `exit` handlers; a SIGINT
 * delivered while we are not in raw mode kills the process without them.
 */
export function guardRefreshTemp(rootDir) {
  if (_tempGuardRoot) return;
  _tempGuardRoot = rootDir;
  const clean = () => {
    if (_tempGuardRoot) cleanRefreshTemp(_tempGuardRoot);
  };
  process.once('exit', clean);
  process.once('SIGINT', () => {
    clean();
    process.exit(130);
  });
}

/** Stop guarding, once the staged file has been applied or deliberately dropped. */
export function releaseRefreshTemp() {
  _tempGuardRoot = null;
}

/** Where a regenerate is allowed to write. Never the user's own file: a spec
 *  from `found`/`file` lives where they keep it, so regenerating writes here
 *  and re-points `oasFile` instead of overwriting their work. */
export function regenerateTarget(apiEntry) {
  return isManagedSpec(apiEntry.oasFile) ? apiEntry.oasFile : MANAGED_OAS_FILE;
}

/** Parse the spec currently on disk, so a refresh can be diffed against it. */
export function readCurrentSpec(rootDir, oasFile) {
  if (!oasFile) return null;
  const abs = path.join(rootDir, oasFile);
  if (!fs.existsSync(abs)) return null;
  try { return loadOas(abs); } catch { return null; }
}

/**
 * The action list for this spec. The first entry is the primary action, picked
 * from how the spec got here; the rest are always available.
 */
export function buildActions(apiEntry) {
  const kind = apiEntry.oasSource?.kind || null;
  const src = apiEntry.oasSource || {};
  const actions = [];

  if (kind === 'url' && src.url) {
    actions.push({
      key: 'refetch',
      label: `Re-fetch from ${src.url}`,
      hint: 'Downloads it again and shows what changed. No AI, no code reading.',
    });
  } else if (kind === 'file' || kind === 'found') {
    actions.push({
      key: 'revalidate',
      label: `Re-check ${apiEntry.oasFile}`,
      hint: 'Your file is the source of truth: we only validate it and push it.',
    });
  } else if (kind === 'describe' && src.summary) {
    actions.push({
      key: 'replay',
      // Generic on purpose: `src.summary` is a paragraph of model-written prose
      // about internals, and a picker hint is one line.
      label: 'Get the latest spec',
      hint: 'Repeats however this spec was produced last time.',
    });
  } else if (kind === 'native') {
    actions.push({
      key: 'regenerate-native',
      label: `Regenerate with ${src.framework || 'your framework'}`,
      hint: "Uses the framework's own generator, then fills any gaps from the routes.",
    });
  } else {
    actions.push({
      key: 'regenerate',
      label: 'Regenerate from your routes',
      hint: 'Reads your code and rewrites the spec, locally.',
    });
  }

  actions.push({
    key: 'adopt',
    label: 'Point at a different spec',
    hint: 'A file path, a URL, or just tell us where it is.',
  });

  // Regenerating is offered to everyone, but never as the default for a spec
  // we didn't write - that is how you lose someone's hand-written file.
  if (!actions.some((a) => a.key.startsWith('regenerate'))) {
    actions.push({
      key: 'regenerate',
      label: 'Regenerate from your routes instead',
      hint: `Writes a new spec to ${MANAGED_OAS_FILE}. Your current file is left alone.`,
    });
  }

  return actions;
}

/** Ask where a spec should come from, and go get it. Shared by 'adopt' and
 *  by the retry path when a refresh fails. Returns a repo-relative path. */
async function askForSpec({ rootDir, packageDir, setSpinner }) {
  const apiDir = path.join(rootDir, '.restless');
  console.log('');
  console.log(`  ${bold('Where is the spec?')}`);
  console.log('');
  console.log(`  ${dim('A file path, a URL, or just tell us where to look:')}`);
  console.log(`  ${dim('  docs/openapi.yaml')}`);
  console.log(`  ${dim('  https://api.acme.com/openapi.json')}`);
  console.log(`  ${dim("  it's served at /docs-json")}`);
  console.log('');
  const input = (await ask(`  ${cyan('❯')} `)).trim();
  if (!input) return null;

  if (/^https?:\/\//i.test(input)) {
    const file = await fetchOasFromUrl({ url: input, rootDir, apiDir, setSpinner });
    return file ? { oasFile: file, oasSource: { kind: 'url', url: input } } : null;
  }

  const absPath = path.isAbsolute(input) ? input : path.resolve(rootDir, input);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    const file = adoptOasFile({ absPath, rootDir, apiDir });
    return file ? { oasFile: file, oasSource: { kind: 'file', input } } : null;
  }

  const located = await locateOasWithAi({
    input, rootDir, oasFile: MANAGED_OAS_FILE, packageDir, setSpinner,
  });
  return located.finalOasFile
    ? { oasFile: located.finalOasFile, oasSource: { kind: 'describe', summary: located.summary } }
    : null;
}

/**
 * Run one action. Returns `{ oasFile, oasSource }` on success (the spec is on
 * disk by then), or null if it didn't produce one - the caller re-prompts
 * rather than writing anything.
 */
async function runAction({ action, apiEntry, rootDir, packageDir, setSpinner }) {
  const apiDir = path.join(rootDir, '.restless');
  const src = apiEntry.oasSource || {};

  if (action === 'refetch') {
    const file = await fetchOasFromUrl({ url: src.url, rootDir, apiDir, setSpinner });
    return file ? { oasFile: file, oasSource: { kind: 'url', url: src.url } } : null;
  }

  if (action === 'revalidate') {
    // Nothing is fetched or generated: the file already is the truth. All we
    // owe the user is "does it still parse, and how big is it now".
    const abs = path.join(rootDir, apiEntry.oasFile || '');
    if (!apiEntry.oasFile || !fs.existsSync(abs)) {
      console.log('');
      console.log(`  ${red('✗')} ${apiEntry.oasFile || 'The spec'} is no longer on disk.`);
      return null;
    }
    if (countOasEndpoints(abs) === null) {
      console.log('');
      console.log(`  ${red('✗')} ${apiEntry.oasFile} no longer parses as an OpenAPI spec.`);
      console.log(`  ${dim('Fix the file and re-run - the SDK and the dashboard both read it.')}`);
      return null;
    }
    console.log('');
    console.log(`  ${green('✓')} ${bold(apiEntry.oasFile)} parses.`);
    return { oasFile: apiEntry.oasFile, oasSource: apiEntry.oasSource };
  }

  if (action === 'replay') {
    const located = await locateOasWithAi({
      input: src.summary, rootDir, oasFile: MANAGED_OAS_FILE, packageDir, setSpinner,
    });
    return located.finalOasFile
      ? { oasFile: located.finalOasFile, oasSource: { kind: 'describe', summary: located.summary } }
      : null;
  }

  if (action === 'adopt') {
    return askForSpec({ rootDir, packageDir, setSpinner });
  }

  if (action === 'regenerate' || action === 'regenerate-native') {
    const target = regenerateTarget(apiEntry);
    if (target !== apiEntry.oasFile) {
      console.log('');
      console.log(`  ${dim(`Writing to ${target} - your ${apiEntry.oasFile} is left alone.`)}`);
    }
    const preferNative = action === 'regenerate-native';
    const gen = await generateOasWithAi({
      rootDir,
      packageDir,
      apiRootDir: apiEntry.rootDir || '.',
      name: apiEntry.name,
      framework: apiEntry.framework || src.framework || null,
      existingOasFile: apiEntry.oasFile || null,
      preferNative,
      oasFile: target,
      setSpinner,
    });
    if (!gen.ok) {
      console.log('');
      console.log(`  ${red('✗')} The regenerated spec didn't parse: ${gen.error}`);
      console.log(`  ${dim(`Your previous ${apiEntry.oasFile} is untouched.`)}`);
      return null;
    }
    if (gen.coverage && !gen.coverage.ok && gen.coverage.missing.length) {
      console.log('');
      for (const line of describeCoverageGap(gen.coverage)) console.log(line);
    }
    return {
      oasFile: target,
      oasSource: preferNative
        ? { kind: 'native', framework: apiEntry.framework || src.framework || null }
        : { kind: 'ai' },
    };
  }

  return null;
}

/**
 * Look for spec changes before asking the user anything.
 *
 * Only called for `AUTO_CHECK_KINDS`. Nothing here touches the spec on disk:
 * every kind that re-derives stages into a scratch directory so the comparison
 * happens before any consent, and `file`/`found` are read-only by nature.
 *
 * Returns a status the caller branches on:
 *   'changed'    something differs, and `summary` says what
 *   'unchanged'  nothing differs
 *   'unknown'    we can't tell (a maintained spec never pushed from here)
 *   'failed'     the check itself didn't work; `reason` says why
 *
 * Anything other than 'changed' means fall through to the normal menu. A
 * failure here must never block someone who only wanted to edit a setting, so
 * every error path returns rather than throwing.
 */
export async function checkForSpecChanges({
  rootDir, packageDir = rootDir, apiEntry, setSpinner = () => {},
}) {
  const kind = apiEntry.oasSource?.kind;
  const currentAbs = apiEntry.oasFile ? path.join(rootDir, apiEntry.oasFile) : null;

  /** Compare a freshly-staged spec against the one on disk. Shared by every
   *  kind that re-derives, so they all report a change the same way. */
  const compareStaged = (stagedRel, oasSource) => {
    const stagedAbs = path.join(rootDir, stagedRel);
    const before = currentAbs && fs.existsSync(currentAbs) ? loadOas(currentAbs) : null;
    const after = loadOas(stagedAbs);
    const endpoints = countOasEndpoints(stagedAbs);
    if (endpoints === null) {
      cleanRefreshTemp(rootDir);
      return { status: 'failed', reason: "the refreshed spec didn't parse" };
    }
    const diff = diffOperations(before, after);

    // Byte-identical is the common case for a source that hasn't moved, and it
    // deserves a cheaper answer than an operation diff.
    // Canonical, so a generator that merely reformatted its output does not
    // read as a change worth pushing.
    const sameContent =
      currentAbs && fs.existsSync(currentAbs) &&
      hashOasFile(currentAbs) === hashOasFile(stagedAbs);
    if (sameContent) {
      cleanRefreshTemp(rootDir);
      return { status: 'unchanged', endpoints };
    }

    return {
      status: 'changed',
      diff,
      endpoints,
      // Staged, not applied. Only `applySpecChange` moves it into place.
      tempFile: stagedRel,
      targetFile: apiEntry.oasFile && isManagedSpec(apiEntry.oasFile)
        ? apiEntry.oasFile
        : `${MANAGED_OAS_FILE.replace(/\.json$/, '')}${path.extname(stagedRel)}`,
      oasSource,
      // A source can change prose without changing its operations; say that
      // rather than claiming endpoints moved.
      contentOnly: !diff.changed,
    };
  };

  if (kind === 'url') {
    const url = apiEntry.oasSource?.url;
    if (!url) return { status: 'failed', reason: 'no URL recorded' };
    cleanRefreshTemp(rootDir);
    const fetched = await fetchOasFromUrl({
      url,
      rootDir,
      apiDir: path.join(rootDir, REFRESH_DIR),
      setSpinner,
      destBase: path.join(rootDir, REFRESH_DIR, 'openapi'),
    });
    if (!fetched) return { status: 'failed', reason: `couldn't fetch ${url}` };
    return compareStaged(fetched, { kind: 'url', url });
  }

  // Replay a recorded location or command. The agent writes into the scratch
  // directory, so a candidate copy can't land on the real spec.
  if (kind === 'describe') {
    const summary = apiEntry.oasSource?.summary;
    if (!summary) return { status: 'failed', reason: 'nothing recorded to replay' };
    cleanRefreshTemp(rootDir);
    const staged = `${REFRESH_DIR}/openapi.json`;
    const located = await locateOasWithAi({
      input: summary, rootDir, oasFile: staged, packageDir, setSpinner,
    });
    if (!located.finalOasFile) {
      cleanRefreshTemp(rootDir);
      return { status: 'failed', reason: "couldn't reproduce the spec from that" };
    }
    return compareStaged(located.finalOasFile, {
      kind: 'describe', summary: located.summary || summary,
    });
  }

  // Re-run the framework's own generator, same staging discipline.
  if (kind === 'native') {
    cleanRefreshTemp(rootDir);
    const staged = `${REFRESH_DIR}/openapi.json`;
    const gen = await generateOasWithAi({
      rootDir,
      packageDir,
      apiRootDir: apiEntry.rootDir || '.',
      name: apiEntry.name,
      framework: apiEntry.framework || apiEntry.oasSource?.framework || null,
      existingOasFile: apiEntry.oasFile || null,
      preferNative: true,
      oasFile: staged,
      setSpinner,
    });
    if (!gen.ok) {
      cleanRefreshTemp(rootDir);
      return { status: 'failed', reason: gen.error || "the generator didn't produce a spec" };
    }
    const res = compareStaged(staged, {
      kind: 'native',
      framework: apiEntry.framework || apiEntry.oasSource?.framework || null,
    });
    // Surface an incomplete regeneration even when the diff looks fine.
    if (gen.coverage && !gen.coverage.ok && gen.coverage.missing.length) {
      res.coverage = gen.coverage;
    }
    return res;
  }

  // `file` / `found`: the file on disk is the spec, so there is nothing to
  // fetch and nothing to stage. All we can do is compare it against the
  // fingerprint recorded at the last push.
  if (!currentAbs || !fs.existsSync(currentAbs)) {
    return { status: 'failed', reason: `${apiEntry.oasFile || 'the spec'} is not on disk` };
  }
  const endpoints = countOasEndpoints(currentAbs);
  if (endpoints === null) {
    return { status: 'failed', reason: `${apiEntry.oasFile} no longer parses` };
  }
  if (!apiEntry.oasHash) {
    // Never pushed from this checkout, or pushed by a CLI that predates the
    // fingerprint. Can't claim a change, and shouldn't claim there isn't one.
    return { status: 'unknown', endpoints };
  }
  const hash = hashOasFile(currentAbs);
  if (hash === apiEntry.oasHash) return { status: 'unchanged', endpoints };
  return {
    status: 'changed',
    endpoints,
    previousEndpoints: apiEntry.oasOperationCount ?? null,
    // No staged file: the change is already on disk, and pushing is what's
    // outstanding. And no operation list - a hash can't reconstruct one.
    countOnly: true,
    targetFile: apiEntry.oasFile,
    oasSource: apiEntry.oasSource,
  };
}

/**
 * Move a staged refresh into place. Separated from the check so nothing the
 * user hasn't agreed to can reach their spec.
 */
export function applySpecChange({ rootDir, check }) {
  if (!check.tempFile) return check.targetFile; // already on disk (file/found)
  const from = path.join(rootDir, check.tempFile);
  const to = path.join(rootDir, check.targetFile);
  safeMkdirSync(path.dirname(to), { recursive: true });
  safeWriteFileSync(to, fs.readFileSync(from, 'utf8'));
  cleanRefreshTemp(rootDir);
  return check.targetFile;
}

/** Record what we just pushed, so the next run can spot a local edit. */
export function recordPushedFingerprint({ rootDir, apiEntry, oasFile }) {
  const fp = fingerprintSpec(path.join(rootDir, oasFile));
  if (!fp) return;
  const settings = loadSettings(rootDir);
  const entry = settings.apis.find((a) => a.id === apiEntry.id)
    || settings.apis.find((a) => a.projectId === apiEntry.projectId);
  if (!entry) return;
  Object.assign(entry, fp);
  saveSettings(rootDir, settings);
}

/** Plain-English names for the spec's top-level sections, so a report says
 *  "the title, description or version" rather than "info". */
const SECTION_NAMES = (sections = []) => {
  const label = {
    info: 'the title, description or version',
    servers: 'the server URL',
    components: 'shared schemas',
    security: 'the auth scheme',
    tags: 'the tags',
    externalDocs: 'the external docs link',
    webhooks: 'the webhooks',
  };
  const named = sections.map((s) => label[s] || s);
  if (named.length === 0) return null;
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
};

/** The human summary of a check result. */
export function describeCheck(check) {
  const lines = [];
  const n = check.endpoints ?? 0;
  if (check.countOnly) {
    const from = check.previousEndpoints;
    lines.push(`  ${bold('Your spec changed')} since you last pushed it.`);
    lines.push(
      from !== null && from !== n
        ? `  ${dim(`${from} to ${n} endpoint${n === 1 ? '' : 's'}.`)}`
        : `  ${dim(`${n} endpoint${n === 1 ? '' : 's'}.`)}`,
    );
    return lines;
  }
  const diff = check.diff || { added: [], removed: [], modified: [] };
  const mod = diff.modified.length;

  if (check.contentOnly) {
    // Same endpoints, different content. Say WHICH endpoints changed rather
    // than "the same endpoints are in it", which reads as "nothing happened"
    // and then leaves a confusing question underneath it.
    if (diff.metadataOnly) {
      // Name the sections. "Something outside your endpoints changed" makes
      // someone go and diff the file themselves; "info changed" answers it.
      const where = SECTION_NAMES(diff.changedSections);
      lines.push(`  ${bold('The spec changed')} outside your endpoints.`);
      lines.push(
        `  ${dim(where ? `Same ${n} endpoint${n === 1 ? '' : 's'}; ${where} changed.` : `Same ${n} endpoint${n === 1 ? '' : 's'}, and only formatting differs.`)}`,
      );
      return lines;
    }
    lines.push(
      `  ${bold(`${mod} of your ${n} endpoint${n === 1 ? '' : 's'} changed`)} ${dim('(none added or removed)')}`,
    );
    lines.push(`  ${dim('Updated descriptions, parameters, or response shapes.')}`);
    lines.push('');
    for (const op of diff.modified.slice(0, 10)) lines.push(`    ${yellow('~')} ${op}`);
    if (mod > 10) lines.push(`    ${dim(`… and ${mod - 10} more`)}`);
    return lines;
  }

  lines.push(`  ${bold('Your spec changed')} ${dim(`(${n} endpoint${n === 1 ? '' : 's'} now)`)}`);
  lines.push('');
  for (const op of diff.added.slice(0, 10)) lines.push(`    ${green('+')} ${op}`);
  if (diff.added.length > 10) lines.push(`    ${dim(`… and ${diff.added.length - 10} more added`)}`);
  for (const op of diff.removed.slice(0, 10)) lines.push(`    ${red('-')} ${op}`);
  if (diff.removed.length > 10) lines.push(`    ${dim(`… and ${diff.removed.length - 10} more removed`)}`);
  // Added/removed is the headline, but a refresh usually revises existing
  // operations at the same time, and that is most of what a re-sync is for.
  if (mod) lines.push(`    ${yellow('~')} ${dim(`${mod} existing endpoint${mod === 1 ? '' : 's'} revised`)}`);
  return lines;
}

/**
 * Run the recorded source's refresh with no questions asked, for `--refresh`.
 * The primary action is never `adopt`, so this can't reach a prompt: every
 * kind's default action is something we already know how to run.
 */
export async function refreshFromRecordedSource({ rootDir, packageDir, apiEntry, setSpinner = () => {} }) {
  const primary = buildActions(apiEntry)[0];
  const before = readCurrentSpec(rootDir, apiEntry.oasFile);
  const result = await runAction({
    action: primary.key, apiEntry, rootDir, packageDir, setSpinner,
  });
  if (!result) return { ok: false, action: primary.key };
  const after = readCurrentSpec(rootDir, result.oasFile);
  return {
    ok: true,
    action: primary.key,
    ...result,
    diff: diffOperations(before, after),
    endpoints: countOasEndpoints(path.join(rootDir, result.oasFile)),
  };
}

/** Adopt a spec named on the command line: a path or a URL, no prompting. */
export async function adoptSpecFromArg({ rootDir, arg, setSpinner = () => {} }) {
  const apiDir = path.join(rootDir, '.restless');
  if (/^https?:\/\//i.test(arg)) {
    const file = await fetchOasFromUrl({ url: arg, rootDir, apiDir, setSpinner });
    return file ? { oasFile: file, oasSource: { kind: 'url', url: arg } } : null;
  }
  const absPath = path.isAbsolute(arg) ? arg : path.resolve(rootDir, arg);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
  const file = adoptOasFile({ absPath, rootDir, apiDir });
  return file ? { oasFile: file, oasSource: { kind: 'file', input: arg } } : null;
}

/**
 * Record a refreshed spec on the entry. Shared by the interactive flow and the
 * flag-driven one so both stamp the same fields.
 */
export function recordSpec({ rootDir, apiEntry, oasFile, oasSource }) {
  const settings = loadSettings(rootDir);
  const entry = settings.apis.find((a) => a.id === apiEntry.id)
    || settings.apis.find((a) => a.projectId === apiEntry.projectId);
  if (!entry) return false;
  entry.oasFile = oasFile;
  if (oasSource) entry.oasSource = oasSource;
  entry.lastSyncedAt = new Date().toISOString();
  saveSettings(rootDir, settings);
  return true;
}

/** Show the operation-level effect of a refresh before anything is written. */
function reportDiff(before, after, endpoints) {
  const diff = diffOperations(before, after);
  console.log('');
  if (!before) {
    console.log(`  ${bold(String(endpoints))} endpoint${endpoints === 1 ? '' : 's'} in the new spec.`);
    return diff;
  }
  if (!diff.changed) {
    console.log(`  ${dim(`No endpoint changes. Still ${endpoints} endpoint${endpoints === 1 ? '' : 's'}.`)}`);
    return diff;
  }
  console.log(`  ${bold('What changed')} ${dim(`(${endpoints} endpoint${endpoints === 1 ? '' : 's'} now)`)}`);
  console.log('');
  const show = (list, glyph, colour) => {
    for (const op of list.slice(0, 10)) console.log(`    ${colour(glyph)} ${op}`);
    if (list.length > 10) console.log(`    ${dim(`… and ${list.length - 10} more`)}`);
  };
  show(diff.added, '+', green);
  show(diff.removed, '-', red);
  return diff;
}

/**
 * Push the spec to the dashboard. Post-claim this is the device-token path on
 * `POST /api/projects/:id/oas`; the pre-claim `setup_key` staging path is a
 * different mode of the same endpoint and is not what we want here.
 */
export async function pushOas({ rootDir, oasFile, projectId, token }) {
  const abs = path.join(rootDir, oasFile);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (err) {
    return { ok: false, error: `Couldn't read ${oasFile}: ${err.message}` };
  }
  try {
    const res = await fetch(`${SITE_URL}/api/projects/${projectId}/oas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        oas_raw: raw,
        format: oasFile.endsWith('.json') ? 'json' : 'yaml',
      }),
      // Generous next to the settings sync: the server persists the spec
      // before it responds, but a big spec is a big body.
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Spec upload failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, endpoints: data.endpoints ?? null };
  } catch (err) {
    return { ok: false, error: `Spec upload failed: ${err.message}` };
  }
}

/**
 * What the dashboard currently has, so we can tell the developer their copy is
 * ahead of it.
 *
 * This is the comparison that actually matters and the one that was missing.
 * Everything else here compares the local file against its own source, which
 * answers "is my file stale" - a genuinely different question, and not the one
 * someone is asking when endpoints are missing from their docs. A local
 * fingerprint also cannot see a push from a teammate or another checkout.
 *
 * Returns `{ ok: false }` on any failure. Never fatal: not knowing what the
 * dashboard has is a reason to say less, not to stop.
 */
export async function fetchDashboardSpec({ projectId, token }) {
  try {
    const res = await fetch(
      `${SITE_URL}/api/projects/${projectId}/oas?token=${encodeURIComponent(token)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(10000) },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      hasSpec: !!data.hasSpec,
      endpoints: data.endpoints ?? 0,
      operations: Array.isArray(data.operations) ? data.operations : [],
      oasHash: data.oasHash ?? null,
      oasSyncedAt: data.oasSyncedAt ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Compare the local spec against the dashboard's. `remote` is a successful
 * `fetchDashboardSpec` result.
 *
 * Operation sets rather than the documents themselves: the dashboard hands back
 * a normalized list, so this is precise about which endpoints it lacks without
 * downloading a spec. The hash catches drift that isn't endpoint-shaped, which
 * still matters because descriptions and schemas are what the docs serve.
 */
export function compareWithDashboard({ localOas, localHash, remote }) {
  if (!remote?.ok) return null;
  if (!remote.hasSpec) return { status: 'no-remote-spec' };

  if (localHash && remote.oasHash && localHash === remote.oasHash) {
    return { status: 'in-sync', endpoints: remote.endpoints };
  }

  const local = new Set(operationSet(localOas));
  const dashboard = new Set(remote.operations);
  const missing = [...local].filter((op) => !dashboard.has(op)).sort();
  const extra = [...dashboard].filter((op) => !local.has(op)).sort();

  return {
    status: 'behind',
    missing, // in your spec, not on the dashboard
    extra, // on the dashboard, not in your spec
    // Same operations either way, so what differs is inside them.
    contentOnly: missing.length === 0 && extra.length === 0,
    endpoints: remote.endpoints,
    oasSyncedAt: remote.oasSyncedAt,
  };
}

/** How to say it. Returns [] when there is nothing worth saying. */
export function describeDashboardGap(cmp) {
  if (!cmp) return [];
  if (cmp.status === 'in-sync') return [];
  if (cmp.status === 'no-remote-spec') {
    return [`  ${yellow('!')} ${bold('Your dashboard has no spec yet.')} Pushing will add it.`];
  }
  const lines = [];
  if (cmp.contentOnly) {
    lines.push(`  ${yellow('!')} ${bold('Your dashboard has an older version')} of this spec.`);
    lines.push(`  ${dim('Same endpoints, but the descriptions or schemas it serves are out of date.')}`);
    return lines;
  }
  const n = cmp.missing.length;
  if (n) {
    lines.push(
      `  ${yellow('!')} ${bold(`Your dashboard is missing ${n} endpoint${n === 1 ? '' : 's'}`)} that your spec has:`,
    );
    for (const op of cmp.missing.slice(0, 10)) lines.push(`    ${green('+')} ${op}`);
    if (n > 10) lines.push(`    ${dim(`… and ${n - 10} more`)}`);
  }
  if (cmp.extra.length) {
    lines.push(
      `  ${dim(`${cmp.extra.length} endpoint${cmp.extra.length === 1 ? '' : 's'} on the dashboard are no longer in your spec.`)}`,
    );
  }
  return lines;
}

/**
 * Push the settings blob. Lives next to `pushOas` because the two are always
 * used together and were previously written out three times: here, in the
 * flag-driven path, and inline in the update command.
 */
export async function pushSettings({ rootDir, projectId, token }) {
  try {
    const res = await fetch(`${SITE_URL}/api/projects/${projectId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, settings: loadSettings(rootDir) }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Settings sync failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Settings sync failed: ${err.message}` };
  }
}

/**
 * The interactive flow. Returns `{ changed, oasFile }` - `changed` says
 * whether settings were written, so the caller knows if there is anything to
 * sync.
 */
export default async function updateOas({ rootDir, packageDir, apiEntry, setSpinner = () => {} }) {
  const currentCount = apiEntry.oasFile
    ? countOasEndpoints(path.join(rootDir, apiEntry.oasFile))
    : null;

  console.log('');
  console.log(`  ${bold('Spec')} ${apiEntry.oasFile ? cyan(apiEntry.oasFile) : dim('none yet')}`);
  console.log(
    `  ${dim(
      [
        describeOasSource(apiEntry.oasSource),
        currentCount === null ? null : `${currentCount} endpoint${currentCount === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · '),
    )}`,
  );

  const actions = buildActions(apiEntry);
  const picked = actions[
    await singleSelect(
      actions.map((a) => ({ label: a.label, hint: a.hint })),
      { message: 'How should we refresh it?', defaultIndex: 0 },
    )
  ];
  debug.log('update-oas.action', { action: picked.key, kind: apiEntry.oasSource?.kind || null });

  const before = readCurrentSpec(rootDir, apiEntry.oasFile);
  const result = await runAction({
    action: picked.key, apiEntry, rootDir, packageDir, setSpinner,
  });
  if (!result) {
    console.log('');
    console.log(`  ${dim('Nothing changed.')}`);
    return { changed: false };
  }

  const after = readCurrentSpec(rootDir, result.oasFile);
  const endpoints = countOasEndpoints(path.join(rootDir, result.oasFile));
  const diff = reportDiff(before, after, endpoints ?? 0);

  // Removing endpoints from a published spec is the destructive direction:
  // anything the docs and the MCP tools offered stops existing. Say so
  // unconditionally - a run with no one watching still has to leave a record
  // of what it dropped - and prompt only when there's someone to answer.
  if (diff.removed.length) {
    const n = diff.removed.length;
    console.log('');
    console.log(
      `  ${yellow('!')} ${n} endpoint${n === 1 ? '' : 's'} would disappear from your docs and MCP tools.`,
    );
    if (isInteractive()) {
      const ok = await askYesNo(`  Continue? ${dim('(y/N) ')}`, { defaultValue: false });
      if (!ok) {
        console.log(dim('  Left settings alone. The file on disk is whatever the refresh wrote.'));
        return { changed: false };
      }
    }
  }

  if (!recordSpec({ rootDir, apiEntry, oasFile: result.oasFile, oasSource: result.oasSource })) {
    return { changed: false };
  }

  console.log('');
  console.log(`  ${green('✓')} ${bold(result.oasFile)} recorded in .restless/settings.json.`);
  if (result.oasFile !== apiEntry.oasFile) {
    console.log(`  ${dim(`Commit it - ${CLI_NAME} and the SDK both read this path.`)}`);
  }
  return { changed: true, oasFile: result.oasFile };
}
