import { query } from '@anthropic-ai/claude-agent-sdk';

function describeToolUse(toolName, input) {
  switch (toolName) {
    case 'Read': return `Reading ${input.file_path?.split('/').pop() || 'file'}`;
    case 'Glob': return `Searching for ${input.pattern || 'files'}`;
    case 'Grep': return `Searching for "${input.pattern?.slice(0, 30) || 'pattern'}"`;
    case 'Write': return `Writing ${input.file_path?.split('/').pop() || 'file'}`;
    case 'Edit':  return `Editing ${input.file_path?.split('/').pop() || 'file'}`;
    case 'Bash': {
      const cmd = input.command || '';
      if (cmd.startsWith('npm ')) return `Running ${cmd.split('&&')[0].trim()}`;
      if (cmd.startsWith('pip ')) return `Running ${cmd.split('&&')[0].trim()}`;
      if (cmd.startsWith('gem ')) return `Running ${cmd.split('&&')[0].trim()}`;
      if (cmd.startsWith('go ')) return `Running ${cmd.split('&&')[0].trim()}`;
      if (cmd.startsWith('curl ')) return `Making request`;
      if (cmd.startsWith('cat ') || cmd.startsWith('ls ')) return `Checking files`;
      if (cmd.startsWith('mkdir ')) return `Creating directory`;
      const first = cmd.split(/\s+/)[0]?.split('/').pop() || 'command';
      return `Running ${first}`;
    }
    default: return `Working...`;
  }
}

export default {
  name: 'claude',

  async run(prompt, cwd, { onStatus } = {}) {
    let result = '';
    for await (const message of query({
      prompt,
      options: {
        maxTurns: 15,
        allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write'],
        cwd,
      }
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            result += block.text;
            onStatus?.('Thinking...');
          } else if (block.type === 'tool_use') {
            onStatus?.(describeToolUse(block.name, block.input));
          }
        }
      }
    }
    return result;
  },
};
