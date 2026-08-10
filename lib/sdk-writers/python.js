import { getSdkLineSpec } from '../setup-context.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { findSdkReferences } from '../grep-sdk.js';

/**
 * Owns the SDK setup code in Python source files.
 *
 * The Python dialect of `javascript.js`. Same seven-method surface, written
 * against the real `restlesshq/python` API rather than a transliteration of
 * the Node one, because CONTRACT.md §14 makes public API ergonomics
 * explicitly per-language. What IS shared is the §15 field vocabulary, and
 * that comes through `descriptor.fields` below.
 *
 * The shape this has to recognize:
 *
 *     import restless
 *
 *     client = restless.Restless(os.environ["RESTLESS_KEY"])
 *
 *     @client.setup
 *     def _(request):
 *         return {
 *             "api_key": client.mask(request.headers.get("authorization")),
 *             "owner": {
 *                 "id": workspace_id_for(request),
 *                 "enrich": lambda owner_id: {"label": lookup(owner_id)},
 *             },
 *         }
 *
 *     app.wsgi_app = client.wsgi(app.wsgi_app)   # Flask / Django / WSGI
 *     app = client.asgi(app)                      # FastAPI / Starlette / ASGI
 *
 * Four things differ structurally from JavaScript and drive nearly every
 * regex here:
 *
 *   1. Setup-result keys are QUOTED dict keys (`"api_key":`), not bare
 *      identifiers. Either quote style is legal, so every key match accepts
 *      both.
 *   2. Comments are `#`.
 *   3. `mask` is reachable three ways - `client.mask(...)` (staticmethod via
 *      instance), `restless.mask(...)` (module export), and a bare `mask(...)`
 *      after `from restless import mask`.
 *   4. There are two constructors: the `Restless` class and a functional
 *      `restless()` mirroring the Node SDK. Both are public, so both count as
 *      a real wiring.
 *
 * Like the JS writer, this patches by regex rather than parsing, so it can
 * only touch lines it recognizes. Anything it does not recognize is left
 * alone and surfaced to the user instead of being rewritten badly.
 */

export const descriptor = Object.freeze({
  language: 'python',
  extensions: ['.py'],
  searchGlobs: ['*.py'],
  // What `pip install` names, which is NOT what source imports.
  packageSpecifier: 'restless-sdk',
  importName: 'restless',
  // pyproject.toml first: when a project has both, it is the authoritative
  // one and requirements.txt is often a generated lockfile.
  manifests: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg'],
  installCommand: 'pip install restless-sdk',
  // POSIX ERE for `candidateWiringFiles`. `[[:space:]]` rather than `\s`
  // because BSD grep on macOS does not guarantee the shorthand. Anchoring on
  // the import keyword is what keeps `restless_var` and prose mentioning
  // "restless" out of the candidate list.
  searchPattern: '(from|import)[[:space:]]+restless',
  commentPrefix: '#',
  // §15 concepts, spelled the Python way (snake_case). Renaming the concept
  // is not allowed; adapting the casing is exactly what §15 permits.
  fields: Object.freeze({
    apiKey: 'api_key',
    owner: 'owner',
    ownerId: 'id',
    enrich: 'enrich',
  }),
  // No pre-rename spelling to accept: this SDK shipped after the rename.
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'mask', styles: ['method', 'module'] }),
});

const COMMENT = escapeRegex(descriptor.commentPrefix);
const CONFIRM = escapeRegex(OWNER_ID_CONFIRM_MARKER);
const TODO_INLINE = `${descriptor.commentPrefix} ${INLINE_KEY_TODO_TEXT}`;

const F = descriptor.fields;
const MASK = escapeRegex(descriptor.maskCall.name);

/** A quoted dict key, either quote style: `"api_key"` or `'api_key'`. */
function key(name) {
  return `["']${escapeRegex(name)}["']`;
}

/**
 * The import forms, as three separate patterns rather than one alternation,
 * because they bind different things.
 *
 * Every one tolerates a trailing comment. The real pet-store fixtures all
 * write `import restless  # noqa: E402` (the import sits below a sys.path
 * tweak, so linters need silencing), and Python code in general is full of
 * `# type: ignore` and `# pylint: disable`. An end-of-line anchor that did
 * not allow for them matched none of the fixtures.
 */
const IMPORT_PATTERNS = [
  // `import restless` / `import restless as rl` -> constructors are attributes.
  { kind: 'module', source: String.raw`^[ \t]*import[ \t]+restless(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?:#.*)?$` },
  // `from restless import (\n  Restless,\n  mask,\n)` -> parenthesized, may span lines.
  { kind: 'names', source: String.raw`^[ \t]*from[ \t]+restless[ \t]+import[ \t]*\(([\s\S]*?)\)` },
  // `from restless import Restless, restless as make`
  { kind: 'names', source: String.raw`^[ \t]*from[ \t]+restless[ \t]+import[ \t]+([^#(\n]+?)[ \t]*(?:#.*)?$` },
];

