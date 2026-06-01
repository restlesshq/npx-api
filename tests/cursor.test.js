import { describe, it, expect } from 'vitest';
import { createCursorReducer } from '../providers/cursor.js';

// Drive the pure reducer with parsed stream-json events, exactly as run()
// feeds them line by line. Fixtures mirror the real cursor-agent 2026.05.28
// schema captured by probing the CLI.
function reduce(events, onStatus) {
  const r = createCursorReducer({ onStatus });
  for (const e of events) r.handle(e);
  return r.finalize();
}

const SID = 'sess-1';

describe('createCursorReducer', () => {
  it('uses the terminal result event as the authoritative output (no duplication)', () => {
    const events = [
      { type: 'system', subtype: 'init', model: 'auto', session_id: SID },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the files.\n' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the result.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Reading the files.\nHere is the result.', session_id: SID },
    ];
    const out = reduce(events);
    // result event wins; assistant text is not appended on top of it.
    expect(out.result).toBe('Reading the files.\nHere is the result.');
    expect(out.isError).toBe(false);
  });

  it('falls back to concatenated assistant text when no result event arrives', () => {
    const events = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'part two' }] } },
    ];
    expect(reduce(events).result).toBe('part one part two');
  });

  it('extracts unfenced JSON from the result via the shared extractor path', async () => {
    // cursor returns raw markdown text; the apis JSON is unfenced, same as codex.
    const { extractJson } = await import('../lib/extract-json.js');
    const result = 'Here are the APIs I found:\n{ "apis": [ { "name": "A" }, { "name": "B" } ] }';
    const out = reduce([{ type: 'result', subtype: 'success', is_error: false, result }]);
    expect(extractJson(out.result, { requireKey: 'apis' }).apis).toHaveLength(2);
  });

  it('counts a shell tool as an exec and an edit tool as a mutation', () => {
    const events = [
      { type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm install foo' } } } },
      { type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { editToolCall: { args: { path: '/x/server.ts' } } } },
      { type: 'tool_call', subtype: 'started', call_id: 'c3', tool_call: { readToolCall: { args: { path: '/x/pkg.json' } } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ];
    const out = reduce(events);
    expect(out.execs).toBe(1);
    expect(out.mutations).toBe(1);
  });

  it('dedupes counters across the started/completed lifecycle by call_id', () => {
    const events = [
      { type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'echo hi' } } } },
      { type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'echo hi' }, result: {} } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ];
    expect(reduce(events).execs).toBe(1);
  });

  it('maps the shell command into the existing phase taxonomy for the spinner', () => {
    const statuses = [];
    reduce(
      [{ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm install @restlessai/sdk' } } } }],
      (s) => statuses.push(s),
    );
    expect(statuses.some((s) => s.phase === 'Installing packages')).toBe(true);
  });

  it('flags an errored result', () => {
    const out = reduce([{ type: 'result', subtype: 'error', is_error: true, result: 'something failed' }]);
    expect(out.isError).toBe(true);
  });

  it('handles an unknown tool name without throwing and emits a generic status', () => {
    const statuses = [];
    const out = reduce(
      [
        { type: 'tool_call', subtype: 'started', call_id: 'c9', tool_call: { someFutureToolCall: { args: {} } } },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
      ],
      (s) => statuses.push(s),
    );
    expect(out.result).toBe('ok');
    expect(out.execs).toBe(0);
    expect(out.mutations).toBe(0);
    expect(statuses.some((s) => s.phase === 'Working')).toBe(true);
  });

  it('ignores malformed events', () => {
    const out = reduce([null, undefined, {}, { type: 'mystery' }, { type: 'result', subtype: 'success', is_error: false, result: 'fine' }]);
    expect(out.result).toBe('fine');
  });
});
