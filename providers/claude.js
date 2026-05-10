import { query } from '@anthropic-ai/claude-agent-sdk';
import * as debug from '../lib/debug.js';
import { isInsideRoot, getGitRoot } from '../lib/pathGuard.js';

// AI tool inputs (especially Write/Edit) carry full file contents that
// blow up the debug log size. Truncate every string field at the source
// so we still see *what* the AI did without dragging the body along.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_TOOL_INPUT_TOTAL = 2000;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function truncatedToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = truncate(v, MAX_TOOL_INPUT_FIELD);
    else out[k] = v;
  }
  // Belt-and-suspenders: if the trimmed object is still huge (lots of
  // small fields), cap the serialized form as well.
  const json = JSON.stringify(out);
  if (json.length <= MAX_TOOL_INPUT_TOTAL) return out;
  return { _truncated: json.slice(0, MAX_TOOL_INPUT_TOTAL) + `…(+${json.length - MAX_TOOL_INPUT_TOTAL} chars)` };
}

/**
 * Map a tool_use block into {phase, detail}:
 *  - phase: high-level human category (e.g. "Looking for files")
 *  - detail: the specific tool call (e.g. 'Glob *.{js,ts}')
 *
 * Phase is stable across many calls of the same category; detail changes
 * with every call.
 */
function describeToolUse(toolName, input) {
  switch (toolName) {
    case 'Read':
      return {
        phase: 'Reading files',
        detail: `Read ${input.file_path || 'file'}`,
      };
    case 'Glob':
      return {
        phase: 'Looking for files',
        detail: `Glob ${input.pattern || '*'}${input.path ? ` in ${input.path}` : ''}`,
      };
    case 'Grep': {
      const pat = (input.pattern || '').slice(0, 40);
      const glob = input.glob ? ` --include="${input.glob}"` : '';
      return {
        phase: 'Searching the code',
        detail: `Grep "${pat}"${glob}`,
      };
    }
    case 'Write':
      return {
        phase: 'Writing files',
        detail: `Write ${input.file_path || 'file'}`,
      };
    case 'Edit':
      return {
        phase: 'Editing files',
        detail: `Edit ${input.file_path || 'file'}`,
      };
    case 'Bash': {
      // Claude often prefixes commands with a `# comment` line and joins pipes
      // with real newlines. Flatten to one line so the spinner detail stays
      // on a single visual row, and strip leading comments.
      const raw = (input.command || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .join(' ');
      let phase = 'Running commands';
      if (/^(npm|pnpm|yarn|bun|pip|gem|go|cargo)\s/.test(raw)) phase = 'Installing packages';
      else if (/^(ls|cat|find|head|tail)\s/.test(raw)) phase = 'Checking files';
      else if (/^curl\s/.test(raw)) phase = 'Making requests';
      else if (/^mkdir\s/.test(raw)) phase = 'Creating directories';
      return {
        phase,
        detail: `Bash ${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}`,
      };
    }
    default:
      return {
        phase: 'Working',
        detail: toolName,
      };
  }
}

/**
 * Pull every absolute path token out of a Bash command. Best-effort:
 * matches `/`-prefixed POSIX paths separated by whitespace, quotes, or
 * shell metacharacters. We use this to refuse Bash invocations that
 * touch a path outside the git root - it isn't perfect (a clever AI
 * could obfuscate via env-var indirection or `eval`) but it stops the
 * common cases (cd, cat, mv with absolute paths above the root).
 */
function extractAbsPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const out = [];
  const re = /(?<![\w\\])(\/[^\s"';|&<>()`$]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1]);
  return out;
}

/**
 * `canUseTool` callback for the Claude Agent SDK. Hard-rejects any
 * Write / Edit / NotebookEdit whose target path is outside the git
 * root, plus any Bash command that mentions an absolute path outside
 * the git root. Defense in depth alongside the safe fs helpers - if
 * the AI dreams up a path we'd write somewhere bad, this layer kills
 * the call before it reaches disk.
 */
function makeCanUseTool(gitRoot) {
  return async (toolName, input) => {
    if (!gitRoot) return { behavior: 'allow' };

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const fp = input?.file_path || input?.notebook_path;
      if (typeof fp === 'string' && fp && !isInsideRoot(fp, gitRoot)) {
        debug.log('ai.tool.denied', { tool: toolName, path: fp, reason: 'outside-git-root' });
        return {
          behavior: 'deny',
          message:
            `${toolName} ${fp} is outside the git root ${gitRoot}. ` +
            `The CLI never lets writes escape the repository it was invoked from. ` +
            `Use a path inside ${gitRoot} instead.`,
        };
      }
    }
    if (toolName === 'Bash') {
      for (const p of extractAbsPaths(input?.command)) {
        if (!isInsideRoot(p, gitRoot)) {
          debug.log('ai.tool.denied', { tool: 'Bash', path: p, reason: 'outside-git-root' });
          return {
            behavior: 'deny',
            message:
              `Bash command references ${p}, which is outside the git root ${gitRoot}. ` +
              `Refusing to run; nothing the CLI does is allowed to escape the repo.`,
          };
        }
      }
    }
    return { behavior: 'allow' };
  };
}

export default {
  name: 'claude',

  async run(prompt, cwd, { onStatus } = {}) {
    let result = '';
    const gitRoot = getGitRoot();
    debug.log('ai.run.start', {
      provider: 'claude',
      cwd,
      gitRoot,
      promptChars: prompt?.length ?? 0,
      // Just the first slice - full prompt is reproducible from
      // prompts/*.md + the variables, so don't send the whole thing.
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });
    for await (const message of query({
      prompt,
      options: {
        maxTurns: 30,
        allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write'],
        cwd,
        canUseTool: makeCanUseTool(gitRoot),
      }
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            result += block.text;
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            debug.log('ai.text', { text: truncate(block.text, MAX_AI_TEXT) });
          } else if (block.type === 'tool_use') {
            onStatus?.(describeToolUse(block.name, block.input));
            debug.log('ai.tool_use', { tool: block.name, input: truncatedToolInput(block.input) });
          }
        }
      }
    }
    debug.log('ai.run.end', { provider: 'claude', resultChars: result.length });
    return result;
  },
};