// The two public constructors. `Restless` is the class, `restless` the
// functional form the SDK ships to mirror Node's `restless(key)`.
const CONSTRUCTORS = ['Restless', 'restless'];

/**
 * Resolve every local name that could be a Restless constructor in this file,
 * across all the import forms Python allows.
 */
function constructorBindings(content) {
  const bindings = [];
  for (const { kind, source } of IMPORT_PATTERNS) {
    const re = new RegExp(source, 'gm');
    let m;
    while ((m = re.exec(content)) !== null) {
      if (kind === 'module') {
        const mod = m[1] || descriptor.importName;
        for (const ctor of CONSTRUCTORS) bindings.push(`${escapeRegex(mod)}\\.${ctor}`);
        continue;
      }
      for (const spec of (m[1] || '').split(',')) {
        const cleaned = spec.trim();
        if (!cleaned) continue;
        const [name, alias] = cleaned.split(/\s+as\s+/).map((s) => s.trim());
        if (CONSTRUCTORS.includes(name)) bindings.push(escapeRegex(alias || name));
      }
    }
  }
  return [...new Set(bindings)];
}

/** Does this file import the SDK at all? The loose check. */
export function hasSdkReference(content) {
  if (!content) return false;
  return IMPORT_PATTERNS.some(({ source }) => new RegExp(source, 'm').test(content));
}

/**
 * Is the SDK actually constructed here? The strict check, and the one that
 * decides whether the AI wiring pass gets skipped on a re-run.
 *
 * Requires an import AND a call through a binding that import created, so a
 * file that imports `mask` for a unit test does not read as wired.
 */
export function hasInit(content) {
  if (!content) return false;
  const bindings = constructorBindings(content);
  return bindings.some((b) => new RegExp(`${b}\\s*\\(`).test(content));
}

/**
 * Loose locator, mirroring the JS writer: returns the whole file as the
 * "block" so the patch functions can operate on it by regex.
 */
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

/** Extract a balanced-paren argument starting just after an opening paren. */
function balancedArg(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(start, i);
  }
  return null;
}

/** Locate the constructor call and return `{ index, argsStart, args }`. */
function findConstructorCall(content) {
  for (const b of constructorBindings(content)) {
    const m = content.match(new RegExp(`${b}\\s*\\(`));
    if (!m) continue;
    const argsStart = m.index + m[0].length;
    const args = balancedArg(content, argsStart);
    if (args === null) continue;
    return { index: m.index, argsStart, args, matched: m[0] };
  }
  return null;
}

/**
 * Read what is actually wired in, without an AI pass. Same contract as the
 * JS writer's version, so final-checks and verify-owner-id need no per
 * language branching.
 */
export function readBlockFields(blockText) {
  const out = {
    initArgForm: null,
    initArgValue: null,
    credentialExpr: null,
    ownerIdExpr: null,
    ownerIdConfirmReason: null,
  };
  if (!blockText) return out;

  // Init argument: `Restless()`, `Restless("rstlss_...")`, or one of the
  // environment forms (`os.environ["X"]`, `os.environ.get("X")`,
  // `os.getenv("X")`).
  const call = findConstructorCall(blockText);
  if (call) {
    const argRaw = call.args.trim();
    if (argRaw === '') {
      out.initArgForm = 'no-arg';
    } else if (/^["'](?:rstlss_|rdme_)/.test(argRaw)) {
      out.initArgForm = 'literal';
      out.initArgValue = argRaw.slice(1, -1);
    } else {
      const env = argRaw.match(
        /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Za-z_]\w*)["']|os\.getenv\s*\(\s*["']([A-Za-z_]\w*)["']/,
      );
      if (env) {
        out.initArgForm = 'env-ref';
        out.initArgValue = env[1] || env[2];
      }
    }
  }

  // Credential: the argument to a mask call, in any of the three shapes.
  // Paren-balanced rather than `[^)]*` because real credential expressions
  // nest calls: `request.headers.get("authorization")`.
  const cred = blockText.match(new RegExp(`\\b(?:[A-Za-z_]\\w*\\.)?${MASK}\\(`));
  if (cred) {
    const arg = balancedArg(blockText, cred.index + cred[0].length);
    if (arg !== null) out.credentialExpr = arg.trim();
  }

  // owner.id. Anchor on the owner key, then take the first `"id":` inside a
  // bounded window, so an unrelated `"id"` later in the result object is not
  // mistaken for it.
  const ownerAnchor = blockText.match(new RegExp(`${key(F.owner)}\\s*:`));
  if (ownerAnchor) {
    const window = blockText.slice(ownerAnchor.index, ownerAnchor.index + 600);
    const idInWindow = window.match(new RegExp(`${key(F.ownerId)}\\s*:\\s*([^,\\n}]+)`));
    if (idInWindow) out.ownerIdExpr = idInWindow[1].trim().replace(/[,;]+$/, '');
  }

  const confirm = blockText.match(
    new RegExp(`${COMMENT}\\s*${CONFIRM}:\\s*([^\\n]+)\\n\\s*${key(F.owner)}\\s*:`),
  );
  if (confirm) out.ownerIdConfirmReason = confirm[1].trim();

  return out;
}

