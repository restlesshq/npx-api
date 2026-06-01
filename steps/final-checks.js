import fs from 'fs';
import path from 'path';
import { bold, dim, green, yellow, red, cyan, orange, ask, askYesNo, waitForKey } from '../lib/ui.js';
import { loadSettings } from '../lib/settings.js';
import { getSdkLineSpec } from '../lib/setup-context.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import { findSdkReferences } from '../lib/grep-sdk.js';
import * as debug from '../lib/debug.js';
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
 * Find the entry source file the SDK is actually wired into. Two-layer
 * check (matches install-sdk's `findWiredSourceFile`): grep for any
 * `@restlessai/sdk` reference, then verify each candidate with the
 * writer's `parse()` so we don't treat a stale comment or partial
 * leftover as a wired block.
 *
 * Preference order:
 *   1. `ctx.entryFile` if install-sdk already pinned one (relative path
 *      under installDir). Saves a re-grep and keeps the two steps in
 *      lockstep.
 *   2. Grep for candidates, parse each, return the first that's a real
 *      block.
 */
function findWiredSourceFile(installDir, ctx) {
  const writer = getSdkWriter(ctx?.language || 'javascript');

  // `hasSdkReference` (loose), not `hasInit` (strict). The strict check
  // rejects OLD-API files (they have the import but no factory call),
  // and final-checks specifically wants to FIND those so the old-api
  // repair flow can rewrite them. install-sdk uses hasInit for its own
  // "should we skip the AI wiring pass?" decision, which is correct
  // there - here we want the wider net.
  if (ctx?.entryFile) {
    const abs = path.isAbsolute(ctx.entryFile)
      ? ctx.entryFile
      : path.join(installDir, ctx.entryFile);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      if (writer.hasSdkReference(content)) return abs;
    } catch {}
  }

  const candidates = findSdkReferences(installDir);
  for (const rel of candidates) {
    const abs = path.join(installDir, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      if (writer.hasSdkReference(content)) return abs;
    } catch {}
  }
  return null;
}

/**
 * Static security analysis of an `owner.id` expression. Returns one of:
 *   - { severity: 'ok',       reason: null }
 *   - { severity: 'warning',  reason: '...' }   ← suspect but possibly legit
 *   - { severity: 'critical', reason: '...' }   ← definitely wrong
 *
 * `owner.id` is sent to Restless on every request and pins the customer's
 * entire log history. The risks we screen for:
 *
 *   - **Secrets in the id.** API keys, tokens, passwords. The id leaves
 *     the user's machine; secrets must not.
 *   - **User-controlled input** (`req.body`, `req.query`, request cookies).
 *     A caller can spoof another tenant's id and have their requests
 *     attributed elsewhere on the dashboard. This is the worst case.
 *   - **Raw header reads** without a trusted proxy. Spoofable end-to-end.
 *     Possibly legit if a reverse proxy strips client-supplied versions
 *     and sets the value itself - flagged as warning, not critical.
 *   - **Mutable-looking fields** like `.email`, `.username`, `.name`.
 *     These rotate; using one as `id` fragments log history when the
 *     user edits them.
 *   - The install-sdk **sentinel placeholder** the AI emits when it
 *     couldn't pick anything.
 *
 * Heuristic-only. The semantic verify pass (verify-owner-id) catches
 * cases that need codebase context (e.g. is `workspace.subdomain`
 * actually mutable in this project's schema).
 */
const RISKY_TOKENS = [
  'authorization', 'apikey', 'api_key', 'api-key', 'x-api-key',
  'x-auth', 'secret', 'token', 'password', 'bearer',
];

// AI emits this literal when it can't find a stable internal id. Treat
// it as "needs repair" so the interactive prompt fires.
const SENTINEL_PLACEHOLDER = "'NEEDS_CONFIGURATION'";

