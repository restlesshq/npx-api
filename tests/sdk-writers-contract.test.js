import { describe, it, expect } from 'vitest';
import {
  escapeRegex,
  isOwnerIdPlaceholder,
  MUTABLE_TAIL_FIELDS,
  OWNER_ID_PLACEHOLDER,
  PLACEHOLDER_OWNER_IDS,
  RISKY_CREDENTIAL_TOKENS,
  SETUP_CONCEPTS,
  unquoteLiteral,
} from '../lib/sdk-writers/contract.js';

describe('unquoteLiteral', () => {
  it('strips every language\'s string-literal style', () => {
    expect(unquoteLiteral("'x'")).toBe('x');       // JS, Python, Ruby
    expect(unquoteLiteral('"x"')).toBe('x');       // all of them
    expect(unquoteLiteral('`x`')).toBe('x');       // JS template, Go raw
    expect(unquoteLiteral('"""x"""')).toBe('x');   // Python
    expect(unquoteLiteral("'''x'''")).toBe('x');   // Python
  });

  it('prefers the longest delimiter so triple quotes do not leave stragglers', () => {
    // Stripping a single quote first would return `""x""`.
    expect(unquoteLiteral('"""NEEDS_CONFIGURATION"""')).toBe('NEEDS_CONFIGURATION');
  });

  it('leaves non-literals alone, only trimming', () => {
    expect(unquoteLiteral('  req.user.id  ')).toBe('req.user.id');
    expect(unquoteLiteral('workspace_id_for(request)')).toBe('workspace_id_for(request)');
    expect(unquoteLiteral('')).toBe('');
    expect(unquoteLiteral(undefined)).toBe('');
  });

  it('does not strip mismatched or partial quoting', () => {
    expect(unquoteLiteral('"x')).toBe('"x');
    expect(unquoteLiteral("'")).toBe("'");
  });
});

describe('isOwnerIdPlaceholder', () => {
  it('recognizes the placeholder however the language quotes it', () => {
    // The JS writer only ever had to handle the first two. Python, Ruby and
    // Go each quote differently, and the check is shared policy, so it has
    // to read all of them.
    for (const form of [
      `'${OWNER_ID_PLACEHOLDER}'`,
      `"${OWNER_ID_PLACEHOLDER}"`,
      `\`${OWNER_ID_PLACEHOLDER}\``,
      `"""${OWNER_ID_PLACEHOLDER}"""`,
      `  '${OWNER_ID_PLACEHOLDER}'  `,
    ]) {
      expect(isOwnerIdPlaceholder(form), form).toBe(true);
    }
  });

  it('does not fire on a real expression or a lookalike', () => {
    expect(isOwnerIdPlaceholder('req.user.id')).toBe(false);
    expect(isOwnerIdPlaceholder("'NEEDS_CONFIGURATION_XYZ'")).toBe(false);
    expect(isOwnerIdPlaceholder('')).toBe(false);
    expect(isOwnerIdPlaceholder(null)).toBe(false);
  });
});

describe('escapeRegex', () => {
  it('makes a literal safe to embed in a pattern', () => {
    expect(new RegExp(escapeRegex('@restlessai/sdk')).test('@restlessai/sdk')).toBe(true);
    // Unescaped, the dots and the `+` here would match far too much.
    const specifier = 'a.b+c';
    expect(new RegExp(`^${escapeRegex(specifier)}$`).test('a.b+c')).toBe(true);
    expect(new RegExp(`^${escapeRegex(specifier)}$`).test('axbbc')).toBe(false);
  });

  it('leaves a comment prefix usable in a RegExp constructor', () => {
    expect(new RegExp(`^${escapeRegex('//')}`).test('// hi')).toBe(true);
    expect(new RegExp(`^${escapeRegex('#')}`).test('# hi')).toBe(true);
  });
});

describe('shared policy sets', () => {
  it('names the CONTRACT §15 concepts every writer must spell', () => {
    expect(SETUP_CONCEPTS).toEqual(['apiKey', 'owner', 'ownerId', 'enrich']);
  });

  it('keeps the owner-id policy language-independent', () => {
    // These encode what owner.id MEANS (SETUP-002: permanent and immutable),
    // so they are identical in every language and belong here rather than in
    // any one writer.
    expect(PLACEHOLDER_OWNER_IDS.has('anonymous')).toBe(true);
    expect(MUTABLE_TAIL_FIELDS.has('email')).toBe(true);
    expect(RISKY_CREDENTIAL_TOKENS).toContain('authorization');
  });
});