/**
 * Update (or insert) the owner id inside the setup result.
 *
 * Three modes, matching the JS writer: swap an existing id in place, bail out
 * when `owner` is present but not as a plain dict literal (a conditional or a
 * helper call the user wrote deliberately), or insert a fresh `owner` entry
 * after the `api_key` line.
 *
 * Known limit, shared with the JS writer: the swap regex uses `[^{}]` between
 * the owner key and the id, so it does not match when `enrich` (whose lambda
 * body is a dict) is written BEFORE `id`. The guide emits `id` first. When it
 * does not match, the insert path is skipped too, and the file is returned
 * untouched for the user to edit rather than corrupted.
 */
export function setOwnerId(content, expr) {
  const found = parse(content);
  if (!found) return content;
  const newExpr = (expr || '').trim();
  if (!newExpr) return content;
  let block = found.block;

  const ownerRe = new RegExp(
    `(${key(F.owner)}\\s*:\\s*\\{[^{}]*?${key(F.ownerId)}\\s*:\\s*)([^,\\n}]+)([},])`,
  );

  if (ownerRe.test(block)) {
    block = block.replace(ownerRe, (_m, prefix, value, closer) => {
      const trimmed = value.replace(/\s+$/, '');
      const trailing = value.slice(trimmed.length);
      return `${prefix}${newExpr}${trailing}${closer}`;
    });
  } else if (new RegExp(`${key(F.owner)}\\s*:`).test(block)) {
    // `owner` exists but not as a simple dict literal. Inserting a second
    // one would produce a duplicate key; leave it for the repair flow.
    return content;
  } else {
    // Require a mask call on the line so an unrelated `api_key` elsewhere in
    // the file is not what gets patched.
    const apiKeyLineRe = new RegExp(
      `^([ \\t]*)${key(F.apiKey)}\\s*:.*\\b(?:[A-Za-z_]\\w*\\.)?${MASK}\\(.*$`,
      'm',
    );
    const match = block.match(apiKeyLineRe);
    if (!match) return content;
    const indent = match[1];
    const apiKeyLine = match[0];
    const withComma = /,\s*$/.test(apiKeyLine) ? apiKeyLine : `${apiKeyLine},`;
    const ownerLine = `${indent}"${F.owner}": {"${F.ownerId}": ${newExpr}},`;
    block = block.replace(apiKeyLineRe, `${withComma}\n${ownerLine}`);
  }

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}

/** Drop the `# RESTLESS_OWNER_ID_CONFIRM: ...` line above the owner entry. */
export function stripOwnerIdConfirm(content) {
  if (!content) return content;
  return content.replace(
    new RegExp(
      `^[ \\t]*${COMMENT}\\s*${CONFIRM}:[^\\n]*\\n(?=[ \\t]*${key(F.owner)}\\s*:\\s*\\{)`,
      'm',
    ),
    '',
  );
}

/** Render the init argument for the resolved key-delivery mode. */
function buildInitArg(ctx) {
  const spec = getSdkLineSpec(ctx);
  if (spec.form === 'literal') return JSON.stringify(spec.value);
  if (spec.form === 'env-ref') return `os.environ[${JSON.stringify(spec.value)}]`;
  return '';
}

/**
 * Take ownership of the constructor argument (and the inline-key TODO
 * comment), leaving everything the AI wrote inside the setup callback alone.
 * Idempotent.
 */
export function canonicalizeInitArg(content, ctx) {
  const found = parse(content);
  if (!found) return content;

  const call = findConstructorCall(found.block);
  if (!call) return content;

  const wantArg = buildInitArg(ctx);
  let block =
    found.block.slice(0, call.argsStart) +
    wantArg +
    found.block.slice(call.argsStart + call.args.length);

  // The TODO comment tracks inline mode: present for it, absent otherwise.
  const lines = block.split('\n').filter((l) => l.trim() !== TODO_INLINE);
  if (ctx.keyDelivery === 'inline') {
    const initIdx = lines.findIndex((l) =>
      constructorBindings(block).some((b) => new RegExp(`${b}\\s*\\(`).test(l)),
    );
    if (initIdx >= 0) {
      const indent = lines[initIdx].match(/^[ \t]*/)[0];
      lines.splice(initIdx, 0, `${indent}${TODO_INLINE}`);
    }
  }
  block = lines.join('\n');

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}
