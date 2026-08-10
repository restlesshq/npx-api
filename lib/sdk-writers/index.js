import * as javascript from './javascript.js';
import * as python from './python.js';
import * as ruby from './ruby.js';
import * as go from './go.js';
import { SETUP_CONCEPTS } from './contract.js';
import { describeLanguage, describeLanguages, normalizeLanguage } from './languages.js';

export { describeLanguage, describeLanguages, normalizeLanguage };

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
  python,
  ruby,
  go,
};

/** Languages that have a writer, i.e. that setup can actually complete for. */
export const SUPPORTED_LANGUAGES = Object.keys(SDK_WRITERS);

/**
 * The supported languages as prose, e.g. `JavaScript, TypeScript, Python,
 * Ruby and Go`.
 *
 * Every user-visible "we support X" string reads this rather than listing the
 * languages again. Two of them had already drifted - the picker hint in
 * generate-oas and the unsupported-stack message in detect-stack both still
 * said "JavaScript, TypeScript and Python" after Ruby and Go shipped - which
 * is the whole argument for deriving it from the registry that decides.
 */
export const SUPPORTED_LANGUAGES_LABEL = describeLanguages(
  SUPPORTED_LANGUAGES.map(describeLanguage),
);

/** Thrown when we understand the language but have no writer for it. */
export class UnsupportedLanguageError extends Error {
  constructor(language) {
    super(
      `No SDK writer for ${language}. This build can wire ${SUPPORTED_LANGUAGES_LABEL} only.`,
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
 * The writer that owns a file extension, or null.
 *
 * For the passes that walk a mixed repo and need to read each file with the
 * right dialect - the port scan hits `.go`, `.py` and `.rb` files in the same
 * directory. Returns null for extensions no writer claims (Dockerfiles,
 * markdown) so the caller can pick its own fallback rather than being handed
 * the JavaScript writer by default.
 *
 * `typescript` is skipped because it shares the JavaScript writer, which
 * already claims `.ts`; iterating it would just find the same module twice.
 */
export function writerForExtension(ext) {
  if (!ext) return null;
  const wanted = String(ext).toLowerCase();
  for (const [name, writer] of Object.entries(SDK_WRITERS)) {
    if (name === 'typescript') continue;
    if (writer.descriptor.extensions.includes(wanted)) return writer;
  }
  return null;
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
 *   detectEnvLoader     setup-context
 *   resolveInstalled    install-target
 *   describeMissing     install-target
 *   scanCodebase        scanners
 *   parsePort           test-setup
 *   defaultLocalPort    test-setup
 *
 * The last five were if-chains keyed on the language name, scattered across
 * `envLoader.js`, `install-target.js`, `scanners.js` and `test-setup.js`. The
 * registry claimed adding a language meant one edit here; it actually meant
 * eight, and nothing failed loudly when you missed one - the language just
 * silently got the JavaScript answer at that one site. Requiring them here is
 * what makes the claim true.
 */
export const REQUIRED_WRITER_METHODS = Object.freeze([
  'hasSdkReference',
  'hasInit',
  'readBlockFields',
  'setOwnerId',
  'canonicalizeInitArg',
  'stripOwnerIdConfirm',
  'candidateWiringFiles',
  'detectEnvLoader',
  'resolveInstalled',
  'describeMissing',
  'scanCodebase',
  'parsePort',
  'defaultLocalPort',
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
  // Feeds the "NEVER read files inside X" line in three shipped prompts. A
  // writer without it would silently render an empty guardrail, so require it
  // here rather than discovering it in a user's repo.
  if (!d.neverRead?.length) {
    throw new Error(
      `SDK writer "${name}" descriptor does not list its neverRead paths (vendored deps / secret stores)`,
    );
  }
  // The agent playbook renders these directly. A writer without them used to
  // fall back to the JavaScript phrasing, so a Rails project got told to run
  // `npm run dev` and not to touch `package.json`.
  for (const phrase of ['startHints', 'dontTouch', 'envNote']) {
    if (!d.phrasing?.[phrase]) {
      throw new Error(`SDK writer "${name}" descriptor is missing phrasing.${phrase}`);
    }
  }
  if (!Array.isArray(d.extensions) || d.extensions.length === 0) {
    throw new Error(`SDK writer "${name}" descriptor does not list its source extensions`);
  }
  // Read by the port cascade in test-setup; an empty list would silently skip
  // the strongest evidence for that language.
  if (!writer.portFiles?.length) {
    throw new Error(`SDK writer "${name}" does not list portFiles`);
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
