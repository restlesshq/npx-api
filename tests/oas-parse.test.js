import { describe, it, expect } from 'vitest';
import { countOperations } from '../lib/oas-parse.js';

describe('countOperations', () => {
  it('counts method+path pairs, not path keys', () => {
    const oas = {
      paths: {
        '/pets': { get: {}, post: {} },
        '/pets/{id}': { get: {}, put: {}, delete: {} },
      },
    };
    expect(countOperations(oas)).toBe(5);
  });

  it('ignores non-method keys like parameters and vendor extensions', () => {
    const oas = {
      paths: {
        '/pets': { get: {}, parameters: [], 'x-internal': true, summary: 's' },
      },
    };
    expect(countOperations(oas)).toBe(1);
  });

  it('is zero for missing or empty paths', () => {
    expect(countOperations({})).toBe(0);
    expect(countOperations(null)).toBe(0);
    expect(countOperations({ paths: {} })).toBe(0);
  });
});
