import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, red, cyan, yellow, orange, ask, terminalPrompt, waitForKey } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { CLI_NAME } from '../lib/config.js';
import { safeWriteFileSync } from '../lib/pathGuard.js';
import { fatalError } from '../lib/errors.js';
import * as debug from '../lib/debug.js';
import * as jsWriter from '../lib/sdk-writers/javascript.js';
import { findSdkReferences } from '../lib/grep-sdk.js';
import { detectNext, isNextFramework } from '../lib/next-detect.js';

/**
 * Pick the language-specific SDK writer for this run. Today we only
 * support JavaScript / TypeScript; Python / Ruby / Go land here as
 * sibling modules with the same exported shape.
 */
function getSdkWriter(language) {
  const writers = { javascript: jsWriter, typescript: jsWriter };
  return writers[language] || jsWriter;
}

/**
 * Walk the install dir for source files referencing `@restlessai/sdk`.
 * Returns the list of relative paths inside `installDir`, in grep
 * output order. Empty array when nothing matches.
 *
 * This is the raw signal - callers like `isSdkWired` and
 * `findWiredSourceFile` layer additional checks (writer.parse) on top
 * so we don't treat a stray comment or stale partial reference as
 * "wired in."
 *
 * Uses the shared `findSdkReferences` helper so the grep excludes
 * `node_modules` (and other heavy dirs) at the recursion level, not
 * after. Past incident: scanning node_modules synchronously froze the
 * UI for tens of seconds between Generate API key and Configure SDK.
 */
function findSdkCandidateFiles(installDir) {
  return findSdkReferences(installDir);
}

/**
 * Find a real wired source file - not just a stray reference.
 * Returns absolute path of the first file that contains a parseable
 * SDK block, or null if none.
 *
 * Two-layer check: grep finds candidates fast, then writer.parse()
 * verifies the file actually imports/requires `@restlessai/sdk` in
 * the canonical form. A file that mentions the package only in a
 * comment or string literal is rejected.
 */
function findWiredSourceFile(installDir, language = 'javascript') {
  const writer = getSdkWriter(language);
  const candidates = findSdkCandidateFiles(installDir);
  for (const rel of candidates) {
    const abs = path.join(installDir, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      // Use `hasInit()`, NOT `parse()`. parse() matches any quoted
      // mention of the package - a comment, a test fixture, a config
      // string would all qualify. hasInit() requires an actual
      // `require('@restlessai/sdk')` or `from '@restlessai/sdk'`
      // statement, which is the only thing that actually plumbs the
      // SDK into the user's code.
      if (writer.hasInit(content)) {
        debug.log('install-sdk.wired-file', { rel, candidates: candidates.length });
        return abs;
      }
    } catch {
      // Unreadable file - skip and continue. A common case is a
      // grep match in a generated file that's mid-rewrite.
    }
  }
  if (candidates.length > 0) {
    // Grep matched something but none of the candidates have a real
    // init/import. Surface this in the debug log so the disagreement
    // between "grep finds it" and "no actual wiring" is visible -
    // most often this is a leftover comment, JSDoc, or test fixture
    // from a prior CLI run.
    debug.log('install-sdk.stale-references', { candidates });
  }
  return null;
}

/**
 * After the AI wires in the SDK, the CLI takes ownership of the init
 * line: rewrites the init arg to match `getSdkLineSpec(ctx)` (literal /
 * env-ref / no-arg). Auth extraction and owner.id (the AI's
 * domain-specific work) are preserved.
 */
function canonicalizeSdkBlock(ctx) {
  const writer = getSdkWriter(ctx.language);
  const file = findWiredSourceFile(ctx.installDir, ctx.language);
  if (!file) return { mode: 'no-source', file: null };
  const content = fs.readFileSync(file, 'utf8');
  const next = writer.canonicalizeInitArg(content, ctx);
  if (next !== content) safeWriteFileSync(file, next);
  return { mode: 'canonicalized', file: path.relative(ctx.installDir, file) };
}

