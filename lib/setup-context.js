import { getSdkWriter } from './sdk-writers/index.js';
import { envLoaderHasKey, getSdkLineSpec } from './sdk-line-spec.js';

// Re-exported because every existing consumer imports it from here, and it is
// genuinely part of this module's job (what the context decided). The
// implementation lives in `sdk-line-spec.js` so the writers can use it without
// importing this file, which is what closed the old import cycle.
export { getSdkLineSpec, envLoaderHasKey };

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
  agent,
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
    // `aiTool` is the display name shown to the user ("Claude Code"),
    // `agent` the slug reported to the server as the agent that ran this
    // setup ('claude'). Same choice, two audiences - don't derive one from
    // the other by string munging.
    aiTool,
    agent,
    // Through the registry, so a new language cannot be half-supported: the
    // writer either implements `detectEnvLoader` or fails `assertWriterShape`
    // at import. This used to be a three-branch if-chain in `envLoader.js`
    // that a new language could silently miss, falling through to the Node
    // answer (`package.json` deps) for a project with no package.json.
    envLoader: getSdkWriter(language).detectEnvLoader(installDir),

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
