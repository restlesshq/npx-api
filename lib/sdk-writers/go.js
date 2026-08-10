import { getSdkLineSpec } from '../setup-context.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { findSdkReferences } from '../grep-sdk.js';

/**
 * Owns the SDK setup code in Go source files.
 *
 * The shape this has to recognize:
 *
 *     import restless "github.com/restlesshq/go"
 *
 *     client := restless.MustNew(
 *         os.Getenv("RESTLESS_KEY"),
 *         restless.WithBaseURL(...),
 *     )
 *
 *     client.Setup(func(r *restless.RequestInfo) restless.SetupResult {
 *         result := restless.SetupResult{
 *             APIKey: restless.Mask(r.Header("Authorization")),
 *         }
 *         if workspaceID != "" {
 *             result.Owner = &restless.Owner{ID: workspaceID, Enrich: loadWorkspace}
 *         }
 *         return result
 *     })
 *
 *     handler := client.Middleware()(mux)
 *
 * What differs from the other three dialects:
 *
 *   1. **Struct fields, not map keys.** `APIKey:` is exported-PascalCase and
 *      unquoted - a third spelling of the §15 vocabulary after camelCase and
 *      snake_case, which is exactly the variation CONTRACT.md §15 sanctions.
 *   2. **Owner is a POINTER to a struct literal**, `&restless.Owner{...}`, so
 *      every owner match has to allow the `&` and an optional package
 *      qualifier that depends on the user's import alias.
 *   3. **The import name is not the last path element.** The module is
 *      `github.com/restlesshq/go` but the package is `restless`, so an
 *      unaliased import still binds `restless`. Both forms appear in real
 *      code and both must resolve.
 *   4. **Mask has two forms**, `restless.Mask(...)` and `client.Mask(...)`.
 *      The README shows only the package one; the source has both.
 */

export const descriptor = Object.freeze({
  language: 'go',
  extensions: ['.go'],
  searchGlobs: ['*.go'],
  packageSpecifier: 'github.com/restlesshq/go',
  importName: 'restless',
  manifests: ['go.mod'],
  installCommand: 'go get github.com/restlesshq/go',
  // The module path is distinctive enough to grep for directly. Escaped
  // because it contains dots that would otherwise match anything.
  searchPattern: 'github\\.com/restlesshq/go',
  commentPrefix: '//',
  // §15 concepts as exported Go struct fields.
  fields: Object.freeze({
    apiKey: 'APIKey',
    owner: 'Owner',
    ownerId: 'ID',
    enrich: 'Enrich',
  }),
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'Mask', styles: ['method', 'package'] }),
});

const COMMENT = escapeRegex(descriptor.commentPrefix);
const CONFIRM = escapeRegex(OWNER_ID_CONFIRM_MARKER);
const TODO_INLINE = `${descriptor.commentPrefix} ${INLINE_KEY_TODO_TEXT}`;

const F = descriptor.fields;
const MASK = escapeRegex(descriptor.maskCall.name);

/** A struct field key: `APIKey:`, unquoted and PascalCase. */
function key(name) {
  return `\\b${escapeRegex(name)}\\s*:`;
}

/**
 * Where the owner attaches, as one alternation:
 *
 *   Owner: &restless.Owner{...}         inside the struct literal
 *   result.Owner = &restless.Owner{...} assigned after, usually conditionally
 *
 * The second is what the real pet-store fixture writes, and it is the Go
 * equivalent of the conditional forms Python and Ruby needed: a struct
 * literal cannot omit a field based on a runtime check.
 */
function ownerAnchor() {
  const n = escapeRegex(F.owner);
  return `\\b${n}\\s*(?::|=)\\s*&\\s*(?:[A-Za-z_]\\w*\\.)?${n}\\s*`;
}

/**
 * Looser: the owner field is set to SOMETHING. Used only to decide whether
 * to bail, which is a different question from whether we can patch it - an
 * owner built by a helper (`result.Owner = ownerFor(r)`) matches this and
 * not `ownerAnchor`, and inserting a second one would not compile.
 */
function ownerPresent() {
  return `\\b${escapeRegex(F.owner)}\\s*(?::|=)`;
}

