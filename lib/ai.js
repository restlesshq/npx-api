import fs from 'fs';
import path from 'path';
import { startSpinner } from './ui.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const pkgRoot = path.resolve(__dirname, '..');

// Default provider — swap this out or make it configurable
import claude from '../providers/claude.js';
let provider = claude;

export function setProvider(p) {
  provider = p;
}

export function getProvider() {
  return provider;
}

export async function runAI(prompt, cwd, { setSpinner } = {}) {
  const standalone = !setSpinner;
  const spinner = standalone ? startSpinner('Thinking...') : null;

  if (setSpinner) setSpinner('Thinking...');

  const result = await provider.run(prompt, cwd, {
    onStatus(text) {
      if (spinner) spinner.update(text);
      if (setSpinner) setSpinner(text);
    },
  });

  if (spinner) spinner.stop();
  if (setSpinner) setSpinner('');

  return result;
}

export function loadPrompt(name, vars = {}) {
  const promptPath = path.join(pkgRoot, 'prompts', `${name}.md`);
  let content = fs.readFileSync(promptPath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
