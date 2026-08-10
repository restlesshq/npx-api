import fs from 'fs';
import path from 'path';
import { getSdkLineSpec } from '../setup-context.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { findSdkReferences } from '../grep-sdk.js';

/**
 * Owns the SDK setup code in Ruby source files.
 *
 * The shape this has to recognize:
 *
 *     require "restless"
 *
 *     CLIENT = Restless.new(ENV["RESTLESS_KEY"])
 *
 *     CLIENT.setup do |request|
 *       result = { api_key: CLIENT.mask(request.header("Authorization")) }
 *       result[:owner] = { id: workspace_id, enrich: method(:load_workspace) }
 *       result
 *     end
 *
 *     use CLIENT.rack                                    # config.ru
 *     config.middleware.insert_before 0, CLIENT.rack     # Rails
 *
 * What differs from the other two dialects:
 *
 *   1. **The wiring is not in the file with the routes.** Rack mounts in
 *      `config.ru` or `config/application.rb` while the routes live in
 *      `config/routes.rb` or a Sinatra app class. `candidateWiringFiles` is
 *      the seam that exists for exactly this, and Ruby is the language it was
 *      designed for - the JavaScript assumption "the wiring is in a file that
 *      imports the package" is simply false here.
 *   2. **A Rails wiring may not `require` anything.** Bundler auto-requires
 *      gems, so `config/application.rb` can reference `Restless` with no
 *      require line anywhere. Every "is this file wired" check therefore has
 *      to accept a bare constructor reference, not just an import.
 *   3. **Hash keys have two spellings**, `api_key:` and `:api_key =>`. Both
 *      are current Ruby; a writer that knew only one would silently miss
 *      half of real code.
 *
 * Like the other writers this patches by regex, so it only touches what it
 * recognizes and leaves anything else for the user.
 */

export const descriptor = Object.freeze({
  language: 'ruby',
  extensions: ['.rb', '.ru'],
  searchGlobs: ['*.rb', '*.ru'],
  packageSpecifier: 'restless-sdk',
  importName: 'restless',
  manifests: ['Gemfile', 'gems.rb', '*.gemspec'],
  installCommand: 'gem install restless-sdk',
  // Matches a require OR a bare constructor reference, because a Rails
  // wiring legitimately has neither a require nor the gem name in the file.
  searchPattern: '(require[[:space:]]+["\']restless["\']|Restless\\.new|Restless::Client)',
  commentPrefix: '#',
  // §15 concepts as Ruby symbol keys.
  fields: Object.freeze({
    apiKey: 'api_key',
    owner: 'owner',
    ownerId: 'id',
    enrich: 'enrich',
  }),
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'mask', styles: ['method', 'module'] }),
});

const COMMENT = escapeRegex(descriptor.commentPrefix);
const CONFIRM = escapeRegex(OWNER_ID_CONFIRM_MARKER);
const TODO_INLINE = `${descriptor.commentPrefix} ${INLINE_KEY_TODO_TEXT}`;

const F = descriptor.fields;
const MASK = escapeRegex(descriptor.maskCall.name);

/**
 * A hash key in either spelling: `api_key:` (modern) or `:api_key =>`
 * (hashrocket). Both are idiomatic and both appear in real code.
 */
function key(name) {
  const n = escapeRegex(name);
  return `(?:${n}\\s*:|:${n}\\s*=>)`;
}

/**
 * Where the owner hash attaches, as one alternation:
 *
 *   owner: { ... }            inside the hash literal
 *   result[:owner] = { ... }  assigned after, usually conditionally
 *
 * The second is what the real pet-store fixture writes, for the same reason
 * it appears in Python: a literal cannot conditionally omit a key.
 */
function ownerAnchor() {
  const n = escapeRegex(F.owner);
  return `(?:${n}\\s*:|:${n}\\s*=>|\\[\\s*:${n}\\s*\\]\\s*=)\\s*`;
}

