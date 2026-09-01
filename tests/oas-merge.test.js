import { describe, it, expect } from 'vitest';
import { mergeSpecs, planSpecGroups, countOperations } from '../lib/oas-merge.js';

const SHELL = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
};

const frag = (key, spec) => ({ key, spec });

describe('mergeSpecs', () => {
  it('keeps the shell document fields', () => {
    const { spec } = mergeSpecs(SHELL, [frag('a', { paths: {} })]);
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toEqual({ title: 'T', version: '1.0.0' });
    expect(spec.servers).toEqual([{ url: 'https://api.example.com' }]);
  });

  it('unions paths from every fragment', () => {
    const { spec } = mergeSpecs(SHELL, [
      frag('a', { paths: { '/a': { get: { responses: {} } } } }),
      frag('b', { paths: { '/b': { get: { responses: {} } } } }),
    ]);
    expect(Object.keys(spec.paths).sort()).toEqual(['/a', '/b']);
  });

  it('merges methods when two fragments share a path', () => {
    // Two route files can legitimately serve the same prefix.
    const { spec, conflicts } = mergeSpecs(SHELL, [
      frag('a', { paths: { '/things': { get: { responses: {} } } } }),
      frag('b', { paths: { '/things': { post: { responses: {} } } } }),
    ]);
    expect(Object.keys(spec.paths['/things']).sort()).toEqual(['get', 'post']);
    expect(conflicts).toEqual([]);
  });

  it('keeps the first operation and reports a genuine duplicate', () => {
    const { spec, conflicts } = mergeSpecs(SHELL, [
      frag('a', { paths: { '/x': { get: { summary: 'first' } } } }),
      frag('b', { paths: { '/x': { get: { summary: 'second' } } } }),
    ]);
    expect(spec.paths['/x'].get.summary).toBe('first');
    expect(conflicts).toEqual([
      { kind: 'operation', name: 'GET /x', keptFrom: 'a', droppedFrom: 'b' },
    ]);
  });

  it('unions component sections by name, first wins', () => {
    const { spec } = mergeSpecs(SHELL, [
      frag('a', { components: { schemas: { A: { type: 'object' } } } }),
      frag('b', { components: { schemas: { B: { type: 'string' } } } }),
    ]);
    expect(Object.keys(spec.components.schemas).sort()).toEqual(['A', 'B']);
  });

  it('reports a divergent definition of the same schema name', () => {
    // The expected real collision: two parts each defining `Error`.
    const { spec, conflicts } = mergeSpecs(SHELL, [
      frag('a', { components: { schemas: { Error: { type: 'object' } } } }),
      frag('b', { components: { schemas: { Error: { type: 'string' } } } }),
    ]);
    expect(spec.components.schemas.Error).toEqual({ type: 'object' });
    expect(conflicts).toEqual([
      { kind: 'component', name: 'schemas.Error', keptFrom: 'a', droppedFrom: 'b' },
    ]);
  });

  it('stays quiet when duplicated names actually agree', () => {
    // Parts are told to name the shared error schema identically, so the
    // common case must not produce noise.
    const { conflicts } = mergeSpecs(SHELL, [
      frag('a', { components: { schemas: { Error: { type: 'object', properties: { m: { type: 'string' } } } } } }),
      frag('b', { components: { schemas: { Error: { properties: { m: { type: 'string' } }, type: 'object' } } } }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('merges securitySchemes so refs from any part resolve', () => {
    const { spec } = mergeSpecs(SHELL, [
      frag('a', { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } }),
      frag('b', { components: { securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }),
    ]);
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['apiKeyAuth', 'bearerAuth']);
  });

  it('de-duplicates tags by name', () => {
    const { spec } = mergeSpecs(SHELL, [
      frag('a', { tags: [{ name: 'Things' }] }),
      frag('b', { tags: [{ name: 'Things' }, { name: 'Others' }] }),
    ]);
    expect(spec.tags.map((t) => t.name)).toEqual(['Things', 'Others']);
  });

  it('omits an empty tags array rather than committing noise', () => {
    const { spec } = mergeSpecs(SHELL, [frag('a', { paths: {} })]);
    expect('tags' in spec).toBe(false);
  });

  it('records a malformed fragment instead of throwing', () => {
    const { spec, stats } = mergeSpecs(SHELL, [
      frag('a', { paths: { '/a': { get: {} } } }),
      frag('b', null),
      frag('c', 'not an object'),
    ]);
    expect(Object.keys(spec.paths)).toEqual(['/a']);
    expect(stats.skipped.map((s) => s.key)).toEqual(['b', 'c']);
  });

  it('takes document security from a fragment when the shell has none', () => {
    const { spec } = mergeSpecs(SHELL, [frag('a', { security: [{ bearerAuth: [] }] })]);
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  it('does not mutate the shell it was handed', () => {
    const shell = { ...SHELL, components: { schemas: {} }, paths: {} };
    mergeSpecs(shell, [frag('a', { paths: { '/a': { get: {} } }, components: { schemas: { A: {} } } })]);
    expect(shell.paths).toEqual({});
    expect(shell.components.schemas).toEqual({});
  });

  it('counts operations, ignoring non-method keys', () => {
    expect(countOperations({
      paths: {
        '/a': { get: {}, post: {}, parameters: [], summary: 'x' },
        '/b': { delete: {} },
      },
    })).toBe(3);
  });
});

describe('planSpecGroups', () => {
  const eps = (file, n) => Array.from({ length: n }, (_, i) => ({ file, method: 'GET', path: `/${i}` }));

  it('minimises the largest group, which is what sets wall clock', () => {
    // Balance for its own sake is not the goal - the run is only as fast as
    // its slowest group. Two indivisible 6-endpoint files pin the floor at
    // 6 however the rest is arranged, so 6 is the correct answer here.
    const groups = planSpecGroups([
      ...eps('big.js', 6), ...eps('also-big.js', 6), ...eps('a.js', 1),
      ...eps('b.js', 1), ...eps('c.js', 1), ...eps('d.js', 1),
    ]);
    expect(Math.max(...groups.map((g) => g.endpoints.length))).toBe(6);
  });

  it('spreads divisible work evenly', () => {
    const groups = planSpecGroups([...eps('a.js', 4), ...eps('b.js', 4), ...eps('c.js', 4), ...eps('d.js', 4)]);
    expect(groups.map((g) => g.endpoints.length)).toEqual([4, 4, 4, 4]);
  });

  it('folds small groups together rather than spending a call on each', () => {
    // 6/6/1/1/1/1 packed four ways is 6/6/2/2, where two workers idle. The
    // same critical path is reachable with one fewer request.
    const groups = planSpecGroups([
      ...eps('big.js', 6), ...eps('also-big.js', 6), ...eps('a.js', 1),
      ...eps('b.js', 1), ...eps('c.js', 1), ...eps('d.js', 1),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.endpoints.length).sort((a, b) => b - a)).toEqual([6, 6, 4]);
  });

  it('never splits one file across two groups', () => {
    const groups = planSpecGroups([...eps('a.js', 5), ...eps('b.js', 5), ...eps('c.js', 5)]);
    const seen = new Set();
    for (const g of groups) for (const f of g.files) {
      expect(seen.has(f)).toBe(false);
      seen.add(f);
    }
  });

  it('covers every endpoint exactly once', () => {
    const all = [...eps('a.js', 4), ...eps('b.js', 6), ...eps('c.js', 3)];
    const groups = planSpecGroups(all);
    expect(groups.reduce((n, g) => n + g.endpoints.length, 0)).toBe(all.length);
  });

  it('declines to split a small API', () => {
    // The fixed cost of an extra call is a real fraction of a small spec.
    expect(planSpecGroups([...eps('a.js', 2), ...eps('b.js', 2)])).toEqual([]);
  });

  it('declines to split a single-file API', () => {
    expect(planSpecGroups(eps('only.js', 30))).toEqual([]);
  });

  it('declines when there are no endpoints', () => {
    expect(planSpecGroups([])).toEqual([]);
    expect(planSpecGroups(undefined)).toEqual([]);
  });

  it('honors maxGroups', () => {
    const groups = planSpecGroups(
      [...eps('a.js', 5), ...eps('b.js', 5), ...eps('c.js', 5), ...eps('d.js', 5), ...eps('e.js', 5)],
      { maxGroups: 2 },
    );
    expect(groups).toHaveLength(2);
  });

  it('never returns an empty group', () => {
    const groups = planSpecGroups([...eps('a.js', 10), ...eps('b.js', 1)], { maxGroups: 4 });
    for (const g of groups) expect(g.endpoints.length).toBeGreaterThan(0);
  });
});
