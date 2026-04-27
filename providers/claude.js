import { query } from '@anthropic-ai/claude-agent-sdk';
import * as debug from '../lib/debug.js';

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

export default {
  name: 'claude',

  async run(prompt, cwd, { onStatus } = {}) {
    let result = '';
    debug.log('ai.run.start', { provider: 'claude', cwd, promptChars: prompt?.length ?? 0, prompt });
    for await (const message of query({
      prompt,
      options: {
        maxTurns: 30,
        allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write'],
        cwd,
      }
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            result += block.text;
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            debug.log('ai.text', { text: block.text });
          } else if (block.type === 'tool_use') {
            onStatus?.(describeToolUse(block.name, block.input));
            debug.log('ai.tool_use', { tool: block.name, input: block.input });
          }
        }
      }
    }
    debug.log('ai.run.end', { provider: 'claude', resultChars: result.length });
    return result;
  },
};
