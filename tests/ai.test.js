import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAI, setProvider } from '../lib/ai.js';

// Stub provider that captures whatever runAI hands it. Lets us assert on
// the exact prompt the wrapper sends downstream without spinning up a
// real LLM.
function makeStubProvider() {
  const calls = [];
  return {
    name: 'stub',
    async run(prompt, cwd, opts) {
      calls.push({ prompt, cwd, opts });
      return 'stub-result';
    },
    calls,
  };
}

describe('runAI tool-constraints preamble', () => {
  let stub;
  beforeEach(() => {
    stub = makeStubProvider();
    setProvider(stub);
  });
  afterEach(() => {
    // Reset to the default provider for any later tests.
    setProvider('claude');
  });

  it('prepends an Environment block to the user prompt', async () => {
    await runAI('Do the thing.', '/tmp');
    expect(stub.calls).toHaveLength(1);
    const sent = stub.calls[0].prompt;
    expect(sent).toMatch(/^## Environment/);
    expect(sent).toContain('Do the thing.');
  });

  it('forbids python / pip / ruby / gem / perl in the preamble', async () => {
    await runAI('hi', '/tmp');
    const sent = stub.calls[0].prompt;
    expect(sent).toMatch(/Do NOT use[^.]*python/i);
    expect(sent).toContain('python3');
    expect(sent).toContain('pip');
    expect(sent).toContain('ruby');
    expect(sent).toContain('gem');
    expect(sent).toContain('perl');
  });

  it('points the agent at node + POSIX text tools as the allowed set', async () => {
    await runAI('hi', '/tmp');
    const sent = stub.calls[0].prompt;
    expect(sent).toContain('node -e');
    expect(sent).toContain('grep');
    expect(sent).toContain('sed');
    expect(sent).toContain('awk');
    expect(sent).toContain('find');
  });

  it("warns that jq isn't guaranteed either", async () => {
    await runAI('hi', '/tmp');
    expect(stub.calls[0].prompt).toMatch(/jq/);
  });

  it('passes through the cwd unchanged', async () => {
    await runAI('hi', '/some/cwd');
    expect(stub.calls[0].cwd).toBe('/some/cwd');
  });

  it('returns whatever the provider returns', async () => {
    const out = await runAI('hi', '/tmp');
    expect(out).toBe('stub-result');
  });
});