// `restless "github.com/restlesshq/go"`, `rl "github.com/..."`, or unaliased
// (which still binds `restless`, because the package name is not the last
// path element).
const IMPORT_RE = /(?:^|\s)(?:([A-Za-z_]\w*)\s+)?["']github\.com\/restlesshq\/go["']/m;

/** Every local name the SDK package could be bound to in this file. */
function packageBindings(content) {
  const bindings = new Set();
  const re = new RegExp(IMPORT_RE.source, 'gm');
  let m;
  while ((m = re.exec(content)) !== null) {
    // `_` is a blank import (side effects only) and binds nothing usable.
    if (m[1] && m[1] !== '_') bindings.add(m[1]);
    else bindings.add(descriptor.importName);
  }
  return [...bindings];
}

const CONSTRUCTORS = ['MustNew', 'New'];

export function hasSdkReference(content) {
  if (!content) return false;
  return IMPORT_RE.test(content);
}

/**
 * Is a client actually constructed here? Requires an import AND a call
 * through the binding it created, so a file importing the package only for
 * its types (`*restless.RequestInfo` in a helper signature) is not mistaken
 * for the wiring.
 */
export function hasInit(content) {
  if (!content) return false;
  return packageBindings(content).some((b) =>
    CONSTRUCTORS.some((c) => new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`).test(content)));
}

export function parse(content) {
  if (!content || !hasSdkReference(content)) return null;
  return { block: content, startIdx: 0, endIdx: content.length };
}

export function candidateWiringFiles(installDir) {
  return findSdkReferences(installDir, {
    pattern: descriptor.searchPattern,
    globs: descriptor.searchGlobs,
  });
}

function balancedArg(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(start, i);
  }
  return null;
}

function findConstructorCall(content) {
  for (const b of packageBindings(content)) {
    for (const c of CONSTRUCTORS) {
      const m = content.match(new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`));
      if (!m) continue;
      const argsStart = m.index + m[0].length;
      const args = balancedArg(content, argsStart);
      if (args === null) continue;
      return { index: m.index, argsStart, args };
    }
  }
  return null;
}

/**
 * The first argument, which is the key. Go's functional options
 * (`WithBaseURL(...)`) trail it, so the whole argument list is not the key.
 */
function firstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

