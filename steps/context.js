import {
  bold, dim, cyan, green, red, yellow, white, muted, askYesNo, startSpinner,
} from '../lib/ui.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import { extractJson } from '../lib/extract-json.js';
import { CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { describeRepo, changedSince, hasUncommittedChanges } from '../lib/context-repo.js';
import { screenCandidates } from '../lib/context-guard.js';
import { fetchScope, pushCandidates } from '../lib/context-sync.js';

/**
 * `npx restless context` - read this repo, propose what the AI should know
 * about the API, and put it in the dashboard's inbox for review.
 *
 * The shape of the whole thing, because it is the part worth getting right:
 *
 *   1. Sign in (the caller does this) and pick a project.
 *   2. Ask the project what it already knows, and when it last read THIS repo.
 *   3. Extract, here, in the developer's own agent. The repository never
 *      leaves the machine.
 *   4. Second pass: a fresh model call that sees only the extracted text, plus
 *      a set of deterministic rules. Anything either one flags is dropped and
 *      named on the terminal, so the developer can see the pass working
 *      without the offending text going anywhere.
 *   5. Show what survived, ask, upload. The server runs its own adversarial
 *      review before anything is stored, and everything lands as pending.
 *
 * Re-running is the normal case, not the exception. A second run diffs against
 * the commit the last one recorded and only reads what changed, which is why
 * the whole thing is cheap enough to put in a habit or a CI job.
 */

const MAX_CANDIDATES = 25;
// Enough files to describe a real change set without turning the prompt into
// the repository. Past this we stop pretending it is an incremental run.
const MAX_CHANGED_FILES = 60;

/** The scope paragraph the extraction prompt is built around. */
function describeScope({ mode, files, lastRun, label }) {
  if (mode === 'full') {
    return [
      'This is a **full pass**. Read the whole repository.',
      lastRun?.headSha
        ? `\nThis repo was indexed before, at \`${lastRun.headSha.slice(0, 8)}\`, but that commit is not in this checkout (a rebase, a squash, or a shallow clone), so the diff cannot be trusted and everything is being re-read. The "Already covered" list below is what came out of it. Do not propose those again.`
        : `\nNothing from ${label} has been indexed before, so everything here is new ground.`,
    ].join('\n');
  }

  return [
    `This is an **incremental pass**. ${label} was last indexed at commit \`${lastRun.headSha.slice(0, 8)}\`${lastRun.ranAt ? ` on ${new Date(lastRun.ranAt).toLocaleDateString()}` : ''}.`,
    '',
    'Only these files have changed since. Read them, and whatever you need around them to understand them, but do not go trawling the rest of the repository: everything else was covered by an earlier run.',
    '',
    files.map((f) => `- ${f}`).join('\n'),
    '',
    'Propose something only if these changes actually created or corrected a fact a developer needs. A refactor that moved code without changing the API is a legitimate empty result. Return `[]` and say nothing rather than padding.',
  ].join('\n');
}

/** Compact list of what the project already has, for the "don't repeat" list. */
function describeExisting(existing) {
  const context = existing?.context ?? [];
  const usecases = existing?.usecases ?? [];
  if (!context.length && !usecases.length) {
    return 'Nothing saved yet. This project has no context and no use cases.';
  }
  const lines = [];
  if (context.length) {
    lines.push('Context items:');
    lines.push(...context.map((c) => `- ${c.title}`));
  }
  if (usecases.length) {
    if (lines.length) lines.push('');
    lines.push('Use cases:');
    lines.push(...usecases.map((c) => `- ${c.title}`));
  }
  return lines.join('\n');
}

/** Normalize one item out of the model's JSON. Returns null to drop it. */
function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw.target === 'usecase' ? 'usecase' : 'context';
  const title = String(raw.title ?? '').trim();
  const content = String(raw.content ?? '').trim();
  if (!title || !content) return null;

  const files = Array.isArray(raw.files)
    ? raw.files.filter((f) => typeof f === 'string' && f.trim()).slice(0, 5)
    : [];

  const out = { target, title, content, files };
  if (typeof raw.endpoint === 'string' && raw.endpoint.trim()) {
    out.endpoint = raw.endpoint.trim();
  }
  if (target === 'usecase') {
    out.description = String(raw.description ?? '').trim();
    out.icon = String(raw.icon ?? 'circle').trim() || 'circle';
    out.docsBody = String(raw.docsBody ?? '').trim();
  }
  return out;
}

/**
 * The second pass: an independent model call over the extracted text alone.
 *
 * Deliberately a SEPARATE `runAI` call rather than one more instruction on the
 * end of the extraction. The extracting agent has spent minutes reading a
 * private codebase, and the one question it is least able to answer honestly
 * is whether it absorbed something it should not repeat. This one starts cold,
 * sees only the candidates, and cannot go and look.
 *
 * Fails CLOSED. If the review cannot run, or its verdict cannot be parsed, we
 * withhold everything rather than fall back to "probably fine": the entire
 * value of a leak check is that it is not optional when it is inconvenient.
 */
