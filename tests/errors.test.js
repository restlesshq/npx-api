import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FATAL_EXIT, FatalExit, isFatalExit, fatalError, reportError } from '../lib/errors.js';

// Every run now writes a local debug log on exit (uploads only with
// --debug). fatalError calls debug.flushAndExit, so it writes a file -
// point RESTLESS_DEBUG_DIR at a throwaway temp dir so the suite never
// touches the real ~/.restless/debug/.
let tmpDebugDir;
let prevDebugDir;
beforeAll(() => {
  prevDebugDir = process.env.RESTLESS_DEBUG_DIR;
  tmpDebugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-debug-test-'));
  process.env.RESTLESS_DEBUG_DIR = tmpDebugDir;
});
afterAll(() => {
  if (prevDebugDir === undefined) delete process.env.RESTLESS_DEBUG_DIR;
  else process.env.RESTLESS_DEBUG_DIR = prevDebugDir;
  try { fs.rmSync(tmpDebugDir, { recursive: true, force: true }); } catch {}
});

// Stub process.exit + console.log so the async flushAndExit kicked off by
// fatalError can't actually kill the test runner or pollute stdout. The
// upload is skipped when --debug isn't on (the local write is harmless,
// landing in the temp dir above); only the trailing process.exit needs
// neutralizing.
function patchExit() {
  const origExit = process.exit;
  const origLog = console.log;
  process.exit = () => {};
  console.log = () => {};
  return () => {
    process.exit = origExit;
    console.log = origLog;
  };
}

describe('FatalExit', () => {
  it('is an Error subclass', () => {
    const err = new FatalExit('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FatalExit');
    expect(err.message).toContain('boom');
  });

  it('carries the FATAL_EXIT marker for cross-module identification', () => {
    const err = new FatalExit('boom');
    expect(err[FATAL_EXIT]).toBe(true);
  });
});

describe('isFatalExit', () => {
  it('returns true for a FatalExit instance', () => {
    expect(isFatalExit(new FatalExit('x'))).toBe(true);
  });

  it('returns true for a plain object that has the marker (cross-realm)', () => {
    expect(isFatalExit({ [FATAL_EXIT]: true })).toBe(true);
  });

  it('returns false for ordinary errors', () => {
    expect(isFatalExit(new Error('plain'))).toBe(false);
    expect(isFatalExit(new TypeError('typed'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isFatalExit(null)).toBe(false);
    expect(isFatalExit(undefined)).toBe(false);
    expect(isFatalExit('boom')).toBe(false);
    expect(isFatalExit(0)).toBe(false);
  });
});

describe('fatalError', () => {
  let restore;
  beforeEach(() => { restore = patchExit(); });
  afterEach(() => { restore(); });

  it('throws a FatalExit instance synchronously', () => {
    expect(() => fatalError('headline', ['detail'])).toThrowError(FatalExit);
  });

  it('halts the calling stack so code after the call never runs', () => {
    const after = vi.fn();
    expect(() => {
      fatalError('halt');
      after();
    }).toThrowError(FatalExit);
    expect(after).not.toHaveBeenCalled();
  });

  it('throws even when called with no details', () => {
    expect(() => fatalError('headline only')).toThrowError(FatalExit);
  });

  it('the thrown FatalExit identifies via isFatalExit (round trip)', () => {
    try {
      fatalError('check round-trip');
      throw new Error('expected fatalError to throw');
    } catch (e) {
      expect(isFatalExit(e)).toBe(true);
    }
  });
});

describe('reportError', () => {
  let restore;
  beforeEach(() => { restore = patchExit(); });
  afterEach(() => { restore(); });

  it('does NOT throw (only fatalError throws)', () => {
    expect(() => reportError('headline', ['detail'])).not.toThrow();
  });
});
