/**
 * The patch/read algorithms every writer shares, driven by a per-language
 * dialect.
 *
 * Python, Ruby and Go each shipped their own copy of these five functions. The
 * copies were not similar, they were the same: 172-186 identical non-blank
 * lines between any two of the three writers, with `balancedArg` and `parse`
 * byte-identical in all three. What actually differed was a handful of regex
 * fragments - how a key is spelled, how a string literal is quoted, how the
 * owner attaches - which is exactly what `dialect` carries.
 *
 * This matters for correctness, not tidiness. Four of the five bugs the
 * fixture testing caught were one rule re-derived per language and gotten
 * wrong in one of them: the conditional-owner form, the trailing-comment
 * anchor, the shell quoting, the optional-method call. With one engine each of
 * those is one fix rather than four, and a language cannot be quietly missing
 * the fix.
 *
 * ## What a dialect owes the engine
 *
 * Regex FRAGMENTS (strings, spliced into larger patterns), not RegExp objects:
 *
 *   fieldKey(name)   a setup-result key INCLUDING its separator, so the engine
 *                    can put `\s*(value)` straight after it. Python's is
 *                    `["']id["']\s*:`, Ruby's covers both `id:` and `:id =>`,
 *                    Go's is `\bID\s*:`.
 *   ownerAnchor()    where the owner value attaches, both in-literal and
 *                    assigned-after. Every language needs the second form:
 *                    a literal cannot conditionally omit a key, so real code
 *                    writes `result["owner"] = {...}`.
 *   ownerPresent()   looser: the owner is set to SOMETHING. Defaults to
 *                    ownerAnchor. Go overrides it, because an owner built by a
 *                    helper matches this and not the anchor, and inserting a
 *                    second one would not compile.
 *   receiver         optional qualifier before a call, e.g. `client.` in
 *                    `client.mask(...)`. Ruby's admits `::`.
 *   quotes           character class for a string literal's delimiter. Go
 *                    includes the backtick.
 *   confirmPrefix    what may sit between the confirm comment and the owner
 *                    anchor on the next line (`result` in Python and Ruby).
 *   apiKeyLinePrefix what may precede the api_key key on its line. Ruby uses
 *                    `.*?` because it routinely opens the hash on the same
 *                    line (`result = { api_key: ... }`).
 *
 * Functions:
 *
 *   findConstructorCall(content) -> { index, argsStart, args } | null
 *   initLine(line)               -> is this the constructor's line?
 *   renderOwnerLine(indent, expr, block)
 *                                -> the inserted owner line, verbatim. `block`
 *                                   is the file being patched, which Go needs
 *                                   to read its own import alias out of.
 *   buildInitArg(ctx)            -> the constructor argument as source text
 *   envRef(argText)              -> env var name read by this argument, or null
 */

import { escapeRegex } from './contract.js';
import { findSdkReferences } from '../grep-sdk.js';
import { getSdkLineSpec } from '../sdk-line-spec.js';

/**
 * The default "which files might hold the wiring": grep the tree for this
 * language's search pattern.
 *
 * Ruby overrides it, and Ruby is the reason the seam exists - a Rack app mounts
 * in `config.ru` or `config/application.rb`, neither of which necessarily
 * mentions the gem, so the grep alone misses the file the CLI has to patch.
 */
export function grepWiringFiles(descriptor) {
  return (installDir) => findSdkReferences(installDir, {
    pattern: descriptor.searchPattern,
    globs: descriptor.searchGlobs,
  });
}

/**
 * The inline-literal branch of `buildInitArg`, which is the same everywhere:
 * a JSON-quoted string is a valid string literal in all four languages.
 * Returns null when the key is not being inlined, so the caller renders its own
 * env-var form.
 */
export function literalInitArg(ctx) {
  const spec = getSdkLineSpec(ctx);
  return spec.form === 'literal' ? JSON.stringify(spec.value) : null;
}

/**
 * Extract a balanced-paren argument list starting just after an opening paren.
 * Returns null when the parens never close, so a truncated file is left alone
 * rather than half-patched.
 */
export function balancedArg(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(start, i);
  }
  return null;
}

/**
 * The FIRST argument of a call, which is always the key.
 *
 * Every language takes options after it - Go's functional options, Ruby's
 * keyword args, Python's kwargs - so the whole argument list is not the key,
 * and replacing the whole list would silently drop a `base_url` the user
 * configured. Splitting on the first top-level comma is what preserves them.
 */
