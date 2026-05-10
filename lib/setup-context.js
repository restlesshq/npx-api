import { detectEnvLoader, envLoaderHasKey } from './envLoader.js';

/**
 * Single source of truth for setup decisions during a CLI run. Built up
 * as the flow progresses, lives in memory only - .restless/settings.json
 * holds repo state, this is per-run state.
 *
 * Every consumer should read from the context, never re-derive. If a
 * derivation is missing, add it to this file once. Past bugs came from
 * different steps deciding the same thing differently (e.g. installSdk
 * inlining a literal key, finalChecks "fixing" it back to no-arg).
 */
export function createSetupContext({
  packageDir,
  rootDir,
  apiRootDir,
  installDir,
  apiDir,
  language,
  framework,
  aiTool,
}) {
  return {
    // Static / detected at start.
    packageDir,
    rootDir,
    apiRootDir,
    installDir,
    apiDir,
    language,
    framework,
    aiTool,
    envLoader: detectEnvLoader(installDir),

    // Filled in by prepareAccount.
    apiKey: null,
    projectId: null,
    setupKey: null,
    keyDelivery: null,
    envFile: null,
    envRelative: null,
    createdEnvFile: false,

    // Filled in by configureSdk (the wire-up substep).
    entryFile: null,
    sdkBlockPresent: false,
  };
}

/**
 * The canonical decision for how the SDK init line passes the API key.
 * Derived from `keyDelivery` and `envLoader`. Read this in any consumer
 * that needs to know what the init line should look like - never branch
 * on `keyDelivery` and `envLoader` independently in a step.
 *
 * Returns one of:
 *   - { form: 'literal', value: <apiKey> } - user picked inline mode.
 *   - { form: 'env-ref', value: 'RESTLESS_KEY' } - env loader populates
 *     process.env before the SDK runs.
 *   - { form: 'no-arg' } - no env loader; the SDK auto-walks for .env
 *     itself.
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

/**
 * Render a debug-safe view of the context. Strips secrets, keeps shape
 * for diagnostics. Pass this to debug.log, never the raw context.
 */
export function redactSetupContext(ctx) {
  const apiKey = ctx.apiKey
    ? `${ctx.apiKey.slice(0, 8)}...${ctx.apiKey.slice(-4)}`
    : null;
  return {
    ...ctx,
    apiKey,
    setupKey: ctx.setupKey ? '<redacted>' : null,
    sdkLineSpec: getSdkLineSpec(ctx),
  };
}
