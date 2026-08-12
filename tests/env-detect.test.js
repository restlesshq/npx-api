import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getSdkWriter } from '../lib/sdk-writers/index.js';
import { envLoaderHasKey } from '../lib/sdk-line-spec.js';

// Env detection is a writer method, so these go through the registry - the
// same path setup-context takes. Previously a three-branch if-chain in
// envLoader.js, where a language with no branch silently got the Node answer.
function detectEnvLoader(dir, language = 'javascript') {
  return getSdkWriter(language).detectEnvLoader(dir);
}

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envloader-')));
}

function writePkg(dir, pkg) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

describe('detectEnvLoader', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns mode=none when there is no package.json', () => {
    expect(detectEnvLoader(dir).mode).toBe('none');
  });

  it('returns mode=none when package.json has nothing relevant', () => {
    writePkg(dir, { name: 'x', dependencies: { fastify: '^5' } });
    expect(detectEnvLoader(dir).mode).toBe('none');
  });

  it('detects auto-loading frameworks (Next.js)', () => {
    writePkg(dir, { dependencies: { next: '^15' } });
    const r = detectEnvLoader(dir);
    expect(r.mode).toBe('auto');
    expect(r.evidence).toMatch(/next/);
  });

  it('detects auto-loading frameworks (SvelteKit)', () => {
    writePkg(dir, { dependencies: { '@sveltejs/kit': '^2' } });
    expect(detectEnvLoader(dir).mode).toBe('auto');
  });

  it('detects dotenv as a dependency', () => {
    writePkg(dir, { dependencies: { dotenv: '^16' } });
    expect(detectEnvLoader(dir).mode).toBe('dotenv');
  });

  it('detects dotenv-flow as a devDependency', () => {
    writePkg(dir, { devDependencies: { 'dotenv-flow': '^4' } });
    expect(detectEnvLoader(dir).mode).toBe('dotenv');
  });

  it('detects --env-file in scripts', () => {
    writePkg(dir, { scripts: { start: 'node --env-file=.env index.js' } });
    const r = detectEnvLoader(dir);
    expect(r.mode).toBe('env-file');
    expect(r.evidence).toMatch(/scripts\.start/);
  });

  it('detects dotenv imports in source files', () => {
    writePkg(dir, { dependencies: {} });
    fs.writeFileSync(path.join(dir, 'index.js'), "import 'dotenv/config';\nconsole.log('hi');\n");
    expect(detectEnvLoader(dir).mode).toBe('dotenv');
  });

  it('prefers framework over dotenv when both are present', () => {
    writePkg(dir, { dependencies: { next: '^15', dotenv: '^16' } });
    expect(detectEnvLoader(dir).mode).toBe('auto');
  });

  it('ignores dotenv imports inside node_modules', () => {
    writePkg(dir, { dependencies: {} });
    const nm = path.join(dir, 'node_modules', 'lib');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.js'), "require('dotenv').config();\n");
    expect(detectEnvLoader(dir).mode).toBe('none');
  });
});

describe('envLoaderHasKey', () => {
  it('is true for any non-none mode', () => {
    expect(envLoaderHasKey({ mode: 'auto' })).toBe(true);
    expect(envLoaderHasKey({ mode: 'dotenv' })).toBe(true);
    expect(envLoaderHasKey({ mode: 'env-file' })).toBe(true);
  });

  it('is false for none / null', () => {
    expect(envLoaderHasKey({ mode: 'none' })).toBe(false);
    expect(envLoaderHasKey(null)).toBe(false);
    expect(envLoaderHasKey(undefined)).toBe(false);
  });
});

describe('detectEnvLoader (Python)', () => {
  let dir;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'py-env-'))); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('recognizes the dotenv-family packages Python actually uses', () => {
    for (const dep of ['python-dotenv', 'django-environ', 'python-decouple', 'pydantic-settings', 'environs', 'dynaconf']) {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'py-env-')));
      try {
        fs.writeFileSync(path.join(d, 'requirements.txt'), `flask\n${dep}==1.0\n`);
        expect(detectEnvLoader(d, 'python').mode, dep).toBe('dotenv');
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('finds a loader imported in source but not declared at top level', () => {
    write('requirements.txt', 'fastapi\n');
    write('app/settings.py', 'from dotenv import load_dotenv\nload_dotenv()\n');
    const r = detectEnvLoader(dir, 'python');
    expect(r.mode).toBe('dotenv');
    expect(r.evidence).toContain('settings.py');
  });

  it('reports no loader for a plain Django project', () => {
    // Not a failure: Django deployments normally put the key in the real
    // process environment. It means the wiring must not name a variable that
    // may not exist, so getSdkLineSpec falls back to a no-arg constructor.
    write('requirements.txt', 'django\n');
    write('manage.py', '#!/usr/bin/env python\n');
    const r = detectEnvLoader(dir, 'python');
    expect(r.mode).toBe('none');
    expect(envLoaderHasKey(r)).toBe(false);
  });

  it('ignores a virtualenv full of vendored dotenv copies', () => {
    write('requirements.txt', 'flask\n');
    write('.venv/lib/python3.12/site-packages/dotenv/main.py', 'def load_dotenv(): pass\n');
    expect(detectEnvLoader(dir, 'python').mode).toBe('none');
  });
});
