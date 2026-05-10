import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, red, cyan, yellow, ask, terminalPrompt, waitForKey } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { CLI_NAME } from '../lib/config.js';
import { safeWriteFileSync } from '../lib/pathGuard.js';
import * as jsWriter from '../lib/sdk-writers/javascript.js';

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
 * Walk the install dir for the source file the AI just wired into.
 * Today this is the same grep `isSdkWired` uses; we pick the first
 * match (typical single-entry projects). Returns absolute path or null.
 */
function findWiredSourceFile(installDir) {
  try {
    const out = execSync(
      `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    const files = out.trim().split('\n').filter((f) => f && !f.includes('node_modules'));
    return files.length ? path.join(installDir, files[0].replace(/^\.\//, '')) : null;
  } catch {
    return null;
  }
}

/**
 * After the AI writes the sentinel-bracketed SDK block, the CLI takes
 * ownership of the init line: it rewrites the init arg to match
 * `getSdkLineSpec(ctx)` (literal / env-ref / no-arg). Auth extraction
 * and project.id (the AI's domain-specific work) are preserved.
 *
 * Falls back to the legacy regex inliner when the AI forgot the
 * sentinels - covers older installs and AI runs that ignore the
 * sentinel instruction.
 */
function canonicalizeSdkBlock(ctx) {
  const writer = getSdkWriter(ctx.language);
  const file = findWiredSourceFile(ctx.installDir);
  if (!file) return { mode: 'no-source', file: null };
  const content = fs.readFileSync(file, 'utf8');
  const found = writer.parse(content);
  if (found) {
    const next = writer.canonicalizeInitArg(content, ctx);
    if (next !== content) safeWriteFileSync(file, next);
    return { mode: 'canonicalized', file: path.relative(ctx.installDir, file) };
  }
  // Legacy fallback: AI didn't add sentinels. Use the old inliner so we at
  // least get the literal key in for inline mode. Future runs after the
  // user re-runs setup will get sentinel-wrapped blocks.
  if (ctx.keyDelivery === 'inline' && ctx.apiKey) {
    const touched = inlineKeyIntoSource(ctx.installDir, ctx.apiKey);
    if (touched.length) return { mode: 'legacy-inline', file: touched[0] };
  }
  return { mode: 'unwrapped', file: path.relative(ctx.installDir, file) };
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
 * Check whether `@restlessai/sdk` is already imported anywhere in the user's
 * source. Used to skip the setup AI pass when someone's re-running the CLI.
 */
function isSdkWired(packageDir) {
  try {
    const out = execSync(
      `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`,
      { cwd: packageDir, encoding: 'utf8' },
    );
    return out.trim().split('\n').filter((f) => f && !f.includes('node_modules')).length > 0;
  } catch {
    return false;
  }
}

function isSdkInstalled(packageDir) {
  // Check for a readable package.json - not just that the directory exists.
  // A bare existsSync would return true for a broken symlink (e.g. left
  // behind after a local link was renamed), making the install step skip
  // without ever replacing the dangling link, and then `require()`
  // explodes at runtime.
  const candidates = [
    path.join(packageDir, 'node_modules', '@restlessai', 'sdk', 'package.json'),
    path.join(packageDir, 'node_modules', 'restlessai', 'package.json'),
  ];
  return candidates.some((p) => {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
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
    const out = execSync(
      `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    const files = out.trim().split('\n').filter((f) => f && !f.includes('node_modules'));
    const literal = JSON.stringify(apiKey);
    const TODO = '// TODO: move this out of the codebase before committing';

    const bareRequireCall = /require\(\s*['"]@restlessai\/sdk['"]\s*\)\s*\(\s*\)/;
    const bareRequireInject = /(require\(\s*['"]@restlessai\/sdk['"]\s*\)\s*\()(\s*)(\))/;

    for (const rel of files) {
      const full = path.join(installDir, rel);
      const content = fs.readFileSync(full, 'utf8');

      // Idempotent: if we already inlined this exact key, leave the file alone.
      if (content.includes(apiKey)) continue;

      // Detect a name bound to the factory itself (not the result of calling it).
      // `const x = require('@restlessai/sdk')()` is the immediate-call form -
      // `x` holds the result, not the factory, so we don't match against it.
      let factoryName = null;
      const esmMatch = content.match(/import\s+(\w+)\s+from\s+['"]@restlessai\/sdk['"]/);
      const cjsMatch = content.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]@restlessai\/sdk['"]\s*\)\s*;?\s*$/m);
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
          `Install ${bold('@restlessai/sdk')} with your package manager, then point ${cyan(aiTool)}\n` +
          `at your server file to wire the middleware in before your routes. We'll also make\n` +
          `one call to our server to generate an API key and setup token. No personal data\n` +
          `or code is sent in that call, just the public-key-style hash we use to identify\n` +
          `your project later.`,
      },
      {
        label: 'Privacy',
        body:
          `The SDK runs in your process. ${cyan(aiTool)} only reads the files it needs to\n` +
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
      update({ activeSub: 0, message: [
        `  ${red('✗')} Install didn't complete - ${bold('@restlessai/sdk')} isn't in ${bold((installDirRel === '.' ? '' : installDirRel + '/') + 'node_modules')}.`,
        dim(`  Try running the command yourself, then re-run \`npx ${CLI_NAME} setup\`.`),
      ]});
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
  const wasAlreadyWired = isSdkWired(installDir);
  const inlineMode = ctx.keyDelivery === 'inline';

  if (!wasAlreadyWired) {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk')} into your ${bold(detectedFramework || detectedLanguage)} code.`,
      dim(`  ${cyan(aiTool)} is reading your server file and registering the middleware before routes.`),
    ]});

    const guidePath = path.join(pkgRoot, 'docs', 'sdks', `${guideLanguage}.md`);
    const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
    const setupSection = guide.split(/^## Setup\n/m)[1]?.split(/^## Verify\n/m)[0] || guide;

    // The AI's job is to wire the SDK into the right entry file with
    // sentinel-bracketed comments and `process.env.RESTLESS_KEY` as a
    // placeholder. The CLI takes ownership of the init line afterwards
    // (canonicalizeSdkBlock below) so the AI never has to reason about
    // env loaders or key delivery modes.
    const prompt = loadPrompt('setup-sdk', {
      language: detectedLanguage,
      framework: detectedFramework || detectedLanguage,
      guide: setupSection,
    });

    try {
      await runAI(prompt, installDir, { setSpinner });
    } catch (err) {
      update({ activeSub: 2, message: [
        `  ${red('✗')} Configuration failed: ${err.message}`,
        dim(`  See ${bold('docs/sdks/' + guideLanguage + '.md')} and wire it up by hand.`),
        dim('  Press Enter to continue.'),
      ]});
      await ask('');
    }
  }

  const nowWired = isSdkWired(installDir);

  // CLI takes over: canonicalize the init line based on ctx.sdkLineSpec.
  // Runs every time (fresh install AND re-runs) so a previous broken
  // state can be repaired without another AI call.
  const canon = nowWired ? canonicalizeSdkBlock(ctx) : { mode: 'no-source', file: null };
  ctx.sdkBlockPresent = nowWired;
  ctx.entryFile = canon.file;

  if (!nowWired) {
    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: [
      `  ${yellow('⚠')} Package installed, but we couldn't verify the middleware wired in.`,
      dim(`  Check your server file and add ${bold('restless.setup(...)')} by hand if needed.`),
    ]});
  } else {
    const headerLine = wasAlreadyWired
      ? `  ${green('✓')} SDK is already wired into your source - leaving it alone.`
      : `  ${green('✓')} SDK installed and configured.`;
    const baseMsg = [headerLine];
    if (inlineMode && (canon.mode === 'canonicalized' || canon.mode === 'legacy-inline')) {
      baseMsg.push(dim(`  Inlined the API key in ${bold(canon.file)} - testing only, don't commit.`));
    }
    if (canon.mode === 'unwrapped') {
      baseMsg.push(dim(`  Note: ${bold(canon.file)} doesn't have managed sentinels. Re-run setup to migrate.`));
    }
    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: baseMsg });
  }

  return {
    detectedLanguage,
    detectedFramework,
    guideLanguage,
    installed: true,
    wired: isSdkWired(installDir),
    installDir,
    // Surface whatever the caller's prepareAccountStep produced so api.js
    // can use the apiKey / projectId / setupKey downstream (testSetup,
    // setupAccount, etc.).
    prepareResult,
  };
}