export function readBlockFields(blockText) {
  const out = {
    initArgForm: null,
    initArgValue: null,
    credentialExpr: null,
    ownerIdExpr: null,
    ownerIdConfirmReason: null,
  };
  if (!blockText) return out;

  const call = findConstructorCall(blockText);
  if (call) {
    const argRaw = firstArg(call.args).trim();
    if (argRaw === '' || argRaw === '""') {
      out.initArgForm = 'no-arg';
    } else if (/^["`](?:rstlss_|rdme_)/.test(argRaw)) {
      out.initArgForm = 'literal';
      out.initArgValue = argRaw.slice(1, -1);
    } else {
      // `os.Getenv("X")`, and the `envOr("X", ...)` helper the fixture uses.
      const env = argRaw.match(/(?:os\.Getenv|envOr|LookupEnv)\s*\(\s*["`]([A-Za-z_]\w*)["`]/);
      if (env) {
        out.initArgForm = 'env-ref';
        out.initArgValue = env[1];
      }
    }
  }

  const cred = blockText.match(new RegExp(`\\b(?:[A-Za-z_]\\w*\\.)?${MASK}\\(`));
  if (cred) {
    const arg = balancedArg(blockText, cred.index + cred[0].length);
    if (arg !== null) out.credentialExpr = arg.trim();
  }

  const anchor = blockText.match(new RegExp(ownerAnchor()));
  if (anchor) {
    const window = blockText.slice(anchor.index, anchor.index + 600);
    const idInWindow = window.match(new RegExp(`${key(F.ownerId)}\\s*([^,\\n}]+)`));
    if (idInWindow) out.ownerIdExpr = idInWindow[1].trim().replace(/[,;]+$/, '');
  }

  const confirm = blockText.match(
    new RegExp(`${COMMENT}\\s*${CONFIRM}:\\s*([^\\n]+)\\n\\s*(?:[A-Za-z_]\\w*\\.)?${ownerAnchor()}`),
  );
  if (confirm) out.ownerIdConfirmReason = confirm[1].trim();

  return out;
}

export function setOwnerId(content, expr) {
  const found = parse(content);
  if (!found) return content;
  const newExpr = (expr || '').trim();
  if (!newExpr) return content;
  let block = found.block;

  const ownerRe = new RegExp(
    `(${ownerAnchor()}\\{[^{}]*?${key(F.ownerId)}\\s*)([^,\\n}]+)([},])`,
  );

  if (ownerRe.test(block)) {
    block = block.replace(ownerRe, (_m, prefix, value, closer) => {
      const trimmed = value.replace(/\s+$/, '');
      const trailing = value.slice(trimmed.length);
      return `${prefix}${newExpr}${trailing}${closer}`;
    });
  } else if (new RegExp(ownerPresent()).test(block)) {
    // An owner exists but not as a plain struct literal - a helper call the
    // user wrote. Adding a second field would not even compile.
    return content;
  } else {
    const apiKeyLineRe = new RegExp(
      `^([ \\t]*)${key(F.apiKey)}.*\\b(?:[A-Za-z_]\\w*\\.)?${MASK}\\(.*$`,
      'm',
    );
    const match = block.match(apiKeyLineRe);
    if (!match) return content;
    const indent = match[1];
    const apiKeyLine = match[0];
    const withComma = /,\s*$/.test(apiKeyLine) ? apiKeyLine : `${apiKeyLine},`;
    // Qualify `Owner` with whatever the file calls the package, so the
    // inserted literal compiles.
    const pkg = packageBindings(block)[0] || descriptor.importName;
    const ownerLine = `${indent}${F.owner}: &${pkg}.${F.owner}{${F.ownerId}: ${newExpr}},`;
    block = block.replace(apiKeyLineRe, `${withComma}\n${ownerLine}`);
  }

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}

export function stripOwnerIdConfirm(content) {
  if (!content) return content;
  return content.replace(
    new RegExp(
      `^[ \\t]*${COMMENT}\\s*${CONFIRM}:[^\\n]*\\n(?=[ \\t]*(?:[A-Za-z_]\\w*\\.)?${ownerAnchor()}\\{)`,
      'm',
    ),
    '',
  );
}

/**
 * Render the constructor argument.
 *
 * `os.Getenv` rather than a map index: it returns "" for a missing key
 * rather than panicking, so the idiomatic form is also the safe one, and the
 * SDK's CONFIG-002 path degrades to "captured, not uploaded".
 */
function buildInitArg(ctx) {
  const spec = getSdkLineSpec(ctx);
  if (spec.form === 'literal') return JSON.stringify(spec.value);
  // Everything else becomes an explicit os.Getenv, including the "no env
  // loader detected" case that the other languages render as a no-arg call.
  //
  // Go has no `.env` convention at all, so the environment variable is not
  // one way of supplying the key, it is THE way. `MustNew("")` does work -
  // CONFIG-001 falls back to RESTLESS_KEY on an empty string - but it reads
  // as "no key" and only a reader who knows the SDK's fallback rules can
  // tell it apart from a mistake. The explicit form says what it does.
  return `os.Getenv(${JSON.stringify(spec.value || 'RESTLESS_KEY')})`;
}

export function canonicalizeInitArg(content, ctx) {
  const found = parse(content);
  if (!found) return content;

  const call = findConstructorCall(found.block);
  if (!call) return content;

  const wantArg = buildInitArg(ctx);
  const first = firstArg(call.args);
  const rest = call.args.slice(first.length);

  let block =
    found.block.slice(0, call.argsStart) +
    `${wantArg}${rest}` +
    found.block.slice(call.argsStart + call.args.length);

  const lines = block.split('\n').filter((l) => l.trim() !== TODO_INLINE);
  if (ctx.keyDelivery === 'inline') {
    const bindings = packageBindings(block);
    const initIdx = lines.findIndex((l) =>
      bindings.some((b) => CONSTRUCTORS.some((c) =>
        new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`).test(l))));
    if (initIdx >= 0) {
      const indent = lines[initIdx].match(/^[ \t]*/)[0];
      lines.splice(initIdx, 0, `${indent}${TODO_INLINE}`);
    }
  }
  block = lines.join('\n');

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}
