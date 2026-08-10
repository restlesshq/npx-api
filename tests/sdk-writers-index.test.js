import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  getSdkWriter,
  isSupportedLanguage,
  normalizeLanguage,
  OPTIONAL_WRITER_METHODS,
  REQUIRED_WRITER_METHODS,
  SUPPORTED_LANGUAGES,
  UnsupportedLanguageError,
} from '../lib/sdk-writers/index.js';
import { SETUP_CONCEPTS } from '../lib/sdk-writers/contract.js';
import * as jsWriter from '../lib/sdk-writers/javascript.js';

describe('normalizeLanguage', () => {
  it('canonicalizes the spellings detection and hand-edited settings produce', () => {
    expect(normalizeLanguage('Node.js')).toBe('javascript');
    expect(normalizeLanguage('nodejs')).toBe('javascript');
    expect(normalizeLanguage('JS')).toBe('javascript');
    expect(normalizeLanguage('  TypeScript  ')).toBe('typescript');
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('golang')).toBe('go');
    expect(normalizeLanguage('rb')).toBe('ruby');
  });

  it('treats an absent language as JavaScript, the long-standing default', () => {
    // install-sdk and final-checks both defaulted this way before the
    // registry existed; changing it would repoint every un-annotated re-run.
    expect(normalizeLanguage(undefined)).toBe('javascript');
    expect(normalizeLanguage(null)).toBe('javascript');
    expect(normalizeLanguage('')).toBe('javascript');
    expect(normalizeLanguage('   ')).toBe('javascript');
  });

  it('passes through an unknown language rather than guessing', () => {
    expect(normalizeLanguage('elixir')).toBe('elixir');
    expect(normalizeLanguage('C#')).toBe('csharp');
  });
});

describe('getSdkWriter', () => {
  it('returns the JavaScript writer for both JS and TS', () => {
    expect(getSdkWriter('javascript')).toBe(jsWriter);
    expect(getSdkWriter('typescript')).toBe(jsWriter);
    expect(getSdkWriter('Node.js')).toBe(jsWriter);
    expect(getSdkWriter(undefined)).toBe(jsWriter);
  });

  it('THROWS for a language with no writer instead of silently using JS', () => {
    // The whole point of the registry. The old `writers[language] || jsWriter`
    // handed a Python repo the JavaScript writer, which then matched none of
    // its own patterns and reported "SDK not wired" - wrong, and wrong in a
    // way that looks like a user error rather than a missing feature.
    for (const lang of ['ruby', 'go', 'php', 'csharp']) {
      expect(() => getSdkWriter(lang)).toThrow(UnsupportedLanguageError);
    }
  });

  it('names the language and what is supported in the error', () => {
    let err;
    try {
      getSdkWriter('rb');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedLanguageError);
    expect(err.language).toBe('ruby');
    expect(err.message).toContain('ruby');
    expect(err.message).toContain('javascript');
  });
});

describe('isSupportedLanguage', () => {
  it('answers without throwing', () => {
    expect(isSupportedLanguage('javascript')).toBe(true);
    expect(isSupportedLanguage('ts')).toBe(true);
    expect(isSupportedLanguage(undefined)).toBe(true);
    expect(isSupportedLanguage('python')).toBe(true);
    expect(isSupportedLanguage('go')).toBe(false);
  });

  it('is not fooled by inherited Object properties', () => {
    expect(isSupportedLanguage('constructor')).toBe(false);
    expect(isSupportedLanguage('toString')).toBe(false);
  });
});

describe('SUPPORTED_LANGUAGES', () => {
  it('lists exactly the languages with a writer', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['javascript', 'typescript', 'python']);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(() => getSdkWriter(lang)).not.toThrow();
    }
  });

  it('every writer implements the methods the steps actually call', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const writer = getSdkWriter(lang);
      for (const fn of REQUIRED_WRITER_METHODS) {
        expect(typeof writer[fn], `${lang}.${fn}`).toBe('function');
      }
    }
  });

  it('does not require the Node-only or vestigial methods', () => {
    // `generate` has no production caller (the AI writes the wiring, the CLI
    // only patches), and hasWithRestless/hasDefineConfig are the Next.js
    // plugin checks that CONTRACT.md §14 marks as having no cross-language
    // analogue. Requiring either would make every new writer stub something
    // it can never meaningfully implement.
    for (const fn of ['generate', 'parse', 'findOldApiSetup', 'hasWithRestless', 'hasDefineConfig']) {
      expect(REQUIRED_WRITER_METHODS).not.toContain(fn);
      expect(OPTIONAL_WRITER_METHODS).toContain(fn);
    }
  });

  it('every writer spells all the CONTRACT §15 concepts', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const { descriptor } = getSdkWriter(lang);
      expect(descriptor, `${lang} descriptor`).toBeTruthy();
      for (const concept of SETUP_CONCEPTS) {
        expect(typeof descriptor.fields[concept], `${lang}.fields.${concept}`).toBe('string');
      }
      expect(descriptor.commentPrefix).toBeTruthy();
      // A list, not one value: Python reaches mask as both a staticmethod
      // and a module export, so a single-style field could not describe it.
      expect(descriptor.maskCall.styles.length).toBeGreaterThan(0);
      for (const style of descriptor.maskCall.styles) {
        expect(['method', 'module', 'package']).toContain(style);
      }
      expect(descriptor.searchPattern).toBeTruthy();
      expect(descriptor.searchGlobs.length).toBeGreaterThan(0);
    }
  });
});

describe('optional methods are actually optional at the call sites', () => {
  it('every step guards a method a writer may not implement', () => {
    // Regression: final-checks called writer.findOldApiSetup(content)
    // unconditionally. Python does not implement it (nothing else has an old
    // API to migrate from), so every Python run would have died with
    // "writer.findOldApiSetup is not a function" inside final checks.
    const python = getSdkWriter('python');
    const missing = OPTIONAL_WRITER_METHODS.filter((m) => typeof python[m] !== 'function');
    expect(missing).toContain('findOldApiSetup');

    const sources = [
      'steps/final-checks.js', 'steps/install-sdk.js', 'steps/verify-owner-id.js',
    ].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');

    for (const method of missing) {
      // Every line that CALLS the method must also test for it first.
      const unguarded = sources.split('\n').filter(
        (line) => new RegExp(`writer\\.${method}\\s*\\(`).test(line)
          && !new RegExp(`writer\\.${method}\\s*(\\?|&&)`).test(line),
      );
      expect(unguarded, `unguarded calls to ${method}`).toEqual([]);
    }
  });
});
