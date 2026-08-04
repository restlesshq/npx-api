import { describe, it, expect } from 'vitest';
import { parseUpdateFlags, UPDATE_FLAGS } from '../steps/update-flags.js';

const argv = (...args) => ['node', 'api.js', 'update', ...args];
/** The flags a well-formed argv produced. Throws if the parser rejected it. */
const parse = (...args) => {
  const res = parseUpdateFlags(argv(...args));
  expect(res.errors).toBeUndefined();
  return res.flags;
};

describe('parseUpdateFlags', () => {
  it('returns null with no directive, so the interactive flow runs', () => {
    expect(parse()).toBeNull();
    expect(parse('p-abc')).toBeNull();
    // --json alone says how to print a result, not what to do.
    expect(parse('--json')).toBeNull();
  });

  it('collects the settings fields', () => {
    const f = parse('--name', 'Pets', '--base-url', 'https://a.com', '--prefix', 'pts');
    expect(f.edits).toEqual({
      name: 'Pets',
      baseUrl: 'https://a.com',
      // Upper-cased here so the flag path and the editor agree - the editor
      // upper-cases too, and the validator only accepts upper-case.
      requestIdPrefix: 'PTS',
    });
  });

  it('maps visibility to the boolean the settings file stores', () => {
    expect(parse('--internal').edits.internal).toBe(true);
    expect(parse('--external').edits.internal).toBe(false);
  });

  it('treats each spec directive as a directive on its own', () => {
    expect(parse('--refresh').refresh).toBe(true);
    expect(parse('--oas', 'docs/o.yaml').oas).toBe('docs/o.yaml');
    expect(parse('--sync').sync).toBe(true);
    // --status counts as a directive so a headless caller can ask about the
    // spec without landing in the interactive flow.
    expect(parse('--status').status).toBe(true);
  });

  it('carries the output modifier', () => {
    // No --yes: nothing on this path prompts, so there is nothing to confirm.
    expect(parse('--sync', '--json').json).toBe(true);
  });

  it('accepts a spec directive alongside settings edits', () => {
    const f = parse('--name', 'Pets', '--refresh');
    expect(f.edits.name).toBe('Pets');
    expect(f.refresh).toBe(true);
  });
});

/**
 * A flag given wrongly has to be an error, not a silent no-op.
 *
 * `--base-url` with nothing after it used to be indistinguishable from not
 * passing it: the run reported success having changed nothing, and in CI it
 * printed the flag list and exited 0. An agent has no way to notice that, and
 * the whole point of this path is that an agent drives it.
 */
describe('parseUpdateFlags rejects a flag it cannot honour', () => {
  it('errors when a value flag has no value', () => {
    for (const flag of ['--name', '--base-url', '--prefix', '--oas']) {
      const res = parseUpdateFlags(argv(flag));
      expect(res.errors).toEqual([`${flag} needs a value.`]);
      expect(res.flags).toBeUndefined();
    }
  });

  it('errors rather than swallowing the next flag as a value', () => {
    // `--name --refresh` must not set the name to "--refresh", and must not
    // quietly drop the name either.
    const res = parseUpdateFlags(argv('--name', '--refresh'));
    expect(res.errors).toEqual(['--name needs a value.']);
  });

  it('errors on contradictory visibility', () => {
    expect(parseUpdateFlags(argv('--internal', '--external')).errors).toEqual([
      '--internal and --external contradict each other.',
    ]);
  });

  it('errors when asked to both adopt and refresh', () => {
    // They name different specs. Picking one for the caller would be a guess
    // about which spec their project should point at.
    expect(parseUpdateFlags(argv('--oas', 'docs/o.yaml', '--refresh')).errors).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    const res = parseUpdateFlags(argv('--name', '--base-url'));
    expect(res.errors).toEqual(['--name needs a value.', '--base-url needs a value.']);
  });
});

describe('UPDATE_FLAGS', () => {
  it('documents every flag the parser understands', () => {
    // Help output that omits a working flag is how a flag goes unused; help
    // that lists a flag the parser ignores is worse.
    const documented = UPDATE_FLAGS.map(([name]) => name.split(' ')[0]);
    for (const flag of ['--status', '--name', '--base-url', '--internal', '--prefix', '--oas', '--refresh', '--sync', '--project', '--json']) {
      expect(documented.some((d) => d.includes(flag))).toBe(true);
    }
  });
});
