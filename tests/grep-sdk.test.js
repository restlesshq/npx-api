import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findSdkReferences, findOwnerIdPlaceholders } from '../lib/grep-sdk.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grep-sdk-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('findOwnerIdPlaceholders', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('finds files carrying the placeholder or the marker comment', () => {
    write(dir, 'index.js', `owner: {\n  // RESTLESS_OWNER_ID_TODO: no stable id found\n  id: 'NEEDS_CONFIGURATION',\n}\n`);
    write(dir, 'src/other.ts', `const x = 1;\n`);
    expect(findOwnerIdPlaceholders(dir)).toEqual(['index.js']);
  });

  it('returns empty when the placeholder is resolved', () => {
    write(dir, 'index.js', `owner: { id: req.account.id }\n`);
    expect(findOwnerIdPlaceholders(dir)).toEqual([]);
  });

  it('ignores node_modules and non-source files', () => {
    write(dir, 'node_modules/pkg/index.js', `'NEEDS_CONFIGURATION'`);
    write(dir, 'notes.md', `NEEDS_CONFIGURATION`);
    expect(findOwnerIdPlaceholders(dir)).toEqual([]);
  });
});

describe('findSdkReferences', () => {
  it('lists source files referencing the SDK', () => {
    const dir = tmp();
    write(dir, 'server.js', `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n`);
    write(dir, 'node_modules/@restlessai/sdk/index.js', `// @restlessai/sdk`);
    expect(findSdkReferences(dir)).toEqual(['server.js']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
