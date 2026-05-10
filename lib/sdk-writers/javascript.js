import { getSdkLineSpec } from '../setup-context.js';

/**
 * Owns the SDK setup block in JavaScript / TypeScript source files.
 *
 * Past bug class: AI passes editing the same line CLI logic just decided
 * on. Fix: the SDK init line lives inside a sentinel-bracketed block
 * that the CLI parses, regenerates, and writes. The AI is invoked to
 * decide WHERE the block goes and what goes INSIDE the setup callback
 * (credential extraction, project.id), but the init line itself is
 * always produced by `generate()` from the SetupContext.
 *
 * This file is the JS/TS dialect. Other languages (Python, Ruby, etc.)
 * get their own sibling file with the same exported shape.
 */

export const BLOCK_START = '// >>> restless-sdk-start (managed by `npx api setup`)';
export const BLOCK_END = '// >>> restless-sdk-end';

const TODO_INLINE = '// TODO: move this out of the codebase before committing';

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
 * minimum `apiKey: sdk.mask(<credential>)`, and `project: { id: ... }`
 * if the AI surfaced a stable identity expression.
 */
function buildCallbackBody({ credentialExpr, projectIdExpr }) {
  const lines = ['{'];
  lines.push(`  apiKey: sdk.mask(${credentialExpr || 'undefined'}),`);
  if (projectIdExpr) {
    lines.push(`  project: { id: ${projectIdExpr} },`);
  }
  lines.push('}');
  return lines.join('\n  ');
}

/**
 * Produce the full sentinel-bracketed SDK block as a single string.
 * Caller is responsible for inserting it at the right place in the
 * source file (after imports, before route definitions). The block
 * always ends with a newline so callers can concatenate cleanly.
 *
 * `plan` is what the AI returned: { module, framework, appVar,
 * credentialExpr, projectIdExpr }. `ctx` provides the SetupContext so
 * the init line follows `sdkLineSpec`.
 */
export function generate(ctx, plan) {
  const moduleSystem = plan.module || 'cjs';
  const inlineWarning = ctx.keyDelivery === 'inline' ? [TODO_INLINE] : [];
  const initLines = buildInitLines(ctx, moduleSystem);
  const callbackBody = buildCallbackBody(plan);
  const registration = buildRegistration(plan, callbackBody);

  const out = [
    BLOCK_START,
    ...inlineWarning,
    ...initLines,
    '',
    ...registration,
    BLOCK_END,
    '',
  ];
  return out.join('\n');
}

/**
 * Locate an existing sentinel-bracketed block in `content`. Returns the
 * inclusive char indices and the block text, or null if no block is
 * present. Use this to recognize a block we previously wrote so we can
 * replace it on re-runs.
 */
export function parse(content) {
  if (!content) return null;
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx === -1) return null;
  const endMarkerIdx = content.indexOf(BLOCK_END, startIdx);
  if (endMarkerIdx === -1) return null;
  const endIdx = endMarkerIdx + BLOCK_END.length;
  return {
    block: content.slice(startIdx, endIdx),
    startIdx,
    endIdx,
  };
}

/**
 * Best-effort extraction of fields from an existing block: which form
 * the init line is using, the credential expression, the project.id
 * expression. Used by finalChecks to read what's actually wired in
 * without an AI pass.
 */
export function readBlockFields(blockText) {
  const out = {
    initArgForm: null, // 'literal' | 'env-ref' | 'no-arg'
    initArgValue: null,
    credentialExpr: null,
    projectIdExpr: null,
  };
  if (!blockText) return out;

  // Init line: `require('@restlessai/sdk')(<arg>)` or `restless(<arg>)`.
  const cjs = blockText.match(/require\(['"]@restlessai\/sdk['"]\)\(([^)]*)\)/);
  const esm = blockText.match(/^\s*(?:const|let|var)\s+\w+\s*=\s*\w+\(([^)]*)\)\s*;?\s*$/m);
  const argRaw = (cjs?.[1] ?? esm?.[1] ?? '').trim();
  if (argRaw === '') {
    out.initArgForm = 'no-arg';
  } else if (/^['"]rdme_/.test(argRaw)) {
    out.initArgForm = 'literal';
    out.initArgValue = argRaw.slice(1, -1);
  } else if (/process\.env\./.test(argRaw)) {
    out.initArgForm = 'env-ref';
    out.initArgValue = argRaw.replace(/^process\.env\./, '');
  }

  // Credential expression: inside `sdk.mask(<expr>)` (or restless.mask).
  const cred = blockText.match(/(?:sdk|restless)\.mask\(([^)]*)\)/);
  if (cred) out.credentialExpr = cred[1].trim();

  // project.id expression: `project: { id: <expr> }`.
  const pid = blockText.match(/project\s*:\s*\{[^{}]*?\bid\s*:\s*([^,\n}]+)/);
  if (pid) out.projectIdExpr = pid[1].trim().replace(/[,;]+$/, '');

  return out;
}

/**
 * Replace an existing block in `content` with a freshly generated one
 * derived from `ctx + plan`. Returns the new content. If no block
 * exists, returns `content` unchanged - callers handle the
 * first-install case via `insert()`.
 */
export function replaceInContent(content, ctx, plan) {
  const found = parse(content);
  if (!found) return content;
  const fresh = generate(ctx, plan).trimEnd();
  return content.slice(0, found.startIdx) + fresh + content.slice(found.endIdx);
}

/**
 * Walk the sentinel block and rewrite ONLY the init-line argument (and
 * the inline-key TODO comment) so it matches `getSdkLineSpec(ctx)`.
 * Preserves whatever the AI wrote inside the setup callback - the
 * credential extraction and project.id expressions are domain-specific
 * and we shouldn't disturb them.
 *
 * Returns the new content unchanged if no block is present, or if the
 * init line already matches the canonical form. Idempotent on re-runs.
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
    if (initIdx > 0) {
      filtered.splice(initIdx, 0, todoLine);
    }
  }
  block = filtered.join('\n');

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}