async function reviewForLeaks(candidates, cwd, { setSpinner } = {}) {
  const prompt = loadPrompt('review-context', {
    candidates: JSON.stringify(
      candidates.map((c, i) => ({
        index: i,
        target: c.target,
        title: c.title,
        content: c.content,
        ...(c.description ? { description: c.description } : {}),
        ...(c.docsBody ? { docsBody: c.docsBody } : {}),
      })),
      null,
      2,
    ),
  });

  let verdicts;
  try {
    const raw = await runAI(prompt, cwd, { setSpinner });
    verdicts = extractJson(raw);
  } catch (err) {
    return {
      ok: false,
      error: `The redaction pass couldn't run (${err.message}).`,
    };
  }

  if (!Array.isArray(verdicts)) {
    return { ok: false, error: "The redaction pass didn't return a verdict we could read." };
  }

  const byIndex = new Map();
  for (const v of verdicts) {
    if (v && typeof v.index === 'number') byIndex.set(v.index, v);
  }

  const safe = [];
  const withheld = [];
  candidates.forEach((candidate, i) => {
    const verdict = byIndex.get(i);
    // No verdict for an item is not an approval. An item the reviewer skipped
    // is an item nobody checked.
    if (!verdict) {
      withheld.push({ title: candidate.title, reasons: ['the redaction pass did not rule on it'] });
      return;
    }
    if (verdict.safe === true) safe.push(candidate);
    else {
      withheld.push({
        title: candidate.title,
        reasons: [String(verdict.reason || 'flagged by the redaction pass')],
      });
    }
  });

  return { ok: true, safe, withheld };
}

/** Print what never left the machine, and why. */
function reportWithheld(withheld) {
  if (!withheld.length) return;
  console.log('');
  console.log(`  ${yellow('Withheld')} ${dim(`(${withheld.length}) - checked here, never uploaded:`)}`);
  for (const item of withheld) {
    console.log(`    ${dim('•')} ${white(item.title)}`);
    for (const reason of item.reasons) {
      console.log(`      ${dim(reason)}`);
    }
  }
}

/**
 * Run the whole thing for one already-chosen project.
 *
 * `project` is `{ projectId, name, slug }` from the picker; `token` is the
 * account session. Returns an exit code.
 */
