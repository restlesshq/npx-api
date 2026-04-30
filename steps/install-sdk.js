import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, red, cyan, yellow, ask, terminalPrompt, waitForKey } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { CLI_NAME } from '../lib/config.js';

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
  // Check for a readable package.json — not just that the directory exists.
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
function resolveInstallDir(packageDir, apiRootDir) {
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

export default async function installSdk({
  packageDir,
  rootDir,
  apiRootDir,
  update,
  setSpinner,
  detectedLanguage,
  detectedFramework,
  aiTool = 'Claude Code',
}) {
  const frameworkLabel = detectedFramework || detectedLanguage || 'your framework';
  const installDir = resolveInstallDir(packageDir, apiRootDir);
  const installDirRel = path.relative(packageDir, installDir) || '.';

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
          `at your server file to wire the middleware in before your routes.`,
      },
      {
        label: 'Privacy',
        body:
          `The SDK runs in your process. ${cyan(aiTool)} only reads the files it needs to\n` +
          `wire things up, and we never touch ${bold('.env')} or anything in ${bold('node_modules/')}.`,
      },
    ],
    // The terminal prompt below is the action — no separate keypress gate.
    skipWait: true,
  });

  // Sub 0 ("Generate API key") is handled by prepareAccount() before we get
  // here. If the caller didn't run it, we still want the plan UI to reflect
  // that sub 0 is complete so we don't visually skip a step.
  if (!detectedLanguage) detectedLanguage = 'javascript';
  const guideLanguage = languageAliases[detectedLanguage] || detectedLanguage;

  // ── Sub 1: Install package ───────────────────────────────────────────────
  const alreadyInstalled = isSdkInstalled(installDir);
  if (alreadyInstalled) {
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${green('✓')} ${bold('@restlessai/sdk')} is already installed in ${bold(installDirRel)} — skipping install.`,
    ]});
  } else {
    const defaultCmd = installCommands[guideLanguage] || installCommands.javascript;
    const cdPrefix = installDirRel !== '.' ? `cd ${installDirRel} && ` : '';
    // Keep the step intro visible above the prompt — just advance the cursor.
    update({ activeSub: 1 });
    const cmd = await terminalPrompt(cdPrefix + defaultCmd);

    update({ activeSub: 1, message: [
      `  Installing ${bold('@restlessai/sdk')} in ${bold(installDirRel)}…`,
    ]});
    try {
      // Use packageDir as cwd so the `cd ...` prefix resolves correctly.
      execSync(cmd, { cwd: packageDir, stdio: 'pipe', shell: true });
    } catch {
      // Install warnings can trip non-zero exits; the verify step below catches
      // a genuine failure.
    }
    if (!isSdkInstalled(installDir)) {
      update({ sub: { 0: 'done' }, activeSub: 1, message: [
        `  ${red('✗')} Install didn't complete — ${bold('@restlessai/sdk')} isn't in ${bold(installDirRel + '/node_modules')}.`,
        dim(`  Try running the command yourself, then re-run \`npx ${CLI_NAME} setup\`.`),
      ]});
      return { detectedLanguage, detectedFramework, guideLanguage, installed: false, wired: false };
    }
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${green('✓')} Package installed in ${bold(installDirRel)}.`,
    ]});
  }

  // ── Sub 2: Configure SDK ─────────────────────────────────────────────────
  if (isSdkWired(installDir)) {
    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: [
      `  ${green('✓')} SDK is already wired into your source — leaving it alone.`,
    ]});
  } else {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk')} into your ${bold(detectedFramework || detectedLanguage)} code.`,
      dim(`  ${cyan(aiTool)} is reading your server file and registering the middleware before routes.`),
    ]});

    const guidePath = path.join(pkgRoot, 'docs', 'sdks', `${guideLanguage}.md`);
    const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
    const setupSection = guide.split(/^## Setup\n/m)[1]?.split(/^## Verify\n/m)[0] || guide;

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

    if (isSdkWired(installDir)) {
      update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: [
        `  ${green('✓')} SDK installed and configured.`,
      ]});
    } else {
      update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, activeSub: 3, message: [
        `  ${yellow('⚠')} Package installed, but we couldn't verify the middleware wired in.`,
        dim(`  Check your server file and add ${bold('restless.setup(...)')} by hand if needed.`),
      ]});
    }
  }

  return {
    detectedLanguage,
    detectedFramework,
    guideLanguage,
    installed: true,
    wired: isSdkWired(installDir),
    installDir,
  };
}
