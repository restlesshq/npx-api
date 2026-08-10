/**
 * How the SDK init line passes the API key, and nothing else.
 *
 * This is a LEAF module on purpose, like `sdk-writers/languages.js`. It used to
 * live in `setup-context.js`, which imports `envLoader.js` - and every writer
 * imports it, so per-language env detection could never move onto the writers
 * without closing a cycle:
 *
 *   envLoader -> sdk-writers/index -> python -> setup-context -> envLoader
 *
 * The decision itself never needed either of those modules: it is a pure
 * function of `keyDelivery`, `apiKey` and an already-computed `envLoader`
 * result. Pulling it out is what lets `detectEnvLoader` become a writer method
 * rather than a three-branch if-chain keyed on the language name.
 *
 * Keep this file dependency-free.
 */

/**
 * `process.env.RESTLESS_KEY` is reliable when an env loader populates it
 * before the SDK runs. Otherwise we'd rather have the AI emit a no-arg
 * constructor and let the SDK's own `.env` walk handle it - cleaner than
 * referencing an env var that is never set.
 */
export function envLoaderHasKey(envLoader) {
  return !!(envLoader && envLoader.mode && envLoader.mode !== 'none');
}

/**
 * The canonical decision for how the SDK init line passes the API key.
 * Read this in any consumer that needs to know what the init line should look
 * like - never branch on `keyDelivery` and `envLoader` independently.
 *
 * Returns one of:
 *   - { form: 'literal', value: <apiKey> } - user picked inline mode.
 *   - { form: 'env-ref', value: 'RESTLESS_KEY' } - env loader populates
 *     process.env before the SDK runs.
 *   - { form: 'no-arg' } - no env loader; the SDK auto-walks for .env itself.
 */
export function getSdkLineSpec(ctx) {
  if (ctx.keyDelivery === 'inline') {
    return { form: 'literal', value: ctx.apiKey };
  }
  if (envLoaderHasKey(ctx.envLoader)) {
    return { form: 'env-ref', value: 'RESTLESS_KEY' };
  }
  return { form: 'no-arg' };
}
