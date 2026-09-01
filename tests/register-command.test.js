import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'restless.js');

// `register` lives inline in the entry point and touches no network, so
// running the real CLI is both the only honest test and a cheap one.
describe('npx restless register', () => {
  let tmp;
  let debugDir;

  const OAS = {
    openapi: '3.0.3',
    info: { title: 'Markov API', version: '1.0.0' },
    servers: [{ url: 'https://markov.example.com' }],
    paths: { '/lines': { get: { responses: { 200: { description: 'ok' } } } } },
  };

  function run(args) {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, RESTLESS_DEBUG_DIR: debugDir, RESTLESS_NONINTERACTIVE: '1' },
    });
  }

  function settings() {
    return JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
  }

  function seedApis(apis) {
    fs.writeFileSync(
      path.join(tmp, '.restless', 'settings.json'),
      JSON.stringify({ version: 1, apis }),
    );
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restless-register-')));
    debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-debug-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.restless', 'openapi.json'), JSON.stringify(OAS));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(debugDir, { recursive: true, force: true });
  });

  it('records the spec on a fresh repo', () => {
    run(['register', '--oas', '.restless/openapi.json']);
    const s = settings();
    expect(s.apis).toHaveLength(1);
    expect(s.apis[0]).toMatchObject({
      name: 'Markov API',
      rootDir: '.',
      oasFile: '.restless/openapi.json',
      baseUrl: 'https://markov.example.com',
    });
  });

  it('keeps the projectId a prior `key` run recorded', () => {
    seedApis([{ id: 'stub-id', name: 'tmp', rootDir: '.', projectId: 'proj-1' }]);
    run(['register', '--oas', '.restless/openapi.json']);
    const s = settings();
    expect(s.apis).toHaveLength(1);
    expect(s.apis[0]).toMatchObject({ id: 'stub-id', projectId: 'proj-1', name: 'Markov API' });
  });

  // A second entry would split projectId and spec across two APIs, and
  // `login` - which picks by projectId - would claim a project with no spec.
  it('adopts the key stub instead of adding a second entry when --dir differs', () => {
    seedApis([{ id: 'stub-id', name: 'tmp', rootDir: '.', projectId: 'proj-1' }]);
    run(['register', '--oas', '.restless/openapi.json', '--dir', 'services/api']);
    const s = settings();
    expect(s.apis).toHaveLength(1);
    expect(s.apis[0]).toMatchObject({
      id: 'stub-id',
      projectId: 'proj-1',
      rootDir: 'services/api',
      oasFile: '.restless/openapi.json',
    });
  });

  // Only a spec-less stub is adoptable, or `--dir` could never add a real
  // second API to a repo that already has one.
  it('still adds a second API rather than hijacking one that already has a spec', () => {
    seedApis([{
      id: 'first', name: 'First', rootDir: '.', projectId: 'proj-1',
      oasFile: '.restless/first.json',
    }]);
    run(['register', '--oas', '.restless/openapi.json', '--dir', 'services/api']);
    const s = settings();
    expect(s.apis).toHaveLength(2);
    expect(s.apis[0]).toMatchObject({ id: 'first', oasFile: '.restless/first.json' });
    expect(s.apis[1]).toMatchObject({ rootDir: 'services/api', name: 'Markov API' });
  });
});
