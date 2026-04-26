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

/**
 * Normalize a status value to a string for the standalone spinner (which
 * only shows one line). Objects become "phase — detail" or "detail" alone.
 */
function statusToString(info) {
  if (!info) return '';
  if (typeof info === 'string') return info;
  if (info.phase && info.detail) return `${info.phase}: ${info.detail}`;
  return info.detail || info.phase || '';
}

export async function runAI(prompt, cwd, { setSpinner } = {}) {
  const standalone = !setSpinner;
  const initial = { phase: 'Analyzing', detail: 'Thinking…' };
  const spinner = standalone ? startSpinner(statusToString(initial)) : null;

  if (setSpinner) setSpinner(initial);

  const result = await provider.run(prompt, cwd, {
    onStatus(info) {
      // info is either a string (legacy) or { phase, detail }.
      if (spinner) spinner.update(statusToString(info));
      if (setSpinner) setSpinner(info);
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
