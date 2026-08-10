import * as javascript from './javascript.js';
import { SETUP_CONCEPTS } from './contract.js';

/**
 * The one registry mapping a language to the module that owns SDK code in
 * that language's source files.
 *
 * This used to be three private copies - `steps/install-sdk.js`,
 * `steps/final-checks.js`, `steps/verify-owner-id.js` - each written as
 * `writers[language] || jsWriter`. That fallback is the dangerous part, not
 * the duplication: any language we don't have a writer for silently got the
 * JavaScript one, so a Python repo would be scanned with regexes looking for
 * `require('@restlessai/sdk')`, match nothing, and be reported as "SDK not
 * wired" rather than "we can't wire this yet". Every check downstream
 * (`hasInit`, `readBlockFields`, `setOwnerId`) would have been quietly wrong
 * in the same direction.
 *
 * So: unknown languages throw. Adding a language means adding it here once,
 * and all three steps pick it up.
 */
const SDK_WRITERS = {
  // TypeScript shares the JavaScript writer: same import syntax, same
  // `@restlessai/sdk` package, same call shapes. The distinction only
  // matters for which guide we load and which config filename we emit.
  javascript,
  typescript: javascript,

  // NOT YET: `python`. `lib/sdk-writers/python.js` exists and passes
  // `assertWriterShape`, but a writer alone does not make a language
  // installable - endpoint detection, install-dir resolution, the
  // installed-check, env loading and the guide are all still JS-only, and
  // `restless-sdk` is not on PyPI yet.
  //
  // This registry IS the ship gate. Adding the entry is the last step of
  // Phase 1b, not the first, so a half-built language can never be reached
  // by `getSdkWriter` and quietly half-work.
};

/**
 * Spellings that mean the same language, so a label from AI detection or a
 * hand-edited `.restless/settings.json` resolves the same way.
 *
 * Values here are NOT promises of support - `csharp` normalizes fine and
 * then fails at `getSdkWriter`, which is the intended split: normalizing is
 * about understanding the input, the registry is about what we can write.
 */
const LANGUAGE_ALIASES = {
  node: 'javascript',
  'node.js': 'javascript',
  nodejs: 'javascript',
  js: 'javascript',
  'javascript (node.js)': 'javascript',
  ts: 'typescript',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  golang: 'go',
  csharp: 'csharp',
  'c#': 'csharp',
};

/** Languages that have a writer, i.e. that setup can actually complete for. */
export const SUPPORTED_LANGUAGES = Object.keys(SDK_WRITERS);

/**
 * Canonical lowercase name for a language label.
 *
 * An absent language means JavaScript. That is the long-standing default
 * (`detectedLanguage ||= 'javascript'` in install-sdk, `ctx?.language ||
 * 'javascript'` in final-checks) and it stays: detection only ever emitted
 * `javascript` or `typescript`, so a missing value means "the detection
 * didn't bother", never "some other language".
 */
export function normalizeLanguage(language) {
  if (!language) return 'javascript';
  const key = String(language).trim().toLowerCase();
  if (!key) return 'javascript';
  return LANGUAGE_ALIASES[key] || key;
}

/** Thrown when we understand the language but have no writer for it. */
export class UnsupportedLanguageError extends Error {
  constructor(language) {
    super(
      `No SDK writer for ${language}. This build can wire ${SUPPORTED_LANGUAGES.join(' and ')} only.`,
    );
    this.name = 'UnsupportedLanguageError';
    this.language = language;
  }
}

/**
 * The writer for a language, or a thrown `UnsupportedLanguageError`.
 *
 * Reaching the throw means something upstream let a language through that
 * `lib/detect-stack.js` should have stopped at the door, so treat it as an
 * invariant violation rather than an expected branch.
 */
export function getSdkWriter(language) {
  const name = normalizeLanguage(language);
  const writer = SDK_WRITERS[name];
  if (!writer) throw new UnsupportedLanguageError(name);
  return writer;
}

/** Whether `getSdkWriter` would succeed, without throwing to find out. */
export function isSupportedLanguage(language) {
  return Object.hasOwn(SDK_WRITERS, normalizeLanguage(language));
}

/**
 * What a writer MUST implement, because a step calls it by name on whatever
 * `getSdkWriter` returns.
 *
 * Derived from the actual call sites, not from what `javascript.js` happens
 * to export:
 *   hasSdkReference     final-checks (loose "is the SDK mentioned here")
 *   hasInit             install-sdk, verify-owner-id (strict "is it wired")
 *   readBlockFields     final-checks, verify-owner-id
 *   setOwnerId          final-checks
 *   canonicalizeInitArg install-sdk, final-checks
 *   stripOwnerIdConfirm final-checks
 *   candidateWiringFiles all three (see below)
 */
export const REQUIRED_WRITER_METHODS = Object.freeze([
  'hasSdkReference',
  'hasInit',
  'readBlockFields',
  'setOwnerId',
  'canonicalizeInitArg',
  'stripOwnerIdConfirm',
  'candidateWiringFiles',
]);

/**
 * Deliberately NOT required.
 *
 * - `generate` builds SDK code from scratch. Production never calls it: the
 *   AI writes the wiring and the CLI only patches afterwards, so it survives
 *   as a test fixture. A new language does not need a code generator, which
 *   removes the hardest part of writing one (emitting idiomatic decorator /
 *   block / func-literal syntax).
 * - `parse` is an internal helper of the JS writer; no step calls it.
 * - `findOldApiSetup` detects the pre-rename JS API. Nothing else has an old
 *   API to migrate from.
 * - `hasWithRestless` / `hasDefineConfig` are the Next.js plugin checks, and
 *   `lib/next-detect.js` imports them straight from `javascript.js` rather
 *   than through this registry. CONTRACT.md §14 makes build-time and bundler
 *   integration explicitly Node-only, so they are not a shared concern.
 */
export const OPTIONAL_WRITER_METHODS = Object.freeze([
  'generate',
  'parse',
  'findOldApiSetup',
  'hasWithRestless',
  'hasDefineConfig',
]);

/**
 * Fail loudly at startup if a writer is missing something a step will call,
 * rather than at the moment that step runs in a user's repo. Cheap: it runs
 * once per process over a handful of names.
 */
export function assertWriterShape(name, writer) {
  for (const method of REQUIRED_WRITER_METHODS) {
    if (typeof writer[method] !== 'function') {
      throw new Error(`SDK writer "${name}" is missing required method ${method}()`);
    }
  }
  const d = writer.descriptor;
  if (!d) throw new Error(`SDK writer "${name}" is missing its descriptor`);
  for (const concept of SETUP_CONCEPTS) {
    if (!d.fields?.[concept]) {
      throw new Error(
        `SDK writer "${name}" descriptor does not spell the "${concept}" field (CONTRACT.md §15)`,
      );
    }
  }
  if (!d.commentPrefix) {
    throw new Error(`SDK writer "${name}" descriptor is missing commentPrefix`);
  }
  if (!d.searchPattern || !d.searchGlobs?.length) {
    throw new Error(`SDK writer "${name}" descriptor cannot locate its own source files`);
  }
  const styles = d.maskCall?.styles;
  if (!Array.isArray(styles) || styles.length === 0) {
    throw new Error(`SDK writer "${name}" descriptor must list at least one maskCall style`);
  }
  for (const style of styles) {
    if (!['method', 'module', 'package'].includes(style)) {
      throw new Error(`SDK writer "${name}" has unknown maskCall style "${style}"`);
    }
  }
}

for (const [name, writer] of Object.entries(SDK_WRITERS)) {
  assertWriterShape(name, writer);
}