const MUTABLE_TAIL_FIELDS = new Set([
  'email', 'username', 'name', 'displayname', 'display_name',
  'handle', 'slug', 'nickname', 'alias', 'login',
]);

// Literal string values that almost certainly indicate "I didn't have a
// real id, so I picked a placeholder." Using one of these here fake-
// groups every unauthenticated / unknown request under a single tenant
// on the dashboard, masking the fact that they're actually anonymous.
// The right way to signal "no owner for this request" is `undefined`
// (or omitting the owner block entirely); the SDK has its own anonymous
// bucket on the wire-format side.
const PLACEHOLDER_STRINGS = new Set([
  'anonymous', 'none', 'unknown', 'guest', 'default', 'placeholder',
  'nobody', 'null', 'undefined', 'test', 'todo',
]);

export function analyzeOwnerId(expr) {
  if (!expr || typeof expr !== 'string') {
    return { severity: 'critical', reason: 'no owner.id is set' };
  }
  const trimmed = expr.trim();

  if (trimmed === SENTINEL_PLACEHOLDER || trimmed === '"NEEDS_CONFIGURATION"') {
    return {
      severity: 'critical',
      reason: "set to the 'NEEDS_CONFIGURATION' placeholder - the installer couldn't find a stable id",
    };
  }

  const e = trimmed.toLowerCase();

  // Whitelisted: hashed values (e.g. restless.mask(...)) are one-way safe.
  // Even though we tell the AI not to use mask() here, treat it as ok if
  // it slipped through - it's not a security problem, just a UX one.
  if (/\bmask\s*\(/.test(e)) {
    return { severity: 'ok', reason: null };
  }

  // Critical: raw secrets.
  if (RISKY_TOKENS.some((t) => e.includes(t)) || /^\s*key\s*$/.test(e)) {
    return {
      severity: 'critical',
      reason: 'looks like a raw secret (auth header, api key, token, or password)',
    };
  }

  // Critical: literal placeholder string. Returns `"anonymous"` (or
  // similar dummy) for unknown callers fake-groups them on the dashboard.
  // The user should return undefined / omit owner instead.
  const stringLit = trimmed.match(/^(['"])(.+)\1$/);
  if (stringLit) {
    const value = stringLit[2].toLowerCase();
    if (PLACEHOLDER_STRINGS.has(value)) {
      return {
        severity: 'critical',
        reason: `the literal '${stringLit[2]}' fake-groups every request under one tenant. Return \`undefined\` (or omit \`owner\`) when there's no real owner for the request.`,
      };
    }
  }

  // Critical: user-controlled input. A malicious caller can spoof these.
  if (/\breq\.body\b/.test(e)) {
    return {
      severity: 'critical',
      reason: 'pulled from the request body - a caller can spoof another tenant\'s id',
    };
  }
  if (/\breq\.query\b/.test(e)) {
    return {
      severity: 'critical',
      reason: 'pulled from the query string - a caller can spoof another tenant\'s id',
    };
  }
  if (/\b(?:req|ctx)\.cookies?\b/.test(e)) {
    return {
      severity: 'critical',
      reason: 'pulled from a cookie - caller-controlled unless it is a signed session cookie',
    };
  }

  // Warning: raw header read. Spoofable without a trusted reverse proxy
  // that strips client-supplied versions and sets the value itself.
  // Covers req.headers.*, req.headers[...], ctx.headers, ctx.request.headers,
  // and Hono's c.req.header('x').
  if (/\breq\.headers(\.|\[)/.test(e) ||
      /\bctx\.(request\.)?headers(\.|\[)/.test(e) ||
      /\bc\.req\.header\s*\(/.test(e)) {
    return {
      severity: 'warning',
      reason: 'pulled from a raw request header - only safe if a trusted proxy sets it and strips client-supplied versions',
    };
  }

  // Warning: mutable-looking field name at the tail of the expression.
  const tailMatch = trimmed.match(/\.([A-Za-z_]\w*)\s*$/);
  if (tailMatch && MUTABLE_TAIL_FIELDS.has(tailMatch[1].toLowerCase())) {
    return {
      severity: 'warning',
      reason: `ends in \`.${tailMatch[1]}\` - that field is typically user-editable, not immutable`,
    };
  }

  return { severity: 'ok', reason: null };
}

/**
 * Back-compat: returns true when the expression is anything other than
 * `ok`. Used to decide "needs repair" without needing the reason string.
 */
export function ownerIdLooksRisky(expr) {
  return analyzeOwnerId(expr).severity !== 'ok';
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
  const sourceFile = findWiredSourceFile(ctx.installDir, ctx);

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

  // ── 0. Old-SDK-API guard. The legacy SDK exposed `restless.setup(app,
  // cb)` directly on its default export. The new SDK exports a factory:
  // you call `restless(KEY)` to get a client, then call `.setup(cb)` on
  // it. A two-arg `.setup(...)` call is the old shape and crashes the
  // server at runtime with `_sdk.default.setup is not a function`. If we
  // see one here, every downstream check (init form, credential, owner)
  // is reading from a broken block, so surface this first and route the
  // user into a focused AI rewrite.
  const oldApiHit = writer.findOldApiSetup(content);
  if (oldApiHit !== null) {
    rows.push({
      kind: 'old-api',
      ok: false,
      severity: 'critical',
      label: 'SDK API shape',
      detail: `${red('two-arg setup(...) detected')} - this is the old SDK API; the new factory pattern is needed`,
    });
    // Stop here: the rest of the checks would just produce noise on a
    // file with broken wiring. The repair flow rewrites the call site,
    // then we re-run all checks against the new content.
    return rows;
  }

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

  // ── 3. owner.id security analysis. Four outcomes:
  //   - ok          → static fine AND no AI confirm marker. Pass.
  //   - unverified  → static fine BUT verify-owner-id left a CONFIRM
  //                   marker. The AI couldn't fully verify; ask the user
  //                   to confirm rather than nuking their probably-fine pick.
  //   - warning     → spoofable proxy header, mutable-looking field, etc.
  //   - critical    → secret / user-input / sentinel. Loud red.
  //
  // Critical wins over a CONFIRM marker: if the AI flagged it AND the
  // static check sees a secret/input pattern, the static signal is the
  // definitive one and we route through the repair flow.
  const idAnalysis = analyzeOwnerId(fields.ownerIdExpr);
  const confirmReason = fields.ownerIdConfirmReason;
  const exprText = fields.ownerIdExpr || '';
  let severity = idAnalysis.severity;
  if (confirmReason && severity !== 'critical') severity = 'unverified';

  let detail;
  if (severity === 'ok') {
    detail = cyan(exprText);
  } else if (!exprText) {
    detail = red('not set - every log will roll up as "anonymous", and the dashboard cannot group this customer');
  } else if (severity === 'critical') {
    detail = `${red(exprText)}\n      ${red('SECURITY RISK:')} ${idAnalysis.reason}`;
  } else if (severity === 'unverified') {
    detail = `${yellow(exprText)}\n      ${yellow('Needs your confirmation:')} ${confirmReason}`;
  } else {
    detail = `${yellow(exprText)}\n      ${yellow('Suspect:')} ${idAnalysis.reason}`;
  }
  rows.push({
    kind: 'owner-id',
    ok: severity === 'ok',
    severity,
    label: 'Owner identity',
    detail,
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
 * Repair an old-SDK-API call site. Single AI pass with a focused prompt
 * that knows exactly what shape to rewrite to (factory call + drop the
 * framework-instance arg + wrap in app.use / fastify.register + rename
 * `restless.X` to `sdk.X`). No user input fallback - if the AI can't do
 * this rewrite, manual editing is the answer; we surface the file path
 * so the user can open it.
 */
async function repairOldApi({ ctx, sourceFile, update, setSpinner, subIndex, prevSubs, baseMessage }) {
  const aiTool = ctx.aiTool || 'Claude Code';

  update({ activeSub: subIndex, sub: prevSubs, message: [
    ...baseMessage,
    `  Asking ${orange(aiTool)} to rewrite the call site to the new factory API.`,
    dim('  It edits only the SDK setup block; the callback body is preserved.'),
  ]});

  try {
    const prompt = loadPrompt('fix-old-api', {
      language: ctx.language || 'javascript',
      framework: ctx.framework || ctx.language || 'your framework',
    });
    await runAI(prompt, ctx.installDir, { setSpinner });
  } catch (err) {
    update({ activeSub: subIndex, sub: prevSubs, message: [
      ...baseMessage,
      `  ${yellow('⚠')} AI rewrite didn't complete: ${err.message}`,
      dim(`  Open ${bold(path.relative(ctx.installDir, sourceFile))} and apply the changes by hand.`),
    ]});
  }
}

/**
 * Repair a missing or risky `owner.id` in two passes: first hand the
 * problem back to the AI with a focused prompt (it has more codebase
 * context than us), then if it still can't find a stable identity, ask
 * the user to type one in. Either way the writer patches just the
 * owner.id line - the rest of the block is left alone.
 *
 * Returns nothing; the caller re-runs `runChecks` to see the new state.
 */
async function repairOwnerId({ ctx, sourceFile, writer, update, setSpinner, subIndex, prevSubs, baseMessage }) {
  const aiTool = ctx.aiTool || 'Claude Code';

  update({ activeSub: subIndex, sub: prevSubs, message: [
    ...baseMessage,
    `  Asking ${orange(aiTool)} to look again for a stable tenant or user id.`,
    dim('  It re-scans your codebase and patches only the owner.id line.'),
  ]});

  try {
    const prompt = loadPrompt('fix-owner-id', {
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
  const aiOk = !!aiFields.ownerIdExpr && !ownerIdLooksRisky(aiFields.ownerIdExpr);
  if (aiOk) return;

  update({ activeSub: subIndex, sub: prevSubs, message: [
    ...baseMessage,
    `  ${yellow('⚠')} Couldn't auto-pick a stable owner ID.`,
    dim('  owner.id is the permanent, immutable identifier the dashboard pins this'),
    dim('  customer\'s entire log history to. It must never change for the same customer.'),
    dim('  Some examples:'),
    `    ${cyan('req.user.workspaceId')}        ${dim('tenant from your auth context')}`,
    `    ${cyan("req.headers['x-workspace-id']")} ${dim('header set by your gateway')}`,
    `    ${cyan('req.user.id')}                 ${dim("user's stable internal id")}`,
    '',
    dim('  Do NOT enter an email, username, API key, or anything else that can change.'),
    '',
  ]});

  const answer = await ask(`  Enter an expression to use as owner.id ${dim('(or press Enter to skip)')}: `);
  const expr = (answer || '').trim();
  if (!expr) return;

  if (ownerIdLooksRisky(expr)) {
    update({ activeSub: subIndex, sub: prevSubs, message: [
      ...baseMessage,
      `  ${red('✗')} ${cyan(expr)} looks like a raw secret - owner.id leaves the user's machine on every request.`,
      dim('  Use a stable internal id (user / workspace / org) instead, or run setup again later.'),
    ]});
    return;
  }

  const latest = fs.readFileSync(sourceFile, 'utf8');
  const next = writer.setOwnerId(latest, expr);
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
  // pure `row.fix` thunk; `owner-id` is special - it needs an AI retry
  // plus a user-input fallback. `old-api` is also special - one AI pass
  // to rewrite the call site, then re-run all checks.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.ok) continue;

    if (row.kind === 'old-api') {
      const sourceFile = findWiredSourceFile(ctx.installDir, ctx);
      if (!sourceFile) continue;

      const yes = await askYesNo(
        `\n  ${yellow('⚠')} ${bold(row.label)}: ${row.detail}\n    Rewrite the call site to the current API now?`,
        { defaultValue: true },
      );
      if (!yes) continue;

      try {
        await repairOldApi({
          ctx, sourceFile, update, setSpinner, subIndex, prevSubs,
          baseMessage: renderReview(rows),
        });
        rows = runChecks(ctx);
        update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });
      } catch (err) {
        update({ activeSub: subIndex, sub: prevSubs, message: [
          ...renderReview(rows),
          `  ${red('✗')} Could not rewrite the SDK call site: ${err.message}`,
        ]});
      }
      continue;
    }

    if (row.kind === 'owner-id') {
      const writer = getSdkWriter(ctx.language);
      const sourceFile = findWiredSourceFile(ctx.installDir, ctx);
      if (!sourceFile) continue;

      // Branch on the severity. `unverified` means the verify pass kept
      // the value but wanted human confirmation - ask y/n, skip the full
      // repair flow. Anything else (warning / critical) goes through
      // repair as before.
      if (row.severity === 'unverified') {
        const yes = await askYesNo(
          `\n  ${yellow('?')} ${bold(row.label)}: ${row.detail}\n    Is this stable and immutable for your code? Pick "no" to enter a different one.`,
          { defaultValue: true },
        );
        if (yes) {
          // Strip the marker; the row becomes ok on re-run.
          const latest = fs.readFileSync(sourceFile, 'utf8');
          const next = writer.stripOwnerIdConfirm(latest);
          if (next !== latest) safeWriteFileSync(sourceFile, next);
          rows = runChecks(ctx);
          update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });
          continue;
        }
        // Fall through to repair: user said no, so we want the AI retry +
        // manual-entry escape hatch.
      } else {
        const yes = await askYesNo(
          `\n  ${yellow('⚠')} ${bold(row.label)}: ${row.detail}\n    Try to set this up now?`,
          { defaultValue: true },
        );
        if (!yes) continue;
      }

      try {
        await repairOwnerId({
          ctx, sourceFile, writer, update, setSpinner, subIndex, prevSubs,
          baseMessage: renderReview(rows),
        });
        rows = runChecks(ctx);
        update({ activeSub: subIndex, sub: prevSubs, message: renderReview(rows) });
      } catch (err) {
        update({ activeSub: subIndex, sub: prevSubs, message: [
          ...renderReview(rows),
          `  ${red('✗')} Could not repair owner ID: ${err.message}`,
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

  // Final state. The header has to reflect whether the checks actually
  // passed - earlier versions always wrote `✓ Final checks complete.`
  // and marked the substep done, which gave a green checkmark next to
  // a review block that warned "SDK isn't wired in." Don't do that.
  const allOk = rows.every((r) => r.ok);
  const allFixable = rows.every((r) => r.ok || typeof r.fix === 'function' || r.kind === 'owner-id' || r.kind === 'old-api');
  const headerLine = allOk
    ? `  ${green('✓')} Final checks complete.`
    : `  ${yellow('⚠')} Final checks finished with issues.`;
  update({
    sub: { ...prevSubs, [subIndex]: allOk ? 'done' : 'failed' },
    message: [
      headerLine,
      '',
      ...renderReview(rows),
      `  ${dim('Press ')}${bold('Enter')}${dim(' to move on.')}`,
    ],
  });
  if (!allOk) {
    debug.log('final-checks.unresolved', {
      rows: rows.map((r) => ({ kind: r.kind, ok: r.ok, fixable: typeof r.fix === 'function' || r.kind === 'owner-id' || r.kind === 'old-api' })),
      allFixable,
    });
  }

  while (true) {
    const k = await waitForKey();
    if (k === '\r' || k === '\n') break;
  }

  return {
    ok: rows.every((r) => r.ok),
    rows,
  };
}
