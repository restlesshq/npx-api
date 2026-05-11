import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, yellow, red, cyan, ask, askYesNo, waitForKey } from '../lib/ui.js';
import { loadSettings } from '../lib/settings.js';
import { getSdkLineSpec } from '../lib/setup-context.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import * as jsWriter from '../lib/sdk-writers/javascript.js';

/**
 * Pick the writer for ctx.language. Same registry as install-sdk.js;
 * keep them in lockstep when adding new languages.
 */
function getSdkWriter(language) {
  const writers = { javascript: jsWriter, typescript: jsWriter };
  return writers[language] || jsWriter;
}

/**
 * Find the entry source file the SDK is wired into. Same `grep` as
 * `isSdkWired`. Returns absolute path or null.
 */
function findWiredSourceFile(installDir) {
  try {
    const out = execSync(
      `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    const files = out.trim().split('\n').filter((f) => f && !f.includes('node_modules'));
    return files.length ? path.join(installDir, files[0].replace(/^\.\//, '')) : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic: is this `project.id` expression dangerous? Anything that
 * looks like a raw secret trips this. Conservative on purpose - this is
 * a UI nudge, not a refusal.
 */
const RISKY_TOKENS = [
  'authorization', 'apikey', 'api_key', 'api-key', 'x-api-key',
  'x-auth', 'secret', 'token', 'password', 'bearer',
];

export function projectIdLooksRisky(expr) {
  if (!expr || typeof expr !== 'string') return false;
  const e = expr.toLowerCase();
  if (/\bmask\s*\(/.test(e)) return false;
  if (RISKY_TOKENS.some((t) => e.includes(t))) return true;
  return /^\s*key\s*$/.test(e);
}

/**
 * Render the canonical init-arg description for the user. Mirrors what
 * the writer would emit. Used in the review row when the form is
 * already correct (just shows what's there).
 */
function describeInitForm(spec) {
  if (spec.form === 'literal') return `inline literal (${spec.value?.slice(0, 8)}...${spec.value?.slice(-4)})`;
  if (spec.form === 'env-ref') return `process.env.${spec.value}`;
  return 'no-arg (SDK auto-loads .env)';
}

/**
 * Run every check. Each check returns a row describing its outcome and,
 * when fixable, an `apply()` thunk that mutates the user's project.
 *
 * Pure-data checks (no I/O beyond reading files) live here; the I/O
 * happens in the orchestrator below so this stays testable.
 */
export function runChecks(ctx) {
  const writer = getSdkWriter(ctx.language);
  const sourceFile = findWiredSourceFile(ctx.installDir);

  if (!sourceFile) {
    return [{
      kind: 'no-source',
      ok: false,
      label: 'SDK wired in',
      detail: red('SDK isn\'t wired into any source file - re-run setup.'),
    }];
  }

  const relSource = path.relative(ctx.installDir, sourceFile);
  const content = fs.readFileSync(sourceFile, 'utf8');
  const rows = [];
  const fields = writer.readBlockFields(content);
  const want = getSdkLineSpec(ctx);

  // ── 1. Init form matches sdkLineSpec.
  const initFormOk = fields.initArgForm === want.form;
  rows.push({
    kind: 'init-form',
    ok: initFormOk,
    label: 'API key delivery',
    detail: initFormOk
      ? describeInitForm(want)
      : `${red(`is "${fields.initArgForm}"`)} but should be ${green(`"${want.form}"`)} per your setup`,
    fix: initFormOk ? null : () => {
      const fresh = fs.readFileSync(sourceFile, 'utf8');
      const next = writer.canonicalizeInitArg(fresh, ctx);
      if (next !== fresh) safeWriteFileSync(sourceFile, next);
    },
  });

  // ── 2. Credential extracted in setup callback.
  rows.push({
    kind: 'credential',
    ok: !!fields.credentialExpr,
    label: 'Credential extracted',
    detail: fields.credentialExpr
      ? cyan(fields.credentialExpr)
      : red('missing - every log will show up as anonymous'),
  });

  // ── 3. project.id present and not a raw secret.
  const idRisky = projectIdLooksRisky(fields.projectIdExpr);
  rows.push({
    kind: 'project-id',
    ok: !!fields.projectIdExpr && !idRisky,
    label: 'Project identity',
    detail: fields.projectIdExpr
      ? (idRisky
          ? `${red(fields.projectIdExpr)} (looks like a raw secret; open ${bold(relSource)} to fix)`
          : cyan(fields.projectIdExpr))
      : dim('(none set - logs roll up as anonymous; open the SDK block to add one)'),
  });

  // ── 4. .gitignore covers .env. Only run when we created the .env file
  // ourselves - if the user already had one, we trust they manage it.
  const gi = path.join(ctx.installDir, '.gitignore');
  if (ctx.createdEnvFile && fs.existsSync(gi)) {
    let giContent = '';
    try { giContent = fs.readFileSync(gi, 'utf8'); } catch {}
    const covered = /(^|\n)\.env(\s|$|\/)/.test(giContent);
    rows.push({
      kind: 'gitignore',
      ok: covered,
      label: '.gitignore covers .env',
      detail: covered ? '.env is ignored' : red('.env is not ignored - your key could land in git'),
      fix: covered ? null : () => safeAppendFileSync(gi, '\n.env\n'),
    });
  }

  // ── 5. Redacted fields (informational - no fail state).
  const settings = loadSettings(ctx.rootDir);
  const apiEntry = settings.apis?.find((a) => (a.rootDir || '.') === (ctx.apiRootDir || '.')) || settings.apis?.[0];
  const redactList = [
    ...((apiEntry?.redact?.headers) || []),
    ...((apiEntry?.redact?.bodyKeys) || []),
    ...((apiEntry?.redact?.queryParams) || []),
  ];
  rows.push({
    kind: 'redact',
    ok: true,
    label: 'Redacted fields',
    detail: redactList.length ? cyan(redactList.join(', ')) : dim('(none beyond SDK defaults)'),
  });

  return rows;
}

function renderRow(row) {
  const icon = row.ok ? green('✓') : yellow('⚠');
  return `  ${icon} ${bold(row.label.padEnd(22))} ${row.detail}`;
}

/**
 * Repair a missing or risky `project.id` in two passes: first hand the
 * problem back to the AI with a focused prompt (it has more codebase
 * context than us), then if it still can't find a stable identity, ask
 * the user to type one in. Either way the writer patches just the
 * project.id line - the rest of the block is left alone.
 *
 * Returns nothing; the caller re-runs `runChecks` to see the new state.
 */
async function repairProjectId({ ctx, sourceFile, writer, update, setSpinner, subIndex, prevSubs, baseMessage }) {
  const aiTool = ctx.aiTool || 'Claude Code';

  update({ activeSub: subIndex, sub: prevSubs, message: [
    ...baseMessage,
    `  Asking ${cyan(aiTool)} to look again for a stable tenant or user id.`,
    dim('  It re-scans your codebase and patches only the project.id line.'),
  ]});

  try {
    const prompt = loadPrompt('fix-project-id', {
      language: ctx.language || 'javascript',
      framework: ctx.framework || ctx.language || 'your framework',
    });
    await runAI(prompt, ctx.installDir, { setSpinner });
  } catch (err) {
    update({ activeSub: subIndex, sub: prevSubs, message: [
      ...baseMessage,
      `  ${yellow('⚠')} AI retry didn't complete: ${err.message}`,
    ]});
  }

  const afterAi = fs.readFileSync(sourceFile, 'utf8');
  const aiFields = writer.readBlockFields(afterAi);
  const aiOk = !!aiFields.projectIdExpr && !projectIdLooksRisky(aiFields.projectIdExpr);
  if (aiOk) return;

  update({ activeSub: subIndex, sub: prevSubs, message: [
    ...baseMessage,
    `  ${yellow('⚠')} Couldn't auto-pick a stable project ID.`,
    dim('  This identifies each customer on the dashboard. Some examples:'),
    `    ${cyan('req.user.workspaceId')}        ${dim('tenant from your auth context')}`,
    `    ${cyan("req.headers['x-workspace-id']")} ${dim('header set by your gateway')}`,
    `    ${cyan('req.user.id')}                 ${dim("user's stable internal id")}`,
    '',
  ]});

  const answer = await ask(`  Enter an expression to use as project.id ${dim('(or press Enter to skip)')}: `);
  const expr = (answer || '').trim();
  if (!expr) return;

  if (projectIdLooksRisky(expr)) {
    update({ activeSub: subIndex, sub: prevSubs, message: [
      ...baseMessage,
      `  ${red('✗')} ${cyan(expr)} looks like a raw secret - project.id leaves the user's machine on every request.`,
      dim('  Use a stable internal id (user / workspace / org) instead, or run setup again later.'),
    ]});
    return;
  }

  const latest = fs.readFileSync(sourceFile, 'utf8');
  const next = writer.setProjectId(latest, expr);
  if (next !== latest) safeWriteFileSync(sourceFile, next);
}