export function firstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** The empty result `readBlockFields` returns when it can read nothing. */
function emptyFields() {
  return {
    initArgForm: null,
    initArgValue: null,
    credentialExpr: null,
    ownerIdExpr: null,
    ownerIdConfirmReason: null,
  };
}

/**
 * How far past the owner anchor to look for its `id`. Bounded so an unrelated
 * `id` later in the setup result is not mistaken for the owner's.
 */
const OWNER_WINDOW = 600;

/**
 * Build the five shared methods for one dialect.
 *
 * Returned rather than mixed in, so a writer stays a plain module that
 * re-exports what it wants and overrides anything it needs to.
 */
export function createEngine(dialect) {
  const {
    descriptor,
    hasSdkReference,
    findConstructorCall,
    initLine,
    fieldKey,
    ownerAnchor,
    ownerPresent = ownerAnchor,
    renderOwnerLine,
    buildInitArg,
    envRef,
    receiver = '(?:[A-Za-z_]\\w*\\.)?',
    quotes = `["']`,
    confirmPrefix = '',
    apiKeyLinePrefix = '',
  } = dialect;

  const F = descriptor.fields;
  const COMMENT = escapeRegex(descriptor.commentPrefix);
  const MASK = escapeRegex(descriptor.maskCall.name);
  const TODO_INLINE = `${descriptor.commentPrefix} ${dialect.inlineKeyTodoText}`;
  const CONFIRM = escapeRegex(dialect.confirmMarker);

  /**
   * Loose locator: returns the whole file as the "block" so the patch
   * functions can operate on it by regex. Only the JavaScript writer has a
   * real managed block to find, and it keeps its own `parse`.
   */
  function parse(content) {
    if (!content || !hasSdkReference(content)) return null;
    return { block: content, startIdx: 0, endIdx: content.length };
  }

  /** Splice a patched block back into the file, or return the file unchanged. */
  function splice(content, found, block) {
    if (block === found.block) return content;
    return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
  }

  function readBlockFields(blockText) {
    const out = emptyFields();
    if (!blockText) return out;

    const call = findConstructorCall(blockText);
    if (call) {
      const argRaw = firstArg(call.args).trim();
      // An empty argument and an empty string literal both mean "no key here";
      // every SDK falls back to its own RESTLESS_KEY lookup on both.
      if (argRaw === '' || argRaw === '""' || argRaw === "''") {
        out.initArgForm = 'no-arg';
      } else if (new RegExp(`^${quotes}(?:rstlss_|rdme_)`).test(argRaw)) {
        out.initArgForm = 'literal';
        out.initArgValue = argRaw.slice(1, -1);
      } else {
        const name = envRef(argRaw);
        if (name) {
          out.initArgForm = 'env-ref';
          out.initArgValue = name;
        }
      }
    }

    // The argument to a mask call, paren-balanced rather than `[^)]*` because
    // real credential expressions nest calls:
    // `request.headers.get("authorization")`.
    const cred = blockText.match(new RegExp(`\\b${receiver}${MASK}\\(`));
    if (cred) {
      const arg = balancedArg(blockText, cred.index + cred[0].length);
      if (arg !== null) out.credentialExpr = arg.trim();
    }

    // Anchor on the owner, then take the first id inside a bounded window.
    const anchor = blockText.match(new RegExp(ownerAnchor()));
    if (anchor) {
      const window = blockText.slice(anchor.index, anchor.index + OWNER_WINDOW);
      const idInWindow = window.match(new RegExp(`${fieldKey(F.ownerId)}\\s*([^,\\n}]+)`));
      if (idInWindow) out.ownerIdExpr = idInWindow[1].trim().replace(/[,;]+$/, '');
    }

    const confirm = blockText.match(
      new RegExp(`${COMMENT}\\s*${CONFIRM}:\\s*([^\\n]+)\\n\\s*${confirmPrefix}\\s*${ownerAnchor()}`),
    );
    if (confirm) out.ownerIdConfirmReason = confirm[1].trim();

    return out;
  }

  /**
   * Update (or insert) the owner id inside the setup result.
   *
   * Three modes: swap an existing id in place, bail out when `owner` is present
   * but not as a plain literal (a helper call or ternary the user wrote
   * deliberately), or insert a fresh owner entry after the api_key line.
   *
   * Known limit: the swap pattern uses `[^{}]` between the owner key and the
   * id, so it does not match when `enrich` (whose value can be a block) is
   * written BEFORE `id`. Every guide emits `id` first. When it does not match,
   * the insert path is skipped too and the file is returned untouched for the
   * user to edit rather than corrupted.
   */
  function setOwnerId(content, expr) {
    const found = parse(content);
    if (!found) return content;
    const newExpr = (expr || '').trim();
    if (!newExpr) return content;
    let block = found.block;

    const ownerRe = new RegExp(
      `(${ownerAnchor()}\\{[^{}]*?${fieldKey(F.ownerId)}\\s*)([^,\\n}]+)([},])`,
    );

    if (ownerRe.test(block)) {
      block = block.replace(ownerRe, (_m, prefix, value, closer) => {
        const trimmed = value.replace(/\s+$/, '');
        const trailing = value.slice(trimmed.length);
        return `${prefix}${newExpr}${trailing}${closer}`;
      });
    } else if (new RegExp(ownerPresent()).test(block)) {
      // An owner exists but not as a plain literal. Adding a second one would
      // shadow it (or not compile); leave it for the repair flow.
      return content;
    } else {
      // Require a mask call on the line so an unrelated api_key elsewhere in
      // the file is not what gets patched.
      const apiKeyLineRe = new RegExp(
        `^([ \\t]*)${apiKeyLinePrefix}${fieldKey(F.apiKey)}.*\\b${receiver}${MASK}\\(.*$`,
        'm',
      );
      const match = block.match(apiKeyLineRe);
      if (!match) return content;
      const apiKeyLine = match[0];
      const withComma = /,\s*$/.test(apiKeyLine) ? apiKeyLine : `${apiKeyLine},`;
      // `block` is passed because Go has to qualify the inserted struct literal
      // with whatever THIS file aliased the package to, which it can only learn
      // by reading the file's imports.
      const ownerLine = renderOwnerLine(match[1], newExpr, block);
      block = block.replace(apiKeyLineRe, `${withComma}\n${ownerLine}`);
    }

    return splice(content, found, block);
  }

  /** Drop the `RESTLESS_OWNER_ID_CONFIRM: ...` comment above the owner entry. */
  function stripOwnerIdConfirm(content) {
    if (!content) return content;
    return content.replace(
      new RegExp(
        `^[ \\t]*${COMMENT}\\s*${CONFIRM}:[^\\n]*\\n(?=[ \\t]*${confirmPrefix}\\s*${ownerAnchor()}\\{)`,
        'm',
      ),
      '',
    );
  }

  /**
   * Take ownership of the constructor argument (and the inline-key TODO
   * comment), leaving everything the AI wrote inside the setup callback alone.
   * Idempotent.
   *
   * Only the FIRST argument is replaced, so keyword options the user
   * configured survive. Python used to replace the whole argument list here,
   * which silently dropped them.
   */
  function canonicalizeInitArg(content, ctx) {
    const found = parse(content);
    if (!found) return content;

    const call = findConstructorCall(found.block);
    if (!call) return content;

    const wantArg = buildInitArg(ctx);
    const rest = call.args.slice(firstArg(call.args).length);
    // Dropping the argument entirely has to drop its comma too, or the call is
    // left starting with one.
    const nextArgs = wantArg === '' && rest.trim().startsWith(',')
      ? rest.replace(/^\s*,\s*/, '')
      : `${wantArg}${rest}`;

    let block =
      found.block.slice(0, call.argsStart) +
      nextArgs +
      found.block.slice(call.argsStart + call.args.length);

    // The TODO comment tracks inline mode: present for it, absent otherwise.
    const lines = block.split('\n').filter((l) => l.trim() !== TODO_INLINE);
    if (ctx.keyDelivery === 'inline') {
      const initIdx = lines.findIndex((l) => initLine(l, block));
      if (initIdx >= 0) {
        const indent = lines[initIdx].match(/^[ \t]*/)[0];
        lines.splice(initIdx, 0, `${indent}${TODO_INLINE}`);
      }
    }
    block = lines.join('\n');

    return splice(content, found, block);
  }

  return { parse, readBlockFields, setOwnerId, stripOwnerIdConfirm, canonicalizeInitArg };
}
