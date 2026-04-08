import fs from 'fs';
import path from 'path';
import { runAI, loadPrompt, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, red } from '../lib/ui.js';

export default async function setupSdk({ packageDir, rootDir, update, setSpinner, detectedLanguage, detectedFramework, guideLanguage }) {
  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
    `  Now we need to wire up the SDK in your ${bold(detectedFramework || detectedLanguage)} code.`,
  ]});

  const guidePath = path.join(pkgRoot, 'docs', 'sdks', `${guideLanguage}.md`);
  const hasGuide = fs.existsSync(guidePath);
  const guide = hasGuide ? fs.readFileSync(guidePath, 'utf8') : '';
  const setupSection = guide ? guide.split('## Setup')[1]?.split('## Verify')[0] || guide : '';

  const prompt = loadPrompt('setup-sdk', {
    language: detectedLanguage,
    framework: detectedFramework || detectedLanguage,
    guide: setupSection,
  });

  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
    `  Configuring the SDK in your ${bold(detectedFramework || detectedLanguage)} code...`,
    dim('  Claude is reading your source and wiring up the middleware.'),
  ]});

  try {
    await runAI(prompt, packageDir, { setSpinner });

    // Verify the SDK was actually wired up
    let verified = false;
    try {
      const { execSync } = await import('child_process');
      const grepResult = execSync(`grep -r "@restless/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`, { cwd: packageDir, encoding: 'utf8' });
      const sourceFiles = grepResult.trim().split('\n').filter(f => f && !f.includes('node_modules'));
      verified = sourceFiles.length > 0;
    } catch {}

    if (verified) {
      update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
        `  ${green('✓')} SDK installed and configured.`,
      ]});
    } else {
      update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
        `  ${red('⚠')} SDK package installed, but code may not have been configured.`,
        dim(`  Check your server file and add the SDK middleware manually if needed.`),
      ]});
    }
  } catch (err) {
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${red('✗')} Failed to configure SDK: ${err.message}`,
      dim('  You may need to wire up the SDK manually. See docs/sdks/ for the guide.'),
      dim('  Press Enter to continue.'),
    ]});

    const { ask } = await import('../lib/ui.js');
    await ask('');

    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
      `  ${red('⚠')} SDK installed but configuration failed. Wire it up manually.`,
    ]});
  }
}