const languageAliases = {
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

const installCommands = {
  javascript: 'npm install @restlessai/sdk --save',
  typescript: 'npm install @restlessai/sdk --save',
  python: 'pip install restlessai',
  ruby: 'gem install restlessai',
  go: 'go get github.com/restlessai/go',
};

/**
 * Check whether `@restlessai/sdk` is actually wired into the user's
 * source. Used to skip the setup AI pass when someone's re-running the
 * CLI - but only when there's a REAL wired block, not just a comment
 * or stale partial reference left over from an earlier run. Goes
 * through `findWiredSourceFile` so the grep + writer.parse() check
 * matches the one canonicalize and final-checks use.
 *
 * Past bug: a raw grep here returned true on stray references and
 * skipped the AI wiring pass entirely, leaving the user with an
 * unwired SDK and the CLI marking the step as done.
 */
function isSdkWired(packageDir, language = 'javascript') {
  return findWiredSourceFile(packageDir, language) !== null;
}

/**
 * Next.js-specific wiring gate.
 *
 * On Next.js the SDK must wrap App Router route handlers via
 * `@restlessai/sdk/next` - it must NEVER be wired into the middleware file
 * (`middleware.ts` / `proxy.ts`). Next passes middleware a `NextRequestHint`
 * whose `.request` getter throws `PageSignatureError` (E394) the moment the
 * SDK's adapter sniffs its argument, and middleware runs on the Edge runtime
 * where an `owner.enrich` DB lookup can't run either. So `isSdkWired` alone
 * (any file with a factory call) is not enough: a middleware wiring passes
 * that check yet ships a crashing install.
 *
 * Returns which wired files sit on the middleware side vs the handler side,
 * and `ok` = at least one handler-side wiring AND zero middleware wirings.
 */
export function nextWiringStatus(installDir, nextInfo, language = 'javascript') {
  const writer = getSdkWriter(language);
  const mwSet = new Set(nextInfo.middlewareFiles);
  const wired = [];
  for (const rel of findSdkCandidateFiles(installDir)) {
    try {
      if (writer.hasInit(fs.readFileSync(path.join(installDir, rel), 'utf8'))) wired.push(rel);
    } catch {
      // Unreadable mid-rewrite file - skip, same as findWiredSourceFile.
    }
  }
  const wiredMiddleware = wired.filter((rel) => mwSet.has(rel));
  const wiredHandlerSide = wired.filter((rel) => !mwSet.has(rel));
  return {
    wired,
    wiredMiddleware,
    wiredHandlerSide,
    ok: wiredMiddleware.length === 0 && wiredHandlerSide.length > 0,
  };
}

/**
 * Walk from `packageDir` toward the filesystem root, checking each
 * directory's `node_modules` for the hoisted SDK package. Returns the
 * absolute path of the package.json that resolves the SDK, or null.
 *
 * Workspaces matter here: in npm / pnpm / yarn workspaces, running
 * `npm install <pkg>` inside `packages/<workspace>/` typically hoists
 * the dependency up to the repo root's `node_modules/`, not into the
 * workspace's own. Checking only `packageDir/node_modules` produced
 * a false "install failed" verdict for every monorepo user, after
 * which the rest of the flow ran with bogus state.
 *
 * We also defend against broken symlinks (a leftover `npm link` that
 * points nowhere) by requiring the package.json to be readable, not
 * just present on disk.
 */
function resolveInstalledSdk(packageDir) {
  const names = [
    ['@restlessai', 'sdk'],
    ['restlessai'],
  ];
  let dir = path.resolve(packageDir);
  // Cap at 8 levels up. Any monorepo deeper than that is exotic; we
  // wouldn't be confident the result belongs to the same project anyway.
  for (let depth = 0; depth < 8; depth++) {
    for (const name of names) {
      const pkgJson = path.join(dir, 'node_modules', ...name, 'package.json');
      try {
        fs.accessSync(pkgJson, fs.constants.R_OK);
        return pkgJson;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isSdkInstalled(packageDir) {
  return resolveInstalledSdk(packageDir) !== null;
}

/**
 * Find the directory whose `package.json` actually owns the detected API.
 * In a monorepo the API might live under `packages/api/` with its own
 * `package.json`; installing at the repo root would add the SDK to the
 * wrong workspace. Walk from the API's rootDir up to the repo root and
 * return the first directory that has a `package.json`.
 */
export function resolveInstallDir(packageDir, apiRootDir) {
  if (!apiRootDir || apiRootDir === '.') return packageDir;
  let dir = path.resolve(packageDir, apiRootDir);
  const stop = path.resolve(packageDir);
  while (dir.startsWith(stop)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageDir;
}

/**
 * For inline-key mode: after the AI has wired up the SDK, scan files
 * importing `@restlessai/sdk` and put the literal key into the SDK init
 * call. Narrowly scoped to files that import the SDK so we don't touch
 * unrelated identifiers elsewhere.
 *
 * Three call-site patterns are recognized, in order:
 *   1. `process.env.RESTLESS_KEY` placeholder (what the AI emits when we
 *      tell it to). Swap the placeholder for the literal.
 *   2. Bare immediate factory call: `require('@restlessai/sdk')()`. Inject
 *      the literal between the parens. Covers re-runs where a previous AI
 *      pass produced a no-arg call.
 *   3. Named factory call after a non-immediate import: `import x from
 *      '@restlessai/sdk'; ... x()`. Same fix - inject literal.
 *
 * For each line we patch, prepend a `// TODO: move this out of the
 * codebase before committing` comment - the inline path is testing-only
 * and we don't want users committing the literal key by accident.
 *
 * Idempotent: if the literal key is already present in the file, do
 * nothing.
 */
export function inlineKeyIntoSource(installDir, apiKey) {
  let touched = [];
  try {
    const files = findSdkReferences(installDir);
    const literal = JSON.stringify(apiKey);
    const TODO = '// TODO: move this out of the codebase before committing';

    // `SDK_PKG` allows subpath entrypoints (`@restlessai/sdk/next`), so the
    // inline-key path also patches Next.js wirings, not just the bare entry.
    const SDK_PKG = String.raw`@restlessai\/sdk(?:\/[\w.-]+)*`;
    const bareRequireCall = new RegExp(`require\\(\\s*['"]${SDK_PKG}['"]\\s*\\)\\s*\\(\\s*\\)`);
    const bareRequireInject = new RegExp(`(require\\(\\s*['"]${SDK_PKG}['"]\\s*\\)\\s*\\()(\\s*)(\\))`);

    for (const rel of files) {
      const full = path.join(installDir, rel);
      const content = fs.readFileSync(full, 'utf8');

      // Idempotent: if we already inlined this exact key, leave the file alone.
      if (content.includes(apiKey)) continue;

      // Detect a name bound to the factory itself (not the result of calling it).
      // `const x = require('@restlessai/sdk')()` is the immediate-call form -
      // `x` holds the result, not the factory, so we don't match against it.
      let factoryName = null;
      const esmMatch = content.match(new RegExp(`import\\s+(\\w+)\\s+from\\s+['"]${SDK_PKG}['"]`));
      const cjsMatch = content.match(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*require\\(\\s*['"]${SDK_PKG}['"]\\s*\\)\\s*;?\\s*$`, 'm'));
      if (esmMatch) factoryName = esmMatch[1];
      else if (cjsMatch) factoryName = cjsMatch[1];

      const namedCall = factoryName ? new RegExp(`\\b${factoryName}\\s*\\(\\s*\\)`) : null;
      const namedInject = factoryName ? new RegExp(`(\\b${factoryName}\\s*\\()(\\s*)(\\))`) : null;

      const lines = content.split('\n');
      const next = [];
      let changed = false;

      for (const line of lines) {
        let newLine = line;
        let didReplace = false;

        if (line.includes('process.env.RESTLESS_KEY')) {
          newLine = line.replaceAll('process.env.RESTLESS_KEY', literal);
          didReplace = true;
        } else if (bareRequireCall.test(line)) {
          newLine = line.replace(bareRequireInject, `$1${literal}$3`);
          didReplace = true;
        } else if (namedCall && namedCall.test(line)) {
          newLine = line.replace(namedInject, `$1${literal}$3`);
          didReplace = true;
        }

        if (didReplace) {
          // Don't double-add the TODO if a previous run already inserted one.
          const prev = next[next.length - 1] || '';
          if (!prev.includes('TODO: move this out of the codebase')) {
            const indent = line.match(/^\s*/)[0];
            next.push(`${indent}${TODO}`);
          }
          next.push(newLine);
          changed = true;
        } else {
          next.push(line);
        }
      }

      if (changed) {
        safeWriteFileSync(full, next.join('\n'));
        touched.push(rel);
      }
    }
  } catch {}
  return touched;
}

export default async function installSdk({
  ctx,
  update,
  setSpinner,
  // Runs between Install package (sub 0) and Configure SDK (sub 2).
  // Owns sub 1 (Generate API key). Should resolve to whatever
  // prepareAccount returns - we forward it back in our own return value.
  prepareAccountStep,
}) {
  const { packageDir, installDir, framework: detectedFramework, aiTool = 'Claude Code' } = ctx;
  let detectedLanguage = ctx.language;
  const frameworkLabel = detectedFramework || detectedLanguage || 'your framework';
  const installDirRel = path.relative(packageDir, installDir) || '.';
  // Friendly version for prose: "the root" when there's no relative path,
  // otherwise the relative path (e.g. "packages/api"). The bold-highlighted
  // version of "the root" stays as just bold "the root" - it reads as a
  // location, not a literal path.
  const installLocation = installDirRel === '.' ? bold('the root') : bold(installDirRel);

  await startStep({
    update,
    stepNum: 2,
    title: 'Install the SDK',
    intro: `Now let's drop the Restless SDK into your ${bold(frameworkLabel)} project.`,
    sections: [
      {
        label: 'Why',
        body:
          `The SDK captures each request, masks sensitive data, and ships logs to\n` +
          `Restless. It's the thing that turns your API into an observable one.`,
      },
      {
        label: "What we'll do",
        body:
          `Install ${bold('@restlessai/sdk')} with your package manager, then point ${orange(aiTool)}\n` +
          `at your server file to wire the middleware in before your routes. We'll also make\n` +
          `one call to our server to generate an API key and setup token. No personal data\n` +
          `or code is sent in that call, just the public-key-style hash we use to identify\n` +
          `your project later.`,
      },
      {
        label: 'Privacy',
        body:
          `The SDK runs in your process. ${orange(aiTool)} only reads the files it needs to\n` +
          `wire things up, and we never touch ${bold('.env')}.`,
      },
    ],
    // The terminal prompt below is the action - no separate keypress gate.
    skipWait: true,
  });

  if (!detectedLanguage) detectedLanguage = 'javascript';
  const guideLanguage = languageAliases[detectedLanguage] || detectedLanguage;

  // ── Sub 0: Install package ───────────────────────────────────────────────
  const alreadyInstalled = isSdkInstalled(installDir);
  if (alreadyInstalled) {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} ${bold('@restlessai/sdk')} is already installed in ${installLocation} - skipping install.`,
    ]});
  } else {
    const defaultCmd = installCommands[guideLanguage] || installCommands.javascript;
    const cdPrefix = installDirRel !== '.' ? `cd ${installDirRel} && ` : '';
    // Keep the step intro visible above the prompt - just advance the cursor.
    update({ activeSub: 0 });
    const cmd = await terminalPrompt(cdPrefix + defaultCmd);

    update({ activeSub: 0, message: [
      `  Installing ${bold('@restlessai/sdk')} in ${installLocation}…`,
    ]});
    try {
      // Use packageDir as cwd so the `cd ...` prefix resolves correctly.
      execSync(cmd, { cwd: packageDir, stdio: 'pipe', shell: true });
    } catch {
      // Install warnings can trip non-zero exits; the verify step below catches
      // a genuine failure.
    }
    if (!isSdkInstalled(installDir)) {
      // Halt loudly. Earlier versions returned a `{ installed: false }`
      // sentinel and trusted the caller to check it - but bin/api.js
      // didn't, so finalChecks ran with `prevSubs: { 0:'done', 1:'done',
      // 2:'done' }` and painted phantom green checkmarks over a step
      // that genuinely failed. Never silently push past a failed install.
      debug.log('install-sdk.install-failed', { installDir, cmd });
      fatalError(
        `Install didn't complete - ${bold('@restlessai/sdk')} isn't reachable from ${bold(installDirRel)}.`,
        [
          `Tried to find it walking up from ${installDir} - nothing readable in any node_modules.`,
          `Try running the command yourself, then re-run \`npx ${CLI_NAME} init\`:`,
          `  ${cmd}`,
        ],
      );
      // Unreachable: fatalError throws FatalExit.
      return { detectedLanguage, detectedFramework, guideLanguage, installed: false, wired: false };
    }
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} Package installed in ${installLocation}.`,
    ]});
  }

  // ── Sub 1: Generate API key (delegated to the caller) ────────────────────
  let prepareResult = null;
  if (prepareAccountStep) {
    prepareResult = await prepareAccountStep();
  }

  // ── Sub 2: Configure SDK ─────────────────────────────────────────────────
  //
  // Repaint the message slot immediately so the user sees the new sub-step
  // becoming active. The synchronous prep below (grep for existing wiring,
  // read guide files, build the prompt) runs on the event loop - if any of
  // it ever blocks for more than a moment, the previous sub's message would
  // otherwise stay frozen on screen and look like a hang. Past incident:
  // recursive grep over a populated node_modules took 30s+ on first install,
  // and the UI sat showing the "Added RESTLESS_KEY to .env" message the
  // whole time with no spinner.
  update({ activeSub: 2, message: [
    `  Configuring ${bold('@restlessai/sdk')} in your ${bold(detectedFramework || detectedLanguage)} code…`,
  ]});
  // We deliberately do NOT short-circuit the AI even when the SDK looks
  // wired in already. Three real failure modes from the "already wired"
  // shortcut bit us in a row:
  //   1. Raw grep matched on stray comments / test fixtures - skipped a
  //      legitimately-needed wiring pass.
  //   2. Hoisted package in monorepo workspaces produced a false
  //      "installed=false" verdict; downstream was off by one.
  //   3. A partial / corrupted wiring (init present, callback missing)
  //      can satisfy hasInit() but still be unusable.
  //
  // Cost: ~30-60s of AI time on re-runs that genuinely had nothing to
  // do. The AI is told to no-op if it finds a real wiring already in
  // place, so the bill is just turn-budget, not duplicate code.
  // `preExistingWiring` is purely informational - feeds the prompt so
  // the AI knows what it's looking at - and shapes the success message
  // at the end.
  const preExistingWiring = isSdkWired(installDir, detectedLanguage);
  const inlineMode = ctx.keyDelivery === 'inline';
  debug.log('install-sdk.pre-existing-wiring', { preExistingWiring, installDir });

  // Next.js needs a fundamentally different wiring than the middleware /
  // plugin model the guide's Express/Fastify/Koa sections describe: wrap App
  // Router route handlers with `@restlessai/sdk/next`, and NEVER touch the
  // middleware file (`middleware.ts` / `proxy.ts`). Detect the layout up
  // front so we can (a) fail fast when there's nothing to wrap, (b) hand the
  // AI the exact files, and (c) reject a middleware wiring in the gate below.
  const nextInfo = detectNext(installDir);
  // Trigger the Next.js path only on corroborated evidence: actual App/Pages
  // routing files, a Next middleware file, or a Next framework label from
  // detection. A bare `next` dependency alone (common in monorepo packages
  // that don't actually serve the API through Next) must NOT hijack the flow.
  const isNext =
    nextInfo.router !== null ||
    nextInfo.middlewareFiles.length > 0 ||
    isNextFramework(detectedFramework);
  debug.log('install-sdk.next-detect', {
    isNext,
    router: nextInfo.router,
    routeHandlers: nextInfo.routeHandlerFiles.length,
    middlewareFiles: nextInfo.middlewareFiles,
  });

  if (isNext && nextInfo.routeHandlerFiles.length === 0) {
    // Nothing to wrap. The only place left to put capture would be the
    // middleware file - which is exactly the crash we're guarding against -
    // so fail loudly with a clear message instead of emitting broken code.
    const mwList = nextInfo.middlewareFiles.map((f) => bold(f)).join(', ')
      || `${bold('middleware.ts')} / ${bold('proxy.ts')}`;
    debug.log('install-sdk.next-no-handlers', { installDir, middlewareFiles: nextInfo.middlewareFiles });
    fatalError(
      "We couldn't wire the SDK into this Next.js project.",
      [
        `The Restless SDK captures traffic by wrapping App Router route handlers`,
        `(${bold('app/**/route.ts')}) or Pages Router API routes (${bold('pages/api/**')}),`,
        `but we found none under ${installLocation}.`,
        '',
        `It must NOT go in your Next middleware (${mwList}) - that runs on the Edge`,
        `runtime and crashes with a PageSignatureError.`,
        '',
        `Add at least one route handler, then re-run \`npx ${CLI_NAME} init\`.`,
      ],
    );
    // Unreachable: fatalError throws FatalExit.
    return { detectedLanguage, detectedFramework, guideLanguage, installed: true, wired: false };
  }

  // The wiring gate: on Next.js "wired" means a handler-side wiring exists
  // AND no middleware file was touched; elsewhere any factory-call file counts.
  const wiredNow = () =>
    isNext
      ? nextWiringStatus(installDir, nextInfo, detectedLanguage).ok
      : isSdkWired(installDir, detectedLanguage);

  // Load the setup-sdk prompt once; retries re-use the base and append an
  // escalating coda telling the AI it must actually call Edit/Write.
  const guidePath = path.join(pkgRoot, 'docs', 'sdks', `${guideLanguage}.md`);
  const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
  const setupSection = guide.split(/^## Setup\n/m)[1]?.split(/^## Verify\n/m)[0] || guide;
  const basePrompt = loadPrompt('setup-sdk', {
    language: detectedLanguage,
    framework: detectedFramework || detectedLanguage,
    guide: setupSection,
  });

  // For Next.js, append the concrete file list and the hard "never touch
  // middleware" rule on top of the guide. The guide's Next.js section
  // explains the wrap pattern; this coda pins it to THIS project's files.
  const mwLabels = nextInfo.middlewareFiles.length
    ? nextInfo.middlewareFiles.map((f) => `\`${f}\``).join(', ')
    : '`middleware.ts` / `proxy.ts`';
  const nextCoda = isNext
    ? `\n\n## This is a Next.js ${nextInfo.router === 'pages' ? 'Pages Router' : 'App Router'} project (READ THIS)\n\n` +
      `Wire capture by WRAPPING route handlers with \`@restlessai/sdk/next\`. Do NOT register middleware.\n` +
      `1. Create one shared client module (e.g. \`lib/restless.ts\` next to the routes):\n` +
      `   \`\`\`ts\n` +
      `   import restless from '@restlessai/sdk/next';\n` +
      `   export const client = restless(process.env.RESTLESS_KEY);\n` +
      `   export const wrap = client.setup(async (req) => ({ /* apiKey, owner */ }));\n` +
      `   \`\`\`\n` +
      `   \`client.setup(cb)\` returns a handler-wrapper \`(handler) => handler\` - it is NOT middleware.\n` +
      `2. In each route file, wrap every exported HTTP handler with \`wrap(...)\`:\n` +
      `   \`\`\`ts\n` +
      `   export const GET = wrap(existingGetHandler);\n` +
      `   export const POST = wrap(existingPostHandler);\n` +
      `   \`\`\`\n` +
      `   Route handler files to wrap:\n` +
      nextInfo.routeHandlerFiles.map((f) => `   - \`${f}\``).join('\n') + `\n` +
      `3. HARD RULE: do NOT edit ${mwLabels}. Next hands middleware a request whose \`.request\` getter ` +
      `throws PageSignatureError (E394), and middleware runs on the Edge runtime where an \`owner.enrich\` ` +
      `DB lookup can't run. If a previous attempt wired the SDK into a middleware/proxy file, REMOVE it.\n` +
      `4. Import from \`@restlessai/sdk/next\` (NOT bare \`@restlessai/sdk\`) and pass \`process.env.RESTLESS_KEY\`.`
    : '';

  // The AI's job is to wire the SDK into the right entry file with
  // sentinel-bracketed comments and `process.env.RESTLESS_KEY` as a
  // placeholder. The CLI takes ownership of the init line afterwards
  // (canonicalizeSdkBlock below) so the AI never has to reason about
  // env loaders or key delivery modes.
  //
  // `attemptNum` 1 = first pass (base prompt). 2 = blind retry with a
  // "you didn't write — you MUST call Edit" coda. 3 = retry with a
  // user-supplied entry file path baked in.
  async function runSetupAi(attemptNum, userHint = null) {
    let prompt = basePrompt + nextCoda;
    if (attemptNum > 1 && isNext) {
      // Next retries: the failure is either "wired the middleware" or "didn't
      // wrap any handler". Tell the AI exactly which, so it can correct.
      const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
      if (status.wiredMiddleware.length) {
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `Your previous attempt wired the SDK into ${status.wiredMiddleware.map((f) => `\`${f}\``).join(', ')}, ` +
          `which is a Next.js middleware file. That crashes at runtime with PageSignatureError (E394). ` +
          `REMOVE the SDK from that file, then wrap the route handlers above with \`wrap(...)\` from \`@restlessai/sdk/next\`.`;
      } else {
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `Your previous attempt did not wrap any route handlers. You MUST use the Edit (or Write) tool ` +
          `to wrap the exported handlers in the route files listed above with \`wrap(...)\` from ` +
          `\`@restlessai/sdk/next\`. Producing text describing the change is not enough — apply it.`;
      }
    } else if (attemptNum > 1) {
      prompt += `\n\n## Retry context (READ THIS)\n\n` +
        `Your previous attempt produced commentary but did not modify any files. ` +
        `Source files in this project still contain no \`@restlessai/sdk\` import. ` +
        `You MUST use the Edit (or Write) tool to add the SDK middleware to the user's ` +
        `server entry file. Producing text describing the change is not enough — apply it.`;
      if (userHint) {
        prompt += `\n\nThe user has told us the server entry file is at: \`${userHint}\`. ` +
          `Open that file with Read first, then use Edit to wire the SDK in there.`;
      } else {
        prompt += `\n\nIf you couldn't find the entry file before, search again. Try these names ` +
          `at the project root and one level deep: \`server.{js,ts,mjs,cjs}\`, \`index.{js,ts,mjs,cjs}\`, ` +
          `\`app.{js,ts,mjs,cjs}\`, \`main.{js,ts,mjs,cjs}\`, plus the same inside \`src/\`. ` +
          `If \`package.json\` has a "main" or "start" script pointing at a file, use that one.`;
      }
    }
    debug.log('install-sdk.ai-attempt', { attempt: attemptNum, hint: userHint || null });
    try {
      await runAI(prompt, installDir, { setSpinner });
    } catch (err) {
      // Don't bail on a per-attempt error — the retry loop is the recovery
      // path. The final `fatalError` below covers the case where every
      // attempt either errored or produced no write.
      debug.log('install-sdk.ai-error', { attempt: attemptNum, message: err.message });
    }
  }

  // Always run the AI - no "looks wired, skip" shortcut. The AI is
  // told (in the prompt) to leave an existing complete wiring alone.
  // The retry loop below catches "AI didn't write" cases regardless of
  // whether wiring pre-existed.
  if (preExistingWiring) {
    update({ activeSub: 2, message: [
      `  Re-checking the ${bold('@restlessai/sdk')} wiring in your ${bold(detectedFramework || detectedLanguage)} code.`,
      dim(`  ${orange(aiTool)} is looking at what's there and adding anything missing.`),
    ]});
  } else if (isNext) {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk/next')} into your ${bold(detectedFramework || 'Next.js')} routes.`,
      dim(`  ${orange(aiTool)} is wrapping your route handlers - it won't touch middleware.`),
    ]});
  } else {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk')} into your ${bold(detectedFramework || detectedLanguage)} code.`,
      dim(`  ${orange(aiTool)} is reading your server file and registering the middleware before routes.`),
    ]});
  }

  await runSetupAi(1);

  // Retry loop: if the first pass produced no write AND the SDK isn't
  // wired in (i.e. the AI didn't either fix it OR confirm a pre-
  // existing wiring), escalate. Attempt 2 is a blind retry with a
  // stronger prompt; attempt 3 asks the user for the entry-file path
  // and bakes it in. After that, we give up and bail.
  {
    let attempt = 1;
    while (!wiredNow() && attempt < 3) {
      attempt++;
      if (isNext) {
        // Next.js retries stay blind - there's no single "entry file" to ask
        // about; the coda already names the exact route files to wrap and the
        // middleware files to leave alone.
        const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
        update({ activeSub: 2, message: status.wiredMiddleware.length
          ? [
            `  ${yellow('⚠')} ${orange(aiTool)} wired the SDK into ${bold(status.wiredMiddleware[0])} (Next middleware). Trying again.`,
            dim('  Telling it to move the wiring onto the route handlers instead.'),
          ]
          : [
            `  ${yellow('⚠')} ${orange(aiTool)} finished without wrapping any route handlers. Trying again.`,
            dim('  Giving it an explicit instruction to wrap the routes this time.'),
          ]});
        await runSetupAi(attempt);
      } else if (attempt === 2) {
        update({ activeSub: 2, message: [
          `  ${yellow('⚠')} ${orange(aiTool)} finished without writing to any source file. Trying again.`,
          dim('  Giving it an explicit instruction to use the Edit tool this time.'),
        ]});
        await runSetupAi(2);
      } else {
        // Attempt 3: ask the user where the entry file lives.
        update({ activeSub: 2, message: [
          `  ${yellow('⚠')} Two passes done and the SDK still isn't wired in.`,
          dim("  Sometimes the AI can't locate the right entry file."),
          dim('  Point us at it and we\'ll try once more.'),
          '',
          dim('  e.g. src/server.ts, index.js, app.js'),
          dim('  Press Enter to skip and let us try blind one more time.'),
        ]});
        const raw = (await ask('  Entry file path: ')).trim();

        // Light sanity check. If the user typed a path that doesn't exist,
        // mention it and continue without the hint — better than passing
        // a bogus path to the AI.
        let validatedHint = null;
        if (raw) {
          const abs = path.isAbsolute(raw) ? raw : path.join(installDir, raw);
          if (fs.existsSync(abs)) {
            validatedHint = path.relative(installDir, abs) || raw;
          } else {
            update({ activeSub: 2, message: [
              `  ${yellow('⚠')} ${cyan(raw)} doesn't exist under ${bold(installDirRel)}. Trying without the hint.`,
            ]});
          }
        }

        update({ activeSub: 2, message: [
          validatedHint
            ? `  Retrying with hint: ${cyan(validatedHint)}`
            : `  Retrying one more time.`,
        ]});
        await runSetupAi(3, validatedHint);
      }
    }
  }

  const nowWired = wiredNow();
  debug.log('install-sdk.now-wired', { nowWired, installDir, isNext });

  if (!nowWired) {
    // Hard stop. Every downstream step (test-setup, redaction, setup-account)
    // assumes the SDK is wired in. Bail loudly instead of pushing the user
    // into a test step that can never succeed.
    debug.log('install-sdk.gave-up', { installDir, language: detectedLanguage, isNext });
    if (isNext) {
      // Distinguish "wired the wrong place" from "wrote nothing" so the
      // manual-fix advice is actionable.
      const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
      const detail = status.wiredMiddleware.length
        ? [
          `${aiTool} kept wiring the SDK into ${status.wiredMiddleware.map((f) => bold(f)).join(', ')},`,
          `a Next.js middleware file. That crashes with PageSignatureError on the Edge runtime.`,
        ]
        : [`${aiTool} read your project but never wrapped a route handler, even after retries.`];
      fatalError(
        "We couldn't wire the SDK into your Next.js routes automatically.",
        [
          ...detail,
          `Wrap your App Router route handlers by hand following docs/sdks/${guideLanguage}.md`,
          `(the Next.js section), then re-run \`npx ${CLI_NAME} init\`.`,
          '',
          'Re-running with --debug helps us see exactly what the AI did.',
        ],
      );
      return { detectedLanguage, detectedFramework, guideLanguage, installed: true, wired: false };
    }
    fatalError(
      "We couldn't wire the SDK into your code automatically.",
      [
        `${aiTool} read your project but never modified a source file, even after retries.`,
        `Install the SDK by hand following docs/sdks/${guideLanguage}.md,`,
        `then re-run \`npx ${CLI_NAME} init\`.`,
        '',
        'Re-running with --debug helps us see exactly what the AI did.',
      ],
    );
    // Unreachable: fatalError throws FatalExit.
    return { detectedLanguage, detectedFramework, guideLanguage, installed: true, wired: false };
  }

  // CLI takes over: canonicalize the init line based on ctx.sdkLineSpec.
  // Runs every time (fresh install AND re-runs) so a previous broken
  // state can be repaired without another AI call.
  const canon = canonicalizeSdkBlock(ctx);
  ctx.sdkBlockPresent = true;
  ctx.entryFile = canon.file;

  const headerLine = preExistingWiring
    ? `  ${green('✓')} SDK wiring confirmed - left existing setup alone.`
    : `  ${green('✓')} SDK installed and configured.`;
  const baseMsg = [headerLine];
  if (inlineMode && canon.mode === 'canonicalized') {
    baseMsg.push(dim(`  Inlined the API key in ${bold(canon.file)} - testing only, don't commit.`));
  }
  update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: baseMsg });

  return {
    detectedLanguage,
    detectedFramework,
    guideLanguage,
    installed: true,
    wired: wiredNow(),
    installDir,
    // Surface whatever the caller's prepareAccountStep produced so api.js
    // can use the apiKey / projectId / setupKey downstream (testSetup,
    // setupAccount, etc.).
    prepareResult,
  };
}
