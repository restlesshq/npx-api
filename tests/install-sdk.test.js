import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { inlineKeyIntoSource } from '../steps/install-sdk.js';
import { setGitRoot } from '../lib/pathGuard.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-sdk-')));
}

describe('inlineKeyIntoSource', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
    // Configure the path guard so the safeWriteFileSync calls inside
    // inlineKeyIntoSource don't reject our tmp dir.
    setGitRoot(dir);
  });
  afterEach(() => {
    setGitRoot(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces process.env.RESTLESS_KEY in files that import the SDK', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `// TODO: move this out of the codebase before committing\nconst restless = require('@restlessai/sdk')("rdme_abc");\n`,
    );
  });

  it('prefixes the SDK init line with a TODO comment', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "  const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    inlineKeyIntoSource(dir, 'rdme_abc');
    const out = fs.readFileSync(file, 'utf8');
    // Comment matches the indent of the SDK init line.
    expect(out).toContain('  // TODO: move this out of the codebase before committing\n');
    expect(out).toContain('  const restless = require(\'@restlessai/sdk\')("rdme_abc");');
  });

  it('does not double-add the TODO comment on re-runs', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(
      file,
      '// TODO: move this out of the codebase before committing\n' +
        "const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n",
    );
    inlineKeyIntoSource(dir, 'rdme_new');
    const out = fs.readFileSync(file, 'utf8');
    // Only one TODO line, not two.
    const matches = out.match(/TODO: move this out of the codebase/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('handles ESM import + separate call', () => {
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(file, "import restless from '@restlessai/sdk';\nconst r = restless(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_xyz');
    expect(touched).toEqual(['server.mjs']);
    expect(fs.readFileSync(file, 'utf8')).toContain('restless("rdme_xyz")');
  });

  it('properly JSON-escapes weird characters in the key', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    inlineKeyIntoSource(dir, 'has"double-quote');
    const out = fs.readFileSync(file, 'utf8');
    // JSON.stringify wraps in double quotes and escapes the inner quote.
    expect(out).toContain('"has\\"double-quote"');
  });

  it('does not touch files that do not import the SDK', () => {
    const sdkFile = path.join(dir, 'index.js');
    const otherFile = path.join(dir, 'unrelated.js');
    fs.writeFileSync(sdkFile, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    fs.writeFileSync(otherFile, 'const x = process.env.RESTLESS_KEY;\n');
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    // unrelated file should be untouched.
    expect(fs.readFileSync(otherFile, 'utf8')).toBe('const x = process.env.RESTLESS_KEY;\n');
  });

  it('skips files inside node_modules', () => {
    const nm = path.join(dir, 'node_modules', '@restlessai', 'sdk');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.js'), "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
  });

  it('returns an empty list when no SDK files exist', () => {
    fs.writeFileSync(path.join(dir, 'index.js'), "console.log('hi');\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
  });

  it('skips files that import the SDK but do not reference process.env.RESTLESS_KEY', () => {
    const file = path.join(dir, 'index.js');
    // Already inlined or using a different env approach.
    const original = "require('@restlessai/sdk')('rdme_existing');\n";
    fs.writeFileSync(file, original);
    const touched = inlineKeyIntoSource(dir, 'rdme_new');
    expect(touched).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('injects the key into a bare immediate-call site (no placeholder)', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, 'const restless = require("@restlessai/sdk")();\n');
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain('// TODO: move this out of the codebase before committing\n');
    expect(out).toContain('const restless = require("@restlessai/sdk")("rdme_abc");');
  });

  it('injects the key into an ESM bare-call site (no placeholder)', () => {
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(file, "import restless from '@restlessai/sdk';\nconst r = restless();\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_xyz');
    expect(touched).toEqual(['server.mjs']);
    expect(fs.readFileSync(file, 'utf8')).toContain('const r = restless("rdme_xyz");');
  });

  it('injects the key into a CJS named-import bare-call site', () => {
    const file = path.join(dir, 'index.js');
    fs.writeFileSync(file, "const factory = require('@restlessai/sdk');\nconst r = factory();\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual(['index.js']);
    expect(fs.readFileSync(file, 'utf8')).toContain('const r = factory("rdme_abc");');
  });

  it('is idempotent when the literal key is already present', () => {
    const file = path.join(dir, 'index.js');
    const original =
      '// TODO: move this out of the codebase before committing\n' +
      'const restless = require("@restlessai/sdk")("rdme_abc");\n';
    fs.writeFileSync(file, original);
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('handles multiple files in one pass', () => {
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const a = path.join(dir, 'index.js');
    const b = path.join(sub, 'app.ts');
    fs.writeFileSync(a, "require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n");
    fs.writeFileSync(b, "import restless from '@restlessai/sdk';\nrestless(process.env.RESTLESS_KEY);\n");
    const touched = inlineKeyIntoSource(dir, 'rdme_abc');
    expect(touched.sort()).toEqual(['index.js', 'src/app.ts'].sort());
    expect(fs.readFileSync(a, 'utf8')).toContain('"rdme_abc"');
    expect(fs.readFileSync(b, 'utf8')).toContain('"rdme_abc"');
  });
});
