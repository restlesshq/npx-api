import { describe, it, expect } from 'vitest';
import { dedupeCandidates } from '../steps/context.js';

/**
 * Several passes legitimately arrive at the same fact from different files, so
 * the run collapses near-duplicates before showing them. A real run produced
 * four wordings of "read-only keys refuse writes" and two of "authenticating
 * requests"; those are the cases here.
 */
const ctx = (title) => ({ target: 'context', title, content: 'x' });

describe('dedupeCandidates', () => {
  it('collapses the same fact worded four ways', () => {
    const out = dedupeCandidates([
      ctx('Write endpoints refuse read-only API keys'),
      ctx('Read-only API keys refuse every write'),
      ctx('Read-only API keys refuse write actions'),
      ctx('Read-only API keys'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the first, which is the broader pass', () => {
    // The product pass runs first, so on a tie the survivor is the general
    // statement rather than one endpoint's restatement of it.
    const out = dedupeCandidates([
      ctx('Authenticating requests to the API'),
      ctx('Authenticating requests to /api/v1'),
    ]);
    expect(out.map((c) => c.title)).toEqual(['Authenticating requests to the API']);
  });

  it('keeps genuinely different facts', () => {
    const out = dedupeCandidates([
      ctx('Searching logs: filters, limits, and 30-day range cap'),
      ctx('Metrics time-series: groupBy, range, and filters mode'),
      ctx('Feedback triage has exactly two statuses'),
      ctx('Use case slugs are assigned by the server'),
    ]);
    expect(out).toHaveLength(4);
  });

  it('does not confuse a use case with a context item of the same name', () => {
    // They are different shapes serving different surfaces; one is not a
    // duplicate of the other.
    const out = dedupeCandidates([
      ctx('Expose a use case as an MCP tool'),
      { target: 'usecase', title: 'Expose a use case as an MCP tool', content: 'x' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('is not fooled by filler words alone', () => {
    // Two titles sharing only stopwords are not duplicates.
    const out = dedupeCandidates([
      ctx('What a use case is'),
      ctx('What a project is'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('handles an empty batch', () => {
    expect(dedupeCandidates([])).toEqual([]);
  });
});
