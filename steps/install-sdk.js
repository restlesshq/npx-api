import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, cyan, terminalPrompt } from '../lib/ui.js';

const languageAliases = {
  'node': 'javascript',
  'node.js': 'javascript',
  'nodejs': 'javascript',
  'js': 'javascript',
  'javascript (node.js)': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'python3': 'python',
  'rb': 'ruby',
  'golang': 'go',
  'csharp': 'csharp',
  'c#': 'csharp',
};

export default async function installSdk({ packageDir, rootDir, update, setSpinner, detectedLanguage, detectedFramework }) {
  // Detect language if we don't have it
  if (detectedLanguage) {
    update({ status: 'active', activeSub: 1, sub: { 0: 'done' }, message: [
      `  We know your project uses ${bold(detectedFramework || detectedLanguage)} — let's install the SDK.`,
    ]});
  } else {
    update({ status: 'active', activeSub: 0, message: [
      '  Let\'s figure out what language your project uses.',
    ] });

    const langResult = await runAI(loadPrompt('detect-language'), packageDir, { setSpinner });

    try {
      const jsonMatch = langResult.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        detectedLanguage = parsed.language?.toLowerCase() || null;
        detectedFramework = parsed.framework || null;
      }
    } catch {}

    if (!detectedLanguage) detectedLanguage = 'javascript';

    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  Your project uses ${bold(detectedFramework || detectedLanguage)}.`,
    ]});
  }

  // Figure out the install command
  const guideLanguage = languageAliases[detectedLanguage] || detectedLanguage;
  // TODO: once published to npm, change to npm install @restless/sdk
  const installCommands = {
    javascript: 'npm install ../node-sdk --save',
    typescript: 'npm install ../node-sdk --save',
    python: 'pip install readmeio',
    ruby: 'gem install readmeio',
    go: 'go get github.com/readmeio/readmeio',
  };
  const installCmd = installCommands[guideLanguage] || `npm install ../node-sdk --save`;

  update({ sub: { 0: 'done' }, activeSub: 1, message: [] });

  const cmd = await terminalPrompt(installCmd);

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    `  Installing...`,
  ]});

  try {
    execSync(cmd, { cwd: packageDir, stdio: 'pipe' });
  } catch {
    // Install warnings may cause non-zero exit; continue anyway
  }

  update({ sub: { 0: 'done', 1: 'done' }, message: [
    `  ${green('✓')} Package installed. Now configuring...`,
  ]});

  return { detectedLanguage, detectedFramework, guideLanguage };
}
