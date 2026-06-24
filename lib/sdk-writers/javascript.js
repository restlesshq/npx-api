import { getSdkLineSpec } from '../setup-context.js';

/**
 * Owns the SDK setup code in JavaScript / TypeScript source files.
 *
 * No sentinel comments: the CLI finds the SDK code by content patterns
 * (init line via `require('@restlessai/sdk')` or `import ... from
 * '@restlessai/sdk'`, callback via `sdk.setup(...)`). That keeps the
 * user's source clean but means we cannot wholesale replace the SDK
 * code on re-runs - we can only patch known lines (init arg, owner.id)
 * with regex-anchored edits.
 *
 * Owner vs project: the current SDK takes `owner: { id, ... }` in the
 * setup callback. Before the rename it was `project: { id, ... }`, which
 * the SDK still accepts as an alias. Read paths accept both shapes so a
 * re-run against pre-rename source still parses; write paths emit only
 * `owner` going forward.
 *
 * This file is the JS/TS dialect. Other languages (Python, Ruby, etc.)
 * get their own sibling file with the same exported shape.
 */

const TODO_INLINE = '// TODO: move this out of the codebase before committing';

// Loose marker: a quoted string `'@restlessai/sdk'` somewhere in the
// file. Used by `parse()` to locate a managed block once we already
// know we're looking at a wired file. Do NOT use this on its own to
// decide "is the SDK wired?" - it false-positives on stray comments,
// test fixtures, and config strings that happen to mention the
// package name.
const SDK_REF_RE = /['"]@restlessai\/sdk['"]/;

// Strict init marker: requires an actual CJS `require('@restlessai/sdk')`
// call or an ESM `from '@restlessai/sdk'` import statement. Used as a
// LOOSE pre-filter for find-on-disk operations; `hasInit` layers a
// factory-call check on top for the wiring gate.
const SDK_INIT_RE =
  /(?:require\s*\(\s*['"]@restlessai\/sdk['"]\s*\)|from\s+['"]@restlessai\/sdk['"])/;

/**
 * Build the SDK init expression (just the right-hand side - the
 * `require(...)(...)` / `restless(...)` factory call). The init line
 * itself is assembled in `generate()` once we know whether we're
 * emitting CJS or ESM.
 */
function buildInitArg(ctx) {
  const spec = getSdkLineSpec(ctx);
  if (spec.form === 'literal') return JSON.stringify(spec.value);
  if (spec.form === 'env-ref') return `process.env.${spec.value}`;
  return ''; // no-arg
}

/**
 * Generate the init line for the chosen module system. CJS uses an
 * immediate factory call (`const x = require(...)(arg)`), ESM uses a
 * separate import + call so the factory is named.
 */
function buildInitLines(ctx, moduleSystem) {
  const arg = buildInitArg(ctx);
  if (moduleSystem === 'esm') {
    return [
      `import restless from '@restlessai/sdk';`,
      `const sdk = restless(${arg});`,
    ];
  }
  return [`const sdk = require('@restlessai/sdk')(${arg});`];
}

/**
 * Build the registration line(s) for the chosen framework. Each
 * framework hooks the SDK in differently:
 *   express / koa / hono / connect: app.use(sdk.setup(cb))
 *   fastify:                       fastify.register(sdk.setup(cb))
 *   http (node:http):              wrap the request handler manually
 *
 * `appVar` is the variable name holding the framework instance in the
 * user's source ('app', 'server', 'fastify', etc.).
 */
function buildRegistration({ framework, appVar }, callbackBody) {
  const fw = (framework || '').toLowerCase();
  const cb = `(req) => (${callbackBody})`;
  if (fw.includes('fastify')) return [`${appVar}.register(sdk.setup(${cb}));`];
  if (fw.includes('http') && !fw.includes('hono')) {
    return [`// Wrap your request handler with: sdk.setup(${cb})`];
  }
  return [`${appVar}.use(sdk.setup(${cb}));`];
}

/**
 * Build the body of the setup callback: an object literal returning at
 * minimum `apiKey: sdk.mask(<credential>)`, and `owner: { id: ... }` if
 * the AI surfaced a stable identity expression.
 */
function buildCallbackBody({ credentialExpr, ownerIdExpr }) {
  const lines = ['{'];
  lines.push(`  apiKey: sdk.mask(${credentialExpr || 'undefined'}),`);
  if (ownerIdExpr) {
    lines.push(`  owner: { id: ${ownerIdExpr} },`);
  }
  lines.push('}');
  return lines.join('\n  ');
}

/**
 * Produce the SDK init + registration code as a single string. Caller
 * is responsible for inserting it at the right place in the source
 * file (after imports, before route definitions). Always ends with a
 * newline so callers can concatenate cleanly.
 *
 * `plan` is what the AI returned: { module, framework, appVar,
 * credentialExpr, ownerIdExpr }. `ctx` provides the SetupContext so
 * the init line follows `sdkLineSpec`.
 */
export function generate(ctx, plan) {
  const moduleSystem = plan.module || 'cjs';
  const inlineWarning = ctx.keyDelivery === 'inline' ? [TODO_INLINE] : [];
  const initLines = buildInitLines(ctx, moduleSystem);
  const callbackBody = buildCallbackBody(plan);
  const registration = buildRegistration(plan, callbackBody);

  const out = [
    ...inlineWarning,
    ...initLines,
    '',
    ...registration,
    '',
  ];
  return out.join('\n');
}

/**
 * Detect whether the file references `@restlessai/sdk` at all. Returns
 * a `{ block, startIdx, endIdx }` wrapper compatible with the previous
 * sentinel-based API, where the "block" is just the whole file - patch
 * functions in this writer operate by regex on the full content rather
 * than carving out a delimited region.
 *
 * Loose check: any mention of the package name in quotes counts. Use
 * `hasInit()` instead if you need a definitive "is this file actually
 * wired in" signal.
 */
export function parse(content) {
  if (!content || !SDK_REF_RE.test(content)) return null;
  return { block: content, startIdx: 0, endIdx: content.length };
}

/**
 * Loose "does this file reference the SDK in a way that matters?" check.
 * Matches an actual require() or `from '@restlessai/sdk'` statement, not
 * just any quoted mention. Used by final-checks so an OLD-API file still
 * surfaces here for the old-api repair flow to find and rewrite. Returns
 * true on both legacy and current shapes.
 *
 * Use `hasInit` instead when the question is "is this file wired with
 * the current factory pattern?" - that one rejects old-API correctly.
 */
export function hasSdkReference(content) {
  if (!content) return false;
  return SDK_INIT_RE.test(content);
}

/**
 * Strict "is the SDK actually plumbed into this file with the current
 * API shape?" check. Requires:
 *
 *   1. A require or import statement for `@restlessai/sdk`.
 *   2. An actual FACTORY CALL using the binding from (1). One of:
 *        require('@restlessai/sdk')(<anything>)       // immediate-call (CJS)
 *        const NAME = require('@restlessai/sdk'); NAME(<anything>)
 *        import NAME from '@restlessai/sdk'; const x = NAME(<anything>)
 *
 * Why both: the OLD SDK API was `import restless from '@restlessai/sdk';
 * restless.setup(app, cb);` - no factory call, the default export was an
 * object with `.setup` and `.mask` on it directly. Source files upgraded
 * from a project on the old SDK still have the import line and the
 * `.setup` call, but `restless` is the factory function in the new SDK,
 * so `restless.setup` is `undefined`. Past incident: install-sdk treated
 * those files as "already wired" and skipped the AI rewrite; the user's
 * server crashed with `_sdk.default.setup is not a function`.
 *
 * `\bNAME\s*\(` requires NAME followed (after optional whitespace) by
 * `(`, which matches `NAME(arg)` but NOT `NAME.setup(arg)` or
 * `NAME.mask(arg)` - those have a `.` between the binding and the `(`.
 * That's the test that distinguishes "you called the factory" from
 * "you used the binding as an object."
 */
export function hasInit(content) {
  if (!content) return false;

  // Form 1: immediate-call CJS, `require('@restlessai/sdk')(...)`.
  if (/require\s*\(\s*['"]@restlessai\/sdk['"]\s*\)\s*\(/.test(content)) {
    return true;
  }

  // Form 2: named CJS, `const NAME = require('@restlessai/sdk'); ... NAME(...)`.
  const cjsNamed = content.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]@restlessai\/sdk['"]\s*\)\s*;?/,
  );
  if (cjsNamed) {
    const name = cjsNamed[1];
    const rest = content.slice(cjsNamed.index + cjsNamed[0].length);
    if (new RegExp(`\\b${name}\\s*\\(`).test(rest)) return true;
  }

  // Form 3: ESM, `import NAME from '@restlessai/sdk'; ... NAME(...)`.
  const esm = content.match(/import\s+(\w+)\s+from\s+['"]@restlessai\/sdk['"]/);
  if (esm) {
    const name = esm[1];
    const rest = content.slice(esm.index + esm[0].length);
    if (new RegExp(`\\b${name}\\s*\\(`).test(rest)) return true;
  }

  return false;
}

/**
 * Best-effort extraction of fields from an existing block: which form
 * the init line is using, the credential expression, the owner.id
 * expression. Used by finalChecks to read what's actually wired in
 * without an AI pass.
 *
 * Reads `owner: { id }` (current shape) and falls back to `project: { id }`
 * (legacy shape) so re-runs against a pre-rename file still surface the
 * expression. The writer emits `owner: { id }` on every new generation.
 */
export function readBlockFields(blockText) {
  const out = {
    initArgForm: null, // 'literal' | 'env-ref' | 'no-arg'
    initArgValue: null,
    credentialExpr: null,
    ownerIdExpr: null,
    /**
     * When the verify-owner-id pass kept the AI's pick but wanted the
     * user to confirm, it leaves a `// RESTLESS_OWNER_ID_CONFIRM: <reason>`
     * comment on the line above the owner. This field captures the reason
     * (or null if there's no marker). final-checks routes to a
     * confirmation prompt rather than the full repair flow when set.
     */
    ownerIdConfirmReason: null,
  };
  if (!blockText) return out;

  // Init line: `require('@restlessai/sdk')(<arg>)` or `restless(<arg>)`.
  const cjs = blockText.match(/require\(['"]@restlessai\/sdk['"]\)\(([^)]*)\)/);
  const esm = blockText.match(/^\s*(?:const|let|var)\s+\w+\s*=\s*\w+\(([^)]*)\)\s*;?\s*$/m);
  const argRaw = (cjs?.[1] ?? esm?.[1] ?? '').trim();
  if (argRaw === '') {
    out.initArgForm = 'no-arg';
  } else if (/^['"](?:rstlss_|rdme_)/.test(argRaw)) {
    out.initArgForm = 'literal';
    out.initArgValue = argRaw.slice(1, -1);
  } else if (/process\.env\./.test(argRaw)) {
    out.initArgForm = 'env-ref';
    out.initArgValue = argRaw.replace(/^process\.env\./, '');
  }

  // Credential expression: inside `<client>.mask(<expr>)`. The client
  // binding can be ANY identifier - the writer emits `sdk`, the guide's
  // CJS examples historically used `restless`, and an AI install pass may
  // pick something else again (e.g. `restlessSDK` to avoid shadowing the
  // ESM factory import `import restless from ...`). Match any identifier
  // before `.mask(` rather than a fixed name, so a perfectly-wired block
  // isn't misread as "credential missing" just because of the variable
  // name. The block is already scoped to the SDK wiring, so the only
  // `.mask(` here is the SDK's.
  const cred = blockText.match(/\b[A-Za-z_$][\w$]*\.mask\(([^)]*)\)/);
  if (cred) out.credentialExpr = cred[1].trim();

  // owner.id expression. Two shapes the user can have written:
  //
  //   1. The canonical one we emit:
  //        owner: { id: <expr>, ... }
  //
  //   2. A ternary / conditional / wrapped form that's still valid JS:
  //        owner: user ? { id: user.id, ... } : { id: 'anonymous' }
  //        owner: req.user && { id: req.user.workspaceId }
  //        owner: makeOwner(req)
  //
  // Strategy: find the `owner:` (or legacy `project:`) anchor, then scan
  // a bounded window of characters after it for the FIRST `id: <expr>`
  // property. The bound keeps us from picking up an unrelated `id:`
  // appearing later in the same return object (e.g. on a sibling
  // property). Word-boundary check on `id` requires it to begin a
  // property - preceded by `{`, `,`, `(`, or whitespace - so we don't
  // match `user.id` mid-expression as a property key.
  const ownerAnchor =
    blockText.match(/\bowner\s*:/) ||
    blockText.match(/\bproject\s*:/);
  if (ownerAnchor) {
    const window = blockText.slice(ownerAnchor.index, ownerAnchor.index + 600);
    const idInWindow = window.match(/(?:^|[\s{,(])id\s*:\s*([^,\n}]+)/);
    if (idInWindow) out.ownerIdExpr = idInWindow[1].trim().replace(/[,;]+$/, '');
  }

  // CONFIRM marker: a `// RESTLESS_OWNER_ID_CONFIRM: <reason>` line
  // sitting just above an `owner:` (or legacy `project:`) property.
  // Note we no longer require `{` after the property name - the owner
  // value can be a ternary, function call, etc.
  const confirm = blockText.match(
    /\/\/\s*RESTLESS_OWNER_ID_CONFIRM:\s*([^\n]+)\n\s*(?:owner|project)\s*:/,
  );
  if (confirm) out.ownerIdConfirmReason = confirm[1].trim();

  return out;
}

/**
 * Update (or insert) the `owner: { id: <expr> },` field inside the
 * SDK setup callback. Used by final-checks when the initial install
 * couldn't pick a stable identity and the user (or a focused AI retry)
 * supplied one.
 *
 * Three modes:
 *   1. owner.id is already present - swap just the expression, keeping
 *      the line shape and trailing comma.
 *   2. Legacy project.id is present (pre-rename source or AI mistake) -
 *      rewrite the whole property to `owner: { id: <expr> }` so the
 *      block ends up in the current shape.
 *   3. Neither is present - insert a new `owner: { id }` line right
 *      after `apiKey:`, matching whatever indent the apiKey line uses.
 *
 * Returns content unchanged when there's no managed block, the input
 * expression is empty, or we can't locate the apiKey anchor.
 */
export function setOwnerId(content, expr) {
  const found = parse(content);
  if (!found) return content;
  const newExpr = (expr || '').trim();
  if (!newExpr) return content;
  let block = found.block;

  // Preserve any trailing whitespace between the existing expression and
  // its closer (so we render `{ id: x }` not `{ id: x}`).
  const swapInPlace = (re) => block.replace(re, (_m, prefix, value, closer) => {
    const trimmed = value.replace(/\s+$/, '');
    const trailing = value.slice(trimmed.length);
    return `${prefix}${newExpr}${trailing}${closer}`;
  });

  const ownerRe = /(owner\s*:\s*\{[^{}]*?\bid\s*:\s*)([^,\n}]+)([},])/;
  const legacyRe = /(project\s*:\s*\{[^{}]*?\bid\s*:\s*)([^,\n}]+)([},])/;

  if (ownerRe.test(block)) {
    block = swapInPlace(ownerRe);
  } else if (legacyRe.test(block)) {
    // Rewrite the legacy property name AND the expression at once so a
    // re-run brings the block forward into the current shape.
    block = block.replace(legacyRe, (_m, prefix, value, closer) => {
      const newPrefix = prefix.replace(/\bproject(\s*:\s*\{[^{}]*?\bid\s*:\s*)$/, 'owner$1');
      const trimmed = value.replace(/\s+$/, '');
      const trailing = value.slice(trimmed.length);
      return `${newPrefix}${newExpr}${trailing}${closer}`;
    });
  } else if (/\b(?:owner|project)\s*:/.test(block)) {
    // An `owner:` (or legacy `project:`) exists but it's not the simple
    // `owner: { id: ... }` shape - probably a ternary, a function call,
    // or some other expression the user wrote on purpose. Inserting a
    // second `owner:` property here would produce duplicate keys and a
    // syntax error, so bail out. The repair flow surfaces this to the
    // user; they edit by hand.
    return content;
  } else {
    // Require `.mask(` on the line so we don't accidentally patch an
    // unrelated `apiKey:` property somewhere else in the file.
    const apiKeyLineRe = /^([ \t]*)apiKey\s*:.*\.mask\(.*$/m;
    const match = block.match(apiKeyLineRe);
    if (!match) return content;
    const indent = match[1];
    const apiKeyLine = match[0];
    const withComma = /,\s*$/.test(apiKeyLine) ? apiKeyLine : `${apiKeyLine},`;
    const ownerLine = `${indent}owner: { id: ${newExpr} },`;
    block = block.replace(apiKeyLineRe, `${withComma}\n${ownerLine}`);
  }

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}

/**
 * Detect a call to the OLD SDK API: `<binding>.setup(<framework instance>,
 * <callback>)` with two arguments. The new SDK takes a SINGLE argument
 * (the callback) and returns middleware that the caller passes to
 * `app.use(...)` or `fastify.register(...)`. A two-arg setup is the
 * pre-rename shape.
 *
 * Returns the character index of the first offending `.setup(` call, or
 * null when nothing matches. Tracks bracket / paren / brace depth so we
 * only count commas at the top level of the argument list (a callback
 * with `(req, res) => ...` has commas inside parens at depth ≥ 2 and is
 * still a single argument).
 *
 * Why match all `.setup(` calls and not just SDK bindings: by the time
 * this is called, the caller already knows the file is wired to the SDK
 * (parse() returned a hit). False-positives are tolerable because the
 * fix is "rewrite the call site" - if a non-SDK `.setup(x, y)` somehow
 * survives, the user notices on review.
 */
export function findOldApiSetup(content) {
  if (!content) return null;
  const re = /\.setup\s*\(/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    for (let i = start; i < content.length && depth > 0; i++) {
      const c = content[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 1) return m.index;
    }
  }
  return null;
}

/**
 * Strip the `// RESTLESS_OWNER_ID_CONFIRM: <reason>` line preceding the
 * `owner:` / `project:` line. Called when the user confirms the AI's
 * uncertain pick is fine. Idempotent: returns content unchanged when
 * the marker isn't present.
 */
export function stripOwnerIdConfirm(content) {
  if (!content) return content;
  // Match the marker comment and the following line break, but leave the
  // owner: line itself alone. Preserve the indentation of the owner line.
  const next = content.replace(
    /^[ \t]*\/\/\s*RESTLESS_OWNER_ID_CONFIRM:[^\n]*\n(?=[ \t]*(?:owner|project)\s*:\s*\{)/m,
    '',
  );
  return next;
}

/**
 * Rewrite ONLY the init-line argument (and the inline-key TODO comment)
 * so it matches `getSdkLineSpec(ctx)`. Preserves whatever the AI wrote
 * inside the setup callback - the credential extraction and owner.id
 * expressions are domain-specific and we shouldn't disturb them.
 *
 * Returns the content unchanged if no SDK reference is present, or if
 * the init line already matches the canonical form. Idempotent on re-runs.
 */
export function canonicalizeInitArg(content, ctx) {
  const found = parse(content);
  if (!found) return content;

  const wantArg = buildInitArg(ctx);
  const wantInline = ctx.keyDelivery === 'inline';
  let block = found.block;

  // 1. CJS form: `require('@restlessai/sdk')(<arg>)`. Rewrite the args.
  block = block.replace(
    /(require\(\s*['"]@restlessai\/sdk['"]\s*\)\s*\()([^)]*)(\))/,
    `$1${wantArg}$3`,
  );

  // 2. ESM form: a `restless(<arg>)` call (where `restless` was just
  //    imported from '@restlessai/sdk'). Look for the import name, then
  //    rewrite its zero-arity-or-otherwise call.
  const importMatch = block.match(/import\s+(\w+)\s+from\s+['"]@restlessai\/sdk['"]/);
  if (importMatch) {
    const name = importMatch[1];
    const callRe = new RegExp(`(\\b\\w+\\s*=\\s*${name}\\s*\\()([^)]*)(\\))`);
    block = block.replace(callRe, `$1${wantArg}$3`);
  }

  // 3. The TODO comment. Inline mode wants it, other modes don't.
  const todoLine = TODO_INLINE;
  const lines = block.split('\n');
  const filtered = lines.filter((l) => l.trim() !== todoLine);
  if (wantInline) {
    // Insert immediately before the init line.
    const initIdx = filtered.findIndex((l) =>
      /require\(['"]@restlessai\/sdk['"]\)/.test(l) ||
      (importMatch && new RegExp(`\\b\\w+\\s*=\\s*${importMatch[1]}\\(`).test(l)),
    );
    if (initIdx >= 0) {
      filtered.splice(initIdx, 0, todoLine);
    }
  }
  block = filtered.join('\n');

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}
