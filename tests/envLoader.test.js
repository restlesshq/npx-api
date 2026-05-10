import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectEnvLoader, envLoaderHasKey } from '../lib/envLoader.js';

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
