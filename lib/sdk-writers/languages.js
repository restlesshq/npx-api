/**
 * Language-name normalization, with no dependencies on purpose.
 *
 * This lives apart from `index.js` because that module imports every writer,
 * and a writer imports `setup-context.js`, which imports `envLoader.js`.
 * Anything that needs only "what is this language called, canonically" would
 * otherwise pull the whole registry in behind it and close a cycle:
 *
 *   envLoader -> sdk-writers/index -> javascript -> setup-context -> envLoader
 *
 * which fails at import time with a half-initialized writer descriptor. Keep
 * this file a leaf.
 */

/**
 * Spellings that mean the same language, so a label from AI detection or a
 * hand-edited `.restless/settings.json` resolves the same way.
 *
 * Entries here are NOT promises of support: `csharp` normalizes fine and then
 * fails at `getSdkWriter`. Normalizing is about understanding the input; the
 * registry decides what we can write.
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

/**
 * Canonical lowercase name for a language label.
 *
 * An absent language means JavaScript. That is the long-standing default
 * (`detectedLanguage ||= 'javascript'` in install-sdk, `ctx?.language ||
 * 'javascript'` in final-checks) and it stays: detection only ever emitted
 * `javascript` or `typescript` before Python existed, so a missing value
 * means "detection didn't bother", never "some other language".
 */
export function normalizeLanguage(language) {
  if (!language) return 'javascript';
  const key = String(language).trim().toLowerCase();
  if (!key) return 'javascript';
  return LANGUAGE_ALIASES[key] || key;
}

/**
 * How a canonical language name is spelled to a human.
 *
 * Separate from the alias table because that maps many inputs to one
 * canonical name, and this maps one canonical name to one output. Every
 * user-visible "we support X" string derives from here rather than writing
 * the list out again, which is how the copy drifted from the registry once
 * already (it still said "JavaScript, TypeScript and Python" after Ruby and
 * Go shipped).
 */
const LANGUAGE_LABELS = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  csharp: 'C#',
};

/** Display spelling for one language, falling back to what we were given. */
export function describeLanguage(language) {
  const name = normalizeLanguage(language);
  return LANGUAGE_LABELS[name] || name;
}

/**
 * A list of language names as prose: `Python`, `Python and Go`,
 * `Python, Go and Rust`.
 *
 * Takes display names, not canonical ones, because both callers already hold
 * display names (`detectStack` reads them off the foreign-manifest table).
 * Run them through `describeLanguage` first if you are starting from
 * canonical names.
 */
export function describeLanguages(languages, { empty = 'another language' } = {}) {
  if (!languages || languages.length === 0) return empty;
  if (languages.length === 1) return languages[0];
  return `${languages.slice(0, -1).join(', ')} and ${languages[languages.length - 1]}`;
}
