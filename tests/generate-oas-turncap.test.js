import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const runAI = vi.fn();

vi.mock('../lib/ai.js', async () => {
  const actual = await vi.importActual('../lib/ai.js');
  return { ...actual, runAI: (...args) => runAI(...args) };
});

import { generateOasWithAi } from '../steps/generate-oas.js';

let dir;
const VALID_SPEC = {
  openapi: '3.0.0',
  info: { title: 'T', version: '1.0.0' },
  paths: { '/things': { get: { responses: { 200: { description: 'ok' } } } } },
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-turncap-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4' } }));
  const { setGitRoot } = await import('../lib/pathGuard.js');
  setGitRoot(dir);
  runAI.mockReset();
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
});

function gen(extra = {}) {
  return generateOasWithAi({
    rootDir: dir,
    packageDir: dir,
    apiRootDir: '.',
    name: 'Test API',
    setSpinner() {},
    ...extra,
  });
}

describe('generateOasWithAi turn-cap handling', () => {
  it('fails with the reason when the run hit its cap and wrote nothing', async () => {
    // The profiled failure mode: the SDK reports "Reached maximum number of
    // turns", runAI swallows it and returns '', and the caller used to sail
    // on into a parse error that said nothing about why.
    runAI.mockImplementation(async (_p, _cwd, opts) => {
      opts?.onError?.('Reached maximum number of turns (30)');
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('stopped before writing a file');
    expect(res.error).toContain('Reached maximum number of turns');
  });

  it('still succeeds when the cap was hit but a valid spec did land', async () => {
    // What actually happened in the profiled run: the Write landed on the
    // very last turn. The file on disk is what matters, so this is reported
    // but not fatal.
    runAI.mockImplementation(async (_p, _cwd, opts) => {
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify(VALID_SPEC));
      opts?.onError?.('Reached maximum number of turns (30)');
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
  });

  it('passes an onError callback so the cap can be seen at all', async () => {
    runAI.mockImplementation(async (_p, _cwd, opts) => {
      expect(typeof opts.onError).toBe('function');
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify(VALID_SPEC));
      return '';
    });
    expect((await gen()).ok).toBe(true);
  });

  it('re-indents the compact spec the prompt asked for', async () => {
    // Phase 2 and the generation path meeting: the model writes one long
    // line, the committed file is still formatted.
    runAI.mockImplementation(async () => {
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify(VALID_SPEC));
      return '';
    });

    const res = await gen();
    expect(res.ok).toBe(true);
    const written = fs.readFileSync(res.oasFullPath, 'utf8');
    expect(written).toContain('\n  "openapi"');
    expect(JSON.parse(written)).toEqual(VALID_SPEC);
  });

  it('hands the prompt the project source instead of making it Read', async () => {
    // Phase 1 reaching the generator: the route file's contents should be in
    // the prompt text itself.
    fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'routes', 'user.js'), "router.get('/:id', showUser);");

    let seenPrompt = '';
    runAI.mockImplementation(async (prompt) => {
      seenPrompt = prompt;
      fs.mkdirSync(path.join(dir, '.restless'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.restless', 'openapi.json'), JSON.stringify(VALID_SPEC));
      return '';
    });

    await gen();
    expect(seenPrompt).toContain('src/routes/user.js');
    expect(seenPrompt).toContain('showUser');
    expect(seenPrompt).toContain('Do not re-read');
    expect(seenPrompt).toContain('Route inventory');
  });
});