export default async function contextStep({ project, token, cwd, cliVersion, yes = false }) {
  const repo = describeRepo(cwd);

  console.log('');
  console.log(`  ${bold('Repository')}  ${white(repo.label)}${repo.rootPath ? dim(`/${repo.rootPath}`) : ''}`);
  console.log(`  ${bold('Project')}     ${white(project.name || project.slug)}`);
  if (!repo.isGit) {
    console.log('');
    console.log(dim("  Not a git repo, so every run reads everything. Runs here can't be incremental."));
  } else if (hasUncommittedChanges(cwd)) {
    console.log('');
    console.log(dim('  Uncommitted changes are included in what gets read, but the'));
    console.log(dim(`  watermark is recorded at HEAD (${repo.headSha.slice(0, 8)}).`));
  }

  // ── What does the project already know? ──────────────────────────────
  const scopeSpinner = startSpinner('Checking what this project already knows');
  const scope = await fetchScope({ projectId: project.projectId, token, repo });
  scopeSpinner.stop();
  if (!scope.ok) {
    console.log('');
    console.log(red(`  ✗ ${scope.error}`));
    if (scope.expired) {
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} context`)} to sign in again.`));
    }
    console.log('');
    return 1;
  }

  // ── Full or incremental? ─────────────────────────────────────────────
  const lastRun = scope.source?.lastRun || null;
  let mode = 'full';
  let changedFiles = [];

  if (repo.isGit && lastRun?.headSha) {
    const diff = changedSince(cwd, lastRun.headSha);
    if (diff.ok) {
      if (diff.files.length === 0) {
        console.log('');
        console.log(green('  ✓ Nothing has changed since the last run.'));
        console.log(dim(`  ${repo.label} was last read at ${lastRun.headSha.slice(0, 8)}.`));
        console.log('');
        console.log(`  ${dim('Review anything still pending:')} ${cyan(scope.reviewUrl)}`);
        console.log('');
        return 0;
      }
      if (diff.files.length <= MAX_CHANGED_FILES) {
        mode = 'incremental';
        changedFiles = diff.files;
      } else {
        console.log('');
        console.log(dim(`  ${diff.files.length} files changed since the last run, so this is a full pass.`));
      }
    } else if (diff.reason === 'unknown-commit') {
      console.log('');
      console.log(dim(`  The last run's commit (${lastRun.headSha.slice(0, 8)}) isn't in this checkout,`));
      console.log(dim('  so this is a full pass rather than a diff against a commit we cannot see.'));
    }
  }

  console.log('');
  console.log(
    mode === 'incremental'
      ? `  ${dim(`Reading ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} since ${lastRun.headSha.slice(0, 8)}.`)}`
      : `  ${dim('Reading the whole repository.')}`,
  );

  // ── Pass 1: extract, on this machine ─────────────────────────────────
  const extractPrompt = loadPrompt('extract-context', {
    cwd,
    scope: describeScope({ mode, files: changedFiles, lastRun, label: repo.label }),
    existing: describeExisting(scope.existing),
    endpoints: (scope.endpoints || []).length
      ? scope.endpoints.join('\n')
      : '(This project has no OpenAPI spec yet, so leave `endpoint` out of every item.)',
    max: String(MAX_CANDIDATES),
  });

  let extracted;
  try {
    const raw = await runAI(extractPrompt, cwd);
    extracted = extractJson(raw);
  } catch (err) {
    console.log('');
    console.log(red(`  ✗ Couldn't read the repository: ${err.message}`));
    console.log('');
    return 1;
  }

  const candidates = (Array.isArray(extracted) ? extracted : [])
    .map(normalizeCandidate)
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    console.log('');
    console.log(green('  ✓ Nothing new worth saving.'));
    console.log(
      dim(
        mode === 'incremental'
          ? '  The changes since the last run did not alter the API contract.'
          : "  Either it is all covered already, or there is nothing here a caller could act on.",
      ),
    );
    console.log('');
    return 0;
  }

  // ── Pass 2: the leak check, before anything leaves ───────────────────
  // Deterministic rules first: they are free, they never need a model to
  // behave, and anything they catch does not need a second opinion.
  const screened = screenCandidates(candidates);
  const withheld = [...screened.withheld];

  let sendable = screened.safe;
  if (sendable.length) {
    const reviewSpinner = startSpinner('Second pass: checking nothing internal leaked');
    const review = await reviewForLeaks(sendable, cwd, {
      setSpinner: (s) => reviewSpinner.update(typeof s === 'string' ? s : s?.detail || ''),
    });
    reviewSpinner.stop();

    if (!review.ok) {
      // Fail closed. See `reviewForLeaks`.
      console.log('');
      console.log(red(`  ✗ ${review.error}`));
      console.log(dim('  Nothing was uploaded. The leak check is not optional, so a run'));
      console.log(dim('  that cannot complete it uploads nothing at all.'));
      console.log('');
      return 1;
    }
    sendable = review.safe;
    withheld.push(...review.withheld);
  }

  reportWithheld(withheld);

  if (!sendable.length) {
    console.log('');
    console.log(yellow('  Everything found was withheld. Nothing was uploaded.'));
    console.log('');
    return 0;
  }

  // ── Show what would go, and ask ──────────────────────────────────────
  console.log('');
  console.log(`  ${bold('Ready to upload')} ${dim(`(${sendable.length})`)}`);
  console.log('');
  for (const c of sendable) {
    const tag = c.target === 'usecase' ? cyan('use case') : muted('context ');
    console.log(`    ${tag}  ${white(c.title)}`);
    if (c.endpoint) console.log(`              ${dim(c.endpoint)}`);
  }
  console.log('');
  console.log(dim('  These go to your dashboard as pending suggestions. Nothing is'));
  console.log(dim('  published until you approve it there.'));
  console.log('');

  if (!yes && isInteractive()) {
    const go = await askYesNo('  Upload these for review?', { defaultValue: true });
    if (!go) {
      console.log('');
      console.log(dim('  Nothing uploaded.'));
      console.log('');
      return 0;
    }
  }

  // ── Upload ───────────────────────────────────────────────────────────
  const uploadSpinner = startSpinner('Uploading for review');
  const pushed = await pushCandidates({
    projectId: project.projectId,
    token,
    repo: {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      rootPath: repo.rootPath,
      localId: repo.localId,
      label: repo.label,
    },
    run: {
      headSha: repo.headSha,
      branch: repo.branch,
      mode,
      cliVersion,
      filesScanned: mode === 'incremental' ? changedFiles.length : 0,
      withheld: withheld.length,
    },
    candidates: sendable,
  });
  uploadSpinner.stop();

  if (!pushed.ok) {
    console.log('');
    console.log(red(`  ✗ ${pushed.error}`));
    if (pushed.expired) {
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} context`)} to sign in again.`));
    }
    console.log('');
    return 1;
  }

  console.log('');
  console.log(green(`  ✓ ${pushed.created} waiting for review.`));
  if (pushed.skippedDuplicate) {
    console.log(dim(`    ${pushed.skippedDuplicate} already covered by what you have saved.`));
  }
  if (pushed.skippedUnsafe) {
    // The server's own adversarial pass, independent of the two that ran here.
    console.log(dim(`    ${pushed.skippedUnsafe} dropped by the safety review on upload.`));
  }
  console.log('');
  console.log(`  ${bold('Review them:')} ${cyan(pushed.reviewUrl)}`);
  console.log('');
  console.log(dim(`  Run ${cyan(`npx ${CLI_NAME} context`)} again after your next change and it will`));
  console.log(dim('  only read what moved.'));
  console.log('');
  return 0;
}