const REQUIRE_RE = /^[ \t]*require(?:_relative)?[ \t]+["']restless["'][ \t]*(?:#.*)?$/m;
// `Restless.new`, `Restless::Client.new`, and an alias assigned from either.
const CONSTRUCTOR_RE = /\bRestless(?:::Client)?\.new\s*\(/;
const CONSTRUCTOR_NO_PARENS_RE = /\bRestless(?:::Client)?\.new\b/;

/** Does this file reference the SDK at all? The loose check. */
export function hasSdkReference(content) {
  if (!content) return false;
  return REQUIRE_RE.test(content) || CONSTRUCTOR_NO_PARENS_RE.test(content)
    || /\bRestless::Client\b/.test(content);
}

/**
 * Is a client actually constructed here? The strict check.
 *
 * Deliberately does NOT require a `require` line: under Bundler the gem is
 * already loaded, so a Rails `config/application.rb` wires the SDK without
 * one. Requiring an import would report every Rails install as unwired.
 */
export function hasInit(content) {
  if (!content) return false;
  return CONSTRUCTOR_RE.test(content);
}

export function parse(content) {
  if (!content || !hasSdkReference(content)) return null;
  return { block: content, startIdx: 0, endIdx: content.length };
}

/**
 * Known Rack mount points, ahead of the grep.
 *
 * Rails mounts middleware in `config/application.rb` (or an initializer) and
 * a rackup app in `config.ru`, while the routes sit in `config/routes.rb`.
 * None of those necessarily mention the gem, so the grep alone can miss the
 * file the CLI has to patch.
 */
const MOUNT_FILES = [
  'config.ru',
  path.join('config', 'application.rb'),
  path.join('config', 'environment.rb'),
  path.join('config', 'initializers', 'restless.rb'),
];

export function candidateWiringFiles(installDir) {
  const found = findSdkReferences(installDir, {
    pattern: descriptor.searchPattern,
    globs: descriptor.searchGlobs,
  });
  const known = MOUNT_FILES.filter((rel) => {
    try {
      return fs.existsSync(path.join(installDir, rel));
    } catch {
      return false;
    }
  });
  // Known mount points first, then whatever the grep turned up, deduped.
  return [...new Set([...known, ...found])];
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

function findConstructorCall(content) {
  const m = content.match(CONSTRUCTOR_RE);
  if (!m) return null;
  const argsStart = m.index + m[0].length;
  const args = balancedArg(content, argsStart);
  if (args === null) return null;
  return { index: m.index, argsStart, args };
}

/**
 * The FIRST argument of the constructor call, which is the key. Ruby takes
 * keyword options after it (`base_url:`, `redact:`), so the whole argument
 * list is not the key - splitting on the first top-level comma is.
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
    if (argRaw === '') {
      out.initArgForm = 'no-arg';
    } else if (/^["'](?:rstlss_|rdme_)/.test(argRaw)) {
      out.initArgForm = 'literal';
      out.initArgValue = argRaw.slice(1, -1);
    } else {
      // `ENV["X"]`, `ENV.fetch("X", nil)`, and the `|| "fallback"` form the
      // fixtures use for local runs.
      const env = argRaw.match(/ENV(?:\.fetch)?\s*[[(]\s*["']([A-Za-z_]\w*)["']/);
      if (env) {
        out.initArgForm = 'env-ref';
        out.initArgValue = env[1];
      }
    }
  }

  const cred = blockText.match(new RegExp(`\\b(?:[A-Za-z_][\\w:]*\\.)?${MASK}\\(`));
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
    new RegExp(`${COMMENT}\\s*${CONFIRM}:\\s*([^\\n]+)\\n\\s*(?:result)?\\s*${ownerAnchor()}`),
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
  } else if (new RegExp(ownerAnchor()).test(block)) {
    // An owner exists but not as a plain hash literal - a ternary, a method
    // call, something the user meant. Adding a second key would shadow it.
    return content;
  } else {
    // `.*?` after the indent because Ruby routinely opens the hash on the
    // same line (`result = { api_key: ... }`), so the key is not at the start
    // of the line the way it usually is in a Python dict.
    const apiKeyLineRe = new RegExp(
      `^([ \\t]*).*?${key(F.apiKey)}.*\\b(?:[A-Za-z_][\\w:]*\\.)?${MASK}\\(.*$`,
      'm',
    );
    const match = block.match(apiKeyLineRe);
    if (!match) return content;
    const indent = match[1];
    const apiKeyLine = match[0];
    const withComma = /,\s*$/.test(apiKeyLine) ? apiKeyLine : `${apiKeyLine},`;
    const ownerLine = `${indent}${F.owner}: { ${F.ownerId}: ${newExpr} },`;
    block = block.replace(apiKeyLineRe, `${withComma}\n${ownerLine}`);
  }

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}

export function stripOwnerIdConfirm(content) {
  if (!content) return content;
  return content.replace(
    new RegExp(
      `^[ \\t]*${COMMENT}\\s*${CONFIRM}:[^\\n]*\\n(?=[ \\t]*(?:result)?\\s*${ownerAnchor()}\\{)`,
      'm',
    ),
    '',
  );
}

/**
 * Render the constructor argument.
 *
 * `ENV["X"]` rather than a fetch: unlike Python's dict subscript, Ruby's
 * `ENV[...]` returns nil for a missing key instead of raising, so the
 * idiomatic form is also the safe one and the SDK falls back to its own
 * lookup.
 */
function buildInitArg(ctx) {
  const spec = getSdkLineSpec(ctx);
  if (spec.form === 'literal') return JSON.stringify(spec.value);
  if (spec.form === 'env-ref') return `ENV[${JSON.stringify(spec.value)}]`;
  return '';
}

export function canonicalizeInitArg(content, ctx) {
  const found = parse(content);
  if (!found) return content;

  const call = findConstructorCall(found.block);
  if (!call) return content;

  const wantArg = buildInitArg(ctx);
  // Replace only the FIRST argument, preserving any keyword options the user
  // configured (`base_url:`, `redact:`) after it.
  const first = firstArg(call.args);
  const rest = call.args.slice(first.length);
  const nextArgs = wantArg === '' && rest.trim().startsWith(',')
    ? rest.replace(/^\s*,\s*/, '')
    : `${wantArg}${rest}`;

  let block =
    found.block.slice(0, call.argsStart) +
    nextArgs +
    found.block.slice(call.argsStart + call.args.length);

  const lines = block.split('\n').filter((l) => l.trim() !== TODO_INLINE);
  if (ctx.keyDelivery === 'inline') {
    const initIdx = lines.findIndex((l) => CONSTRUCTOR_NO_PARENS_RE.test(l));
    if (initIdx >= 0) {
      const indent = lines[initIdx].match(/^[ \t]*/)[0];
      lines.splice(initIdx, 0, `${indent}${TODO_INLINE}`);
    }
  }
  block = lines.join('\n');

  if (block === found.block) return content;
  return content.slice(0, found.startIdx) + block + content.slice(found.endIdx);
}
