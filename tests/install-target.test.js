import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  describeMissingSdk,
  installCommandFor,
  isSdkInstalled,
  resolveInstalledSdk,
  resolveOwningDir,
} from '../lib/install-target.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-target-')));
}
function write(dir, rel, content = '') {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('resolveOwningDir', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('finds the nearest Python manifest in a monorepo', () => {
    // Installing at the repo root would put restless-sdk in the wrong
    // project, and .env next to the wrong server.
    write(dir, 'pyproject.toml', '[project]\nname="root"\n');
    write(dir, 'services/api/pyproject.toml', '[project]\nname="api"\n');
    expect(resolveOwningDir(dir, 'services/api', 'python')).toBe(path.join(dir, 'services/api'));
  });

  it('climbs past directories with no manifest', () => {
    write(dir, 'services/api/requirements.txt', 'flask\n');
    expect(resolveOwningDir(dir, 'services/api/app/routes', 'python'))
      .toBe(path.join(dir, 'services/api'));
  });

  it('accepts every Python manifest flavour', () => {
    for (const manifest of ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg']) {
      const d = tmp();
      try {
        write(d, `svc/${manifest}`, '');
        expect(resolveOwningDir(d, 'svc', 'python'), manifest).toBe(path.join(d, 'svc'));
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('does not treat a Python manifest as owning a JavaScript API', () => {
    // The walk is per-language: a requirements.txt must not stop the JS walk.
    write(dir, 'svc/requirements.txt', 'flask\n');
    write(dir, 'package.json', '{}');
    expect(resolveOwningDir(dir, 'svc', 'javascript')).toBe(dir);
    expect(resolveOwningDir(dir, 'svc', 'python')).toBe(path.join(dir, 'svc'));
  });

  it('falls back to packageDir when nothing owns the API', () => {
    write(dir, 'svc/app.py', '');
    expect(resolveOwningDir(dir, 'svc', 'python')).toBe(dir);
    expect(resolveOwningDir(dir, '.', 'python')).toBe(dir);
  });
});

describe('installCommandFor', () => {
  it('comes from the writer descriptor, one per language', () => {
    expect(installCommandFor('python')).toBe('pip install restless-sdk');
    expect(installCommandFor('javascript')).toBe('npm install @restlessai/sdk --save');
    expect(installCommandFor('typescript')).toBe('npm install @restlessai/sdk --save');
  });
});

describe('isSdkInstalled', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is false for Python when no interpreter can import it', () => {
    expect(isSdkInstalled(dir, 'python')).toBe(false);
  });

  it('detects a path/editable install by asking the interpreter', () => {
    // The case that matters before restless-sdk is on PyPI, and the one that
    // keeps mattering afterwards: `pip install -e`, a .pth file, a vendored
    // copy on PYTHONPATH and a plain registry install all answer the same
    // question the same way. Looking for a site-packages directory would
    // recognize only the last of those.
    const sdkSrc = '/Users/marc/Developer/restless/python-sdk/src';
    if (!fs.existsSync(path.join(sdkSrc, 'restless', '__init__.py'))) return;
    const saved = process.env.PYTHONPATH;
    process.env.PYTHONPATH = sdkSrc;
    try {
      expect(isSdkInstalled(dir, 'python')).toBe(true);
      expect(resolveInstalledSdk(dir, 'python')).toContain('restless');
    } finally {
      if (saved === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = saved;
    }
  });

  it('finds a hoisted Node install from a nested workspace', () => {
    write(dir, 'node_modules/@restlessai/sdk/package.json', '{"name":"@restlessai/sdk"}');
    write(dir, 'packages/api/package.json', '{}');
    expect(isSdkInstalled(path.join(dir, 'packages/api'), 'javascript')).toBe(true);
  });

  it('is false for Node when nothing is installed', () => {
    expect(isSdkInstalled(dir, 'javascript')).toBe(false);
  });
});

describe('describeMissingSdk', () => {
  it('does not blame node_modules on a Python repo', () => {
    // The old message said "nothing readable in any node_modules" whatever
    // the language, which sent Python users looking in the wrong place.
    const lines = describeMissingSdk('/repo', 'python').join(' ');
    expect(lines).not.toContain('node_modules');
    expect(lines).toContain('interpreters');
    expect(lines).toContain('.venv');
  });

  it('still explains the hoisting case for Node', () => {
    const lines = describeMissingSdk('/repo', 'javascript').join(' ');
    expect(lines).toContain('node_modules');
    expect(lines).toContain('@restlessai/sdk');
  });
});