/**
 * Verifier-only final check step. Runs deterministic checks against
 * the wired SDK block and project state. When a check fails AND has a
 * fix function, prompts the user to apply it. The AI is never
 * dispatched here - past bugs came from a second AI pass undoing
 * decisions the CLI had just made.
 */
export default async function finalChecks({
  ctx,
  update,
  setSpinner,
  subIndex = 3,
  prevSubs = {},
}) {
  update({ status: 'active', activeSub: subIndex, sub: prevSubs, message: [
    `  Running final checks - confirming the SDK is wired correctly and won't go silent.`,
    dim('  Reading the managed SDK block, .gitignore, and your redact list.'),
  ]});
  setSpinner?.('');

  let rows = runChecks(ctx);

  // Render the initial review.
  const renderReview = (checks) => [
    `  ${bold('Review')} ${dim('— current state of the install:')}`,
    '',
    ...checks.map(renderRow),
    '',
  ];

  update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });

  // Walk the failed rows and offer to apply each. Most checks expose a
  // pure `row.fix` thunk; `project-id` is special - it needs an AI retry
  // plus a user-input fallback, so it gets its own repair flow.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.ok) continue;

    if (row.kind === 'project-id') {
      const writer = getSdkWriter(ctx.language);
      const sourceFile = findWiredSourceFile(ctx.installDir);
      if (!sourceFile) continue;

      const yes = await askYesNo(
        `\n  ${yellow('⚠')} ${bold(row.label)}: ${row.detail}\n    Try to set this up now?`,
        { defaultValue: true },
      );
      if (!yes) continue;

      try {
        await repairProjectId({
          ctx, sourceFile, writer, update, setSpinner, subIndex, prevSubs,
          baseMessage: renderReview(rows),
        });
        rows = runChecks(ctx);
        update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });
      } catch (err) {
        update({ activeSub: subIndex, sub: prevSubs, message: [
          ...renderReview(rows),
          `  ${red('✗')} Could not repair project ID: ${err.message}`,
        ]});
      }
      continue;
    }

    if (!row.fix) continue;

    const yes = await askYesNo(
      `\n  ${yellow('⚠')} ${bold(row.label)}: ${row.detail}\n    Fix this now?`,
      { defaultValue: true },
    );

    if (yes) {
      try {
        await row.fix();
        // Re-run checks - one fix may unblock another (e.g. canonicalizing
        // the init line affects later reads).
        rows = runChecks(ctx);
        update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });
      } catch (err) {
        update({ activeSub: subIndex, sub: prevSubs, message: [
          ...renderReview(rows),
          `  ${red('✗')} Could not apply fix: ${err.message}`,
        ]});
      }
    }
  }

  // Final state.
  update({ sub: { ...prevSubs, [subIndex]: 'done' }, message: [
    `  ${green('✓')} Final checks complete.`,
    '',
    ...renderReview(rows),
    `  ${dim('Press ')}${bold('Enter')}${dim(' to move on.')}`,
  ]});

  while (true) {
    const k = await waitForKey();
    if (k === '\r' || k === '\n') break;
  }

  return {
    ok: rows.every((r) => r.ok),
    rows,
  };
}
