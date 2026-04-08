// Child process worker for AI queries.
// Runs the Agent SDK in isolation so it can't steal the parent's stdin.
// Communicates via stdin (JSON input) and stdout (prefixed lines).

import { query } from '@anthropic-ai/claude-agent-sdk';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const { prompt, cwd } = JSON.parse(input);
    let result = '';

    for await (const message of query({
      prompt,
      options: {
        maxTurns: 1,
        allowedTools: [],
        cwd,
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            result += block.text;
            process.stdout.write('STATUS:Thinking...\n');
          }
        }
      }
    }

    process.stdout.write('RESULT:' + result.replace(/\n/g, '\nRESULT:') + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
});
