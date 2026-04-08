import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, cyan, terminalRunScreen } from '../lib/ui.js';
import { SITE_URL } from '../lib/config.js';

export default async function testSetup({ packageDir, rootDir, update, setSpinner, domain, projectId, setupKey }) {
  update({ status: 'active', activeSub: 0, message: [
    '  Let\'s find a good endpoint to test with.',
  ]});

  // Detect localhost port
  let localPort = '3000';
  try {
    const files = execSync('find . -maxdepth 2 -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.rb" | head -20', { cwd: packageDir, encoding: 'utf8' });
    for (const file of files.trim().split('\n').filter(Boolean)) {
      try {
        const content = fs.readFileSync(path.join(packageDir, file), 'utf8');
        const portMatch = content.match(/\.listen\(\s*(\d{4,5})\s*[,)]/) || content.match(/PORT\s*(?:=|:)\s*(\d{4,5})/);
        if (portMatch) {
          localPort = portMatch[1];
          break;
        }
      } catch {}
    }
  } catch {}
  const localBase = `http://localhost:${localPort}`;

  // Ask AI to generate a realistic curl command from the OAS
  let curlCommand = `curl -sS ${localBase}/`;
  try {
    const aiResult = await runAI(loadPrompt('find-test-endpoint'), rootDir, { setSpinner });
    const jsonMatch = aiResult.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      curlCommand = parsed.curl.replace(/BASE_URL_HERE/g, localBase);
    }
  } catch {}

  update({ sub: { 0: 'done' }, activeSub: 1, message: [] });

  // Poll config for live log display (credentials sent in POST body, never in URL)
  const pollConfig = projectId ? {
    url: `${SITE_URL}/api/logs/poll`,
    projectId,
    setupKey,
  } : null;

  // Full-screen terminal with log polling in top half
  const result = await terminalRunScreen(curlCommand, {
    pollConfig,
    onRun: (cmd) => {
      try {
        let output = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
        // Pretty-print JSON responses
        try { output = JSON.stringify(JSON.parse(output), null, 2); } catch {}
        return { output, success: true };
      } catch (err) {
        return { output: err.stderr || err.stdout || err.message || '', success: false };
      }
    },
  });

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    result.success
      ? `  ${green('✓')} API test passed.`
      : `  ${dim('⚠')} Couldn't reach the server — make sure it's running.`,
  ]});
}
