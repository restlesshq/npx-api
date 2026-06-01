import { describe, it, expect } from 'vitest';
import { extractJson } from '../lib/extract-json.js';

describe('extractJson', () => {
  it('parses a ```json fenced block (Claude-style)', () => {
    const text = 'Sure:\n```json\n{ "apis": [ { "name": "X" } ] }\n```\nDone.';
    expect(extractJson(text, { requireKey: 'apis' }).apis[0].name).toBe('X');
  });

  it('parses a raw unfenced object preceded by prose (Codex-style)', () => {
    // This is the exact shape Codex emitted that the old ```json-only regex
    // dropped, surfacing as "We couldn't find any APIs."
    const text = `I've resolved the package boundaries. Here is the result:
{ "apis": [ { "name": "@readme/micro" }, { "name": "@readme/api" } ] }`;
    expect(extractJson(text, { requireKey: 'apis' }).apis).toHaveLength(2);
  });

  it('parses a bare ``` fenced block (no language tag)', () => {
    const text = '```\n{ "apis": [ { "name": "Y" } ] }\n```';
    expect(extractJson(text, { requireKey: 'apis' }).apis[0].name).toBe('Y');
  });

  it('handles braces inside string values without miscounting depth', () => {
    const text = 'prefix {"apis":[{"name":"a{b}"}],"note":"has } brace"} suffix';
    const parsed = extractJson(text, { requireKey: 'apis' });
    expect(parsed.apis[0].name).toBe('a{b}');
    expect(parsed.note).toBe('has } brace');
  });

  it('skips incidental JSON and returns the payload matching requireKey', () => {
    const text =
      'grep:\n```json\n{"pattern":"(app|router)"}\n```\nResult:\n{"apis":[{"name":"Z"}]}';
    expect(extractJson(text, { requireKey: 'apis' }).apis[0].name).toBe('Z');
  });

  it('returns the first valid JSON when no requireKey is given', () => {
    expect(extractJson('noise {"index":2} more')).toEqual({ index: 2 });
  });

  it('parses index:0 (falsy but present) with requireKey', () => {
    expect(extractJson('pick: {"index":0}', { requireKey: 'index' }).index).toBe(0);
  });

  it('returns null when there is no usable JSON', () => {
    expect(extractJson('I could not find anything useful here.', { requireKey: 'apis' })).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    expect(extractJson(null)).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });

  it('returns null when JSON exists but lacks the required key', () => {
    expect(extractJson('{"other":true}', { requireKey: 'apis' })).toBeNull();
  });
});
