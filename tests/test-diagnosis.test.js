import { describe, it, expect } from 'vitest';
import {
  parseStatus,
  validatePort,
  statusNote,
  describeDiagnosis,
  fixActions,
  fixContext,
} from '../lib/test-diagnosis.js';

// eslint-disable-next-line no-control-regex
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const text = (r) => r.lines.map(strip).join('\n');

describe('parseStatus', () => {
  it('reads the status off a curl -i dump', () => {
    expect(parseStatus('HTTP/1.1 401 Unauthorized\r\nx-restless-id: abc\r\n\r\n{}')).toBe(401);
    expect(parseStatus('HTTP/2 200\r\n\r\nok')).toBe(200);
  });
  it('uses the LAST status line when there are redirects', () => {
    expect(parseStatus('HTTP/1.1 301 Moved\r\n\r\nHTTP/1.1 200 OK\r\n\r\nbody')).toBe(200);
  });
  it('returns null when there is no status line', () => {
    expect(parseStatus('just a body')).toBeNull();
    expect(parseStatus('')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });
});

describe('validatePort', () => {
  it('accepts a bare port, a :port, and a full url', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort(':4000')).toBe(4000);
    expect(validatePort('http://localhost:5173')).toBe(5173);
  });
  it('rejects nonsense and out-of-range values', () => {
    expect(validatePort('nope')).toBeNull();
    expect(validatePort('')).toBeNull();
    expect(validatePort(null)).toBeNull();
    expect(validatePort('0')).toBeNull();
    expect(validatePort('999999')).toBeNull();
  });
});

describe('statusNote', () => {
  it('is empty for 2xx and non-statuses', () => {
    expect(statusNote(200)).toBe('');
    expect(statusNote(204)).toBe('');
    expect(statusNote(null)).toBe('');
  });
  it('reassures for non-2xx', () => {
    expect(strip(statusNote(401))).toContain('401');
    expect(strip(statusNote(401))).toContain("that's expected");
  });
});

describe('describeDiagnosis', () => {
  it('ok is a non-fixable green success and folds in the status note', () => {
    const r = describeDiagnosis('ok', { status: 401 });
    expect(r.canFix).toBe(false);
    expect(text(r)).toContain('picking up your requests');
    expect(text(r)).toContain('401');
  });

  it('no-sdk and no-key are fixable failures', () => {
    expect(describeDiagnosis('no-sdk', { status: 401 }).canFix).toBe(true);
    expect(describeDiagnosis('no-key').canFix).toBe(true);
    expect(text(describeDiagnosis('no-sdk', {}))).toContain("didn't go through the Restless SDK");
    expect(text(describeDiagnosis('no-key', {}))).toContain('RESTLESS_KEY');
  });

  it('stale-key is a warning that points at .env, not an AI fix', () => {
    const r = describeDiagnosis('stale-key', { status: 200 });
    expect(r.canFix).toBe(false);
    expect(text(r)).toContain('no log reached your dashboard');
    expect(text(r)).toContain('.env');
  });

  it('unreachable only nudges about the port after a few misses', () => {
    const early = describeDiagnosis('unreachable', { localBase: 'http://localhost:3000', attempt: 1 });
    expect(early.canFix).toBe(false);
    expect(text(early)).toContain('Waiting for your server');
    expect(text(early)).not.toContain('different port');

    const later = describeDiagnosis('unreachable', { localBase: 'http://localhost:3000', attempt: 4 });
    expect(text(later)).toContain('different port');
  });
});

describe('fixActions', () => {
  it('leads with the AI fix on fixable states', () => {
    const acts = fixActions('no-sdk', { aiTool: 'Claude Code' });
    expect(acts[0].key).toBe('fix');
    expect(acts[0].primary).toBe(true);
    expect(acts.map((a) => a.key)).toEqual(['fix', 'recheck', 'port', 'skip']);
  });
  it('omits the fix action when nothing is fixable', () => {
    const acts = fixActions('ok');
    expect(acts.map((a) => a.key)).not.toContain('fix');
    expect(acts[0].key).toBe('recheck');
  });
});

describe('fixContext', () => {
  it('no-key evidence is about the missing key, not the missing header', () => {
    const c = fixContext('no-key', { localBase: 'http://localhost:3000' });
    expect(c.evidence).toContain('missing-key');
    expect(c.evidence).toContain('RESTLESS_KEY');
    expect(c.guidance).toContain('.env');
  });
  it('no-sdk evidence is about the missing SDK header', () => {
    const c = fixContext('no-sdk', { localBase: 'http://localhost:3000' });
    expect(c.evidence).toContain('x-restless-id');
    expect(c.evidence).toContain('not actually intercepting');
  });
});
