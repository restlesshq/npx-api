import fs from 'fs';
import path from 'path';
import { startSpinner } from './ui.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const pkgRoot = path.resolve(__dirname, '..');

// Default provider - swap this out or make it configurable
import claude from '../providers/claude.js';
import codex from '../providers/codex.js';

const PROVIDERS = { claude, codex };
let provider = claude;

export function setProvider(p) {
  if (typeof p === 'string') {
    const next = PROVIDERS[p];
    if (!next) throw new Error(`Unknown AI provider: ${p}`);
    provider = next;
    return;
  }
  provider = p;
}

export function getProvider() {
  return provider;
}

/**
 * Normalize a status value to a string for the standalone spinner (which
 * only shows one line). Objects become "phase - detail" or "detail" alone.
 */
function statusToString(info) {
  if (!info) return '';
  if (typeof info === 'string') return info;
  if (info.phase && info.detail) return `${info.phase}: ${info.detail}`;
  return info.detail || info.phase || '';
}

// Prepended to every AI prompt. The agent has Bash access and tends to
// reach for `python -c '...'` or `python3 -m json.tool` for tasks Node
// does natively - that fails silently on machines without python (lots
// of fresh Macs, most Windows boxes, minimal Docker images, etc.). Pin
// it to interpreters the user is guaranteed to have, given they're
// running a Node CLI: Node itself, plus the standard POSIX text tools.
const TOOL_CONSTRAINTS = `## Environment

You're running in a Node-based CLI on the user's machine. Bash is available, but:

- **Do NOT use \`python\`, \`python3\`, \`pip\`, \`ruby\`, \`gem\`, \`perl\`, or any other interpreter the user might not have installed.** Many users (especially on fresh macOS, Windows, minimal Docker images) won't have python or ruby - reaching for them is a silent failure waiting to happen.
- **For JSON / text manipulation, use Node** (\`node -e "..."\` is fine), or POSIX tools that ship with the OS: \`grep\`, \`sed\`, \`awk\`, \`find\`, \`cat\`, \`head\`, \`tail\`. Do not assume \`jq\` is installed either.
- **Do not invoke a language toolchain you weren't asked to use.** If the user is on a JavaScript project, don't shell out to \`python -m json.tool\` to validate JSON - parse it with \`node -e\`.

`;

export async function runAI(prompt, cwd, { setSpinner } = {}) {
  const standalone = !setSpinner;
  const initial = { phase: 'Analyzing', detail: 'Thinking…' };
  const spinner = standalone ? startSpinner(statusToString(initial)) : null;

  if (setSpinner) setSpinner(initial);

  // Prepend the environment-constraint preamble to every prompt so we
  // don't have to repeat the rule in each individual prompts/*.md file.
  const fullPrompt =
    typeof prompt === 'string' ? TOOL_CONSTRAINTS + prompt : prompt;

  const result = await provider.run(fullPrompt, cwd, {
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
