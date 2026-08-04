import { describe, it, expect } from 'vitest';
import { parseUpdateFlags, UPDATE_FLAGS } from '../steps/update-flags.js';

const argv = (...args) => ['node', 'api.js', 'update', ...args];

describe('parseUpdateFlags', () => {
  it('returns null with no directive, so the interactive flow runs', () => {
    expect(parseUpdateFlags(argv())).toBeNull();
    expect(parseUpdateFlags(argv('p-abc'))).toBeNull();
    // --json alone says how to print a result, not what to do.
    expect(parseUpdateFlags(argv('--json'))).toBeNull();
  });

  it('collects the settings fields', () => {
    const f = parseUpdateFlags(argv('--name', 'Pets', '--base-url', 'https://a.com', '--prefix', 'pts'));
    expect(f.edits).toEqual({
      name: 'Pets',
      baseUrl: 'https://a.com',
      // Upper-cased here so the flag path and the editor agree - the editor
      // upper-cases too, and the validator only accepts upper-case.
      requestIdPrefix: 'PTS',
    });
  });

  it('maps visibility to the boolean the settings file stores', () => {
    expect(parseUpdateFlags(argv('--internal')).edits.internal).toBe(true);
    expect(parseUpdateFlags(argv('--external')).edits.internal).toBe(false);
  });

  it('does not swallow the next flag as a value', () => {
    // `--name --refresh` must not set the name to "--refresh".
    const f = parseUpdateFlags(argv('--name', '--refresh'));
    expect(f.edits.name).toBeUndefined();
    expect(f.refresh).toBe(true);
  });

  it('treats each spec directive as a directive on its own', () => {
    expect(parseUpdateFlags(argv('--refresh')).refresh).toBe(true);
    expect(parseUpdateFlags(argv('--oas', 'docs/o.yaml')).oas).toBe('docs/o.yaml');
    expect(parseUpdateFlags(argv('--sync')).syncOnly).toBe(true);
    // --status counts as a directive so a headless caller can ask about the
    // spec without landing in the interactive flow.
    expect(parseUpdateFlags(argv('--status')).status).toBe(true);
  });

  it('carries the output modifier', () => {
    // No --yes: nothing on this path prompts, so there is nothing to confirm.
    expect(parseUpdateFlags(argv('--sync', '--json')).json).toBe(true);
  });

  it('accepts a spec directive alongside settings edits', () => {
    const f = parseUpdateFlags(argv('--name', 'Pets', '--refresh'));
    expect(f.edits.name).toBe('Pets');
    expect(f.refresh).toBe(true);
  });
});

describe('UPDATE_FLAGS', () => {
  it('documents every flag the parser understands', () => {
    // Help output that omits a working flag is how a flag goes unused; help
    // that lists a flag the parser ignores is worse.
    const documented = UPDATE_FLAGS.map(([name]) => name.split(' ')[0]);
    for (const flag of ['--status', '--name', '--base-url', '--internal', '--prefix', '--oas', '--refresh', '--sync', '--json']) {
      expect(documented.some((d) => d.includes(flag))).toBe(true);
    }
  });
});
