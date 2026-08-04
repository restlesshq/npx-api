import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertApi, generatePrefix } from '../lib/settings.js';
import { OAS_SOURCE_KINDS } from '../lib/oas-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'schemas', 'settings.schema.json'), 'utf8'),
);
const entrySchema = schema.properties.apis.items;

/**
 * Every field the CLI actually persists onto an `apis[]` entry, and who
 * writes it. This list is the point of the file: the schema drifted out of
 * date precisely because nothing tied it to the code, and it got far enough
 * out of date that a real settings.json failed against it (it required
 * `oasFile` and `language`, both written conditionally, and it had never
 * heard of `projectId`, `oasSource`, `testCurl`, `requestIdPrefix` or
 * `redact`).
 *
 * If you add a field, add it here and to the schema in the same change.
 */
const WRITTEN_FIELDS = {
  id: 'lib/settings.js upsertApi',
  name: 'steps/generate-oas.js finalizeApi, bin/api.js register',
  rootDir: 'steps/generate-oas.js finalizeApi, bin/api.js register',
  projectId: 'lib/project-init.js recordProjectId',
  oasFile: 'steps/generate-oas.js finalizeApi, bin/api.js register',
  oasSource: 'steps/generate-oas.js finalizeApi, bin/api.js register',
  framework: 'steps/generate-oas.js finalizeApi',
  language: 'steps/generate-oas.js finalizeApi',
  baseUrl: 'steps/generate-oas.js finalizeApi, bin/api.js register/update',
  internal: 'steps/generate-oas.js finalizeApi, bin/api.js update',
  requestIdPrefix: 'steps/generate-oas.js finalizeApi, bin/api.js register/update',
  testCurl: 'steps/generate-oas.js finalizeApi',
  redact: 'steps/detect-auth.js (read by @restlessai/sdk at startup)',
  oasHash: 'steps/update-oas.js recordPushedFingerprint',
  oasOperationCount: 'steps/update-oas.js recordPushedFingerprint',
  lastSyncedAt: 'steps/generate-oas.js finalizeApi, bin/api.js register',
};

/** A minimal structural check. Not a full JSON-Schema implementation - just
 *  enough to catch the two mistakes that actually happen: a field the code
 *  writes that the schema forbids, and a required field the code never sets. */
function validateEntry(entry) {
  const errors = [];
  for (const key of entrySchema.required) {
    if (entry[key] === undefined) errors.push(`missing required field "${key}"`);
  }
  if (entrySchema.additionalProperties === false) {
    for (const key of Object.keys(entry)) {
      if (!entrySchema.properties[key]) errors.push(`undeclared field "${key}"`);
    }
  }
  return errors;
}

describe('settings schema matches what the code writes', () => {
  it('declares exactly the fields the CLI persists - no more, no less', () => {
    expect(Object.keys(entrySchema.properties).sort()).toEqual(
      Object.keys(WRITTEN_FIELDS).sort(),
    );
  });

  it('does not declare fields nothing reads or writes', () => {
    // `localPort` sat in the schema for months, written by nothing and read by
    // nothing. A schema that describes fields which do not exist is worse than
    // no schema: it invites code to start writing them.
    expect(entrySchema.properties.localPort).toBeUndefined();
  });

  it('only requires fields every writer sets', () => {
    // `oasFile`, `language` and `lastSyncedAt` are all written conditionally,
    // so requiring them made legitimate entries invalid.
    expect(entrySchema.required).toEqual(['id', 'name', 'rootDir']);
  });

  it('keeps the oasSource enum in step with lib/oas-source.js', () => {
    expect(entrySchema.properties.oasSource.properties.kind.enum.sort()).toEqual(
      [...OAS_SOURCE_KINDS].sort(),
    );
  });
});

describe('a settings file built by the real write path validates', () => {
  it('accepts a fully-populated entry', () => {
    const settings = { version: 1, apis: [] };
    upsertApi(settings, {
      name: 'Pets',
      rootDir: '.',
      oasFile: '.restless/openapi.json',
      framework: 'Fastify',
      language: 'typescript',
      baseUrl: 'https://api.acme.com',
      internal: false,
      testCurl: 'curl http://localhost:3000/pets',
      oasSource: { kind: 'ai' },
      requestIdPrefix: generatePrefix('Pets API'),
      projectId: 'p-1',
      redact: { headers: ['x-tenant'], queryParams: [], bodyKeys: ['ssn'] },
      lastSyncedAt: new Date().toISOString(),
    });
    expect(validateEntry(settings.apis[0])).toEqual([]);
  });

  it('accepts the minimal entry an adopted spec produces', () => {
    // No framework, no language, no testCurl, no projectId yet.
    const settings = { version: 1, apis: [] };
    upsertApi(settings, {
      name: 'Pets',
      rootDir: '.',
      oasFile: 'docs/openapi.yaml',
      oasSource: { kind: 'file', input: 'docs/openapi.yaml' },
      baseUrl: null,
    });
    expect(validateEntry(settings.apis[0])).toEqual([]);
  });

  it('accepts an entry with only what upsertApi guarantees', () => {
    const settings = { version: 1, apis: [] };
    upsertApi(settings, { name: 'Pets', rootDir: '.' });
    expect(validateEntry(settings.apis[0])).toEqual([]);
  });

  it('rejects a field the schema has never heard of', () => {
    // Proves the guard has teeth rather than passing everything.
    expect(validateEntry({ id: 'x', name: 'n', rootDir: '.', wat: 1 })).toEqual([
      'undeclared field "wat"',
    ]);
  });

  it('rejects an entry missing the fields upsertApi guarantees', () => {
    expect(validateEntry({ name: 'n' })).toEqual([
      'missing required field "id"',
      'missing required field "rootDir"',
    ]);
  });

  it('allows every oasSource kind the code can write', () => {
    for (const kind of OAS_SOURCE_KINDS) {
      const settings = { version: 1, apis: [] };
      upsertApi(settings, { name: 'P', rootDir: '.', oasSource: { kind } });
      expect(validateEntry(settings.apis[0])).toEqual([]);
    }
  });
});
