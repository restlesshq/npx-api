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
