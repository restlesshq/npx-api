import { describe, it, expect } from 'vitest';
import {
  phaseForToolName,
  formatBytes,
  sniffFilePath,
  relativeToCwd,
  createToolProgressTracker,
} from '../lib/stream-progress.js';

describe('phaseForToolName', () => {
  it('answers from the name alone, before any arguments exist', () => {
    expect(phaseForToolName('Write')).toBe('Writing files');
    expect(phaseForToolName('Read')).toBe('Reading files');
    expect(phaseForToolName('Grep')).toBe('Searching the code');
  });

  it('falls back for an unknown tool rather than showing nothing', () => {
    expect(phaseForToolName('SomeNewTool')).toBe('Working');
  });

  it('gives Bash the generic label, since its phase needs the command', () => {
    expect(phaseForToolName('Bash')).toBe('Running commands');
  });
});

describe('formatBytes', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(40000)).toBe('39 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('sniffFilePath', () => {
  it('finds the path before the bulk content has arrived', () => {
    expect(sniffFilePath('{"file_path":"/tmp/a/openapi.json","content":"{\\"op'))
      .toBe('/tmp/a/openapi.json');
  });

  it('returns null until the key is complete', () => {
    expect(sniffFilePath('{"file_pa')).toBeNull();
    expect(sniffFilePath('{"file_path":"/tmp/unterminated')).toBeNull();
  });

  it('unescapes a path carrying escaped characters', () => {
    expect(sniffFilePath('{"file_path":"/tmp/a b/w\\"q.json"}')).toBe('/tmp/a b/w"q.json');
  });

  it('tolerates whitespace around the colon', () => {
    expect(sniffFilePath('{ "file_path" : "/x/y.json" }')).toBe('/x/y.json');
  });
});

describe('relativeToCwd', () => {
  it('relativises a path under the cwd', () => {
    expect(relativeToCwd('/proj/src/app.js', '/proj')).toBe('src/app.js');
  });

  it('falls back to the basename for a path outside the cwd', () => {
    expect(relativeToCwd('/elsewhere/deep/thing.json', '/proj')).toBe('thing.json');
  });
});

describe('createToolProgressTracker', () => {
  const start = (name) => ({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name } });
  const delta = (partial_json) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });

  it('reports the tool as soon as its block opens', () => {
    const seen = [];
    const t = createToolProgressTracker({ cwd: '/proj', onStatus: (s) => seen.push(s) });
    t.handle(start('Write'));
    expect(seen).toEqual([{ phase: 'Writing files', detail: 'Write…' }]);
  });

  it('ignores a text block, which is not a tool call', () => {
    const seen = [];
    const t = createToolProgressTracker({ cwd: '/proj', onStatus: (s) => seen.push(s) });
    t.handle({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    expect(seen).toEqual([]);
  });

  it('forces a paint on a large delta inside the time window', () => {
    // One big delta would otherwise be invisible and leave the counter stale.
    const seen = [];
    const t = createToolProgressTracker({ cwd: '/proj', onStatus: (s) => seen.push(s) });
    t.handle(start('Write'));
    t.handle(delta('{"file_path":"/proj/big.json","content":"'));
    t.handle(delta('x'.repeat(40000)));
    expect(seen[seen.length - 1].detail).toMatch(/big\.json \(3\d KB so far\)/);
  });

  it('does not paint per delta', () => {
    const seen = [];
    const t = createToolProgressTracker({ cwd: '/proj', onStatus: (s) => seen.push(s) });
    t.handle(start('Write'));
    for (let i = 0; i < 400; i++) t.handle(delta('abcdefghij'));
    expect(seen.length).toBeLessThan(5);
  });

  it('ignores deltas once the block has stopped', () => {
    const seen = [];
    const t = createToolProgressTracker({ cwd: '/proj', onStatus: (s) => seen.push(s) });
    t.handle(start('Write'));
    t.handle({ type: 'content_block_stop', index: 0 });
    t.handle(delta('y'.repeat(20000)));
    expect(seen).toHaveLength(1);
  });

  it('survives a null event and an unknown event type', () => {
    const t = createToolProgressTracker({ cwd: '/proj', onStatus() {} });
    expect(() => { t.handle(null); t.handle({ type: 'message_delta' }); }).not.toThrow();
  });

  it('works without an onStatus callback', () => {
    const t = createToolProgressTracker({ cwd: '/proj' });
    expect(() => { t.handle(start('Write')); t.handle(delta('z'.repeat(9000))); }).not.toThrow();
  });
});
