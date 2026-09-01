import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { apiDirKey, loadSettings, saveSettings, upsertApi, findApiEntry } from '../lib/settings.js';

describe('upsertApi', () => {
  it('generates a UUID when id is not provided', () => {
    const settings = { version: 1, apis: [] };
    upsertApi(settings, { name: 'Test', rootDir: '.', oasFile: '.restless/test.yaml', language: 'javascript', lastSyncedAt: new Date().toISOString() });
    expect(settings.apis[0].id).toBeTruthy();
    expect(settings.apis[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('preserves existing id on update', () => {
    const settings = { version: 1, apis: [] };
    upsertApi(settings, { name: 'Test', rootDir: '.', oasFile: '.restless/test.yaml', language: 'javascript', lastSyncedAt: '2026-01-01T00:00:00Z' });
    const id = settings.apis[0].id;

    upsertApi(settings, { id, name: 'Test Updated', rootDir: '.', oasFile: '.restless/test.yaml', language: 'javascript', lastSyncedAt: '2026-01-02T00:00:00Z' });
    expect(settings.apis.length).toBe(1);
    expect(settings.apis[0].id).toBe(id);
    expect(settings.apis[0].name).toBe('Test Updated');
  });

  it('matches on rootDir for backwards compat when no id match', () => {
    const settings = { version: 1, apis: [{ name: 'Old', rootDir: './api', oasFile: '.restless/old.yaml', language: 'python', lastSyncedAt: '2026-01-01T00:00:00Z' }] };
    upsertApi(settings, { name: 'New', rootDir: './api', oasFile: '.restless/new.yaml', language: 'python', lastSyncedAt: '2026-01-02T00:00:00Z' });
    expect(settings.apis.length).toBe(1);
    expect(settings.apis[0].name).toBe('New');
    expect(settings.apis[0].id).toBeTruthy();
  });

  it('adds a new entry when id and rootDir differ', () => {
    const settings = { version: 1, apis: [{ id: 'aaa', name: 'First', rootDir: './a', oasFile: '.restless/a.yaml', language: 'go', lastSyncedAt: '2026-01-01T00:00:00Z' }] };
    upsertApi(settings, { name: 'Second', rootDir: './b', oasFile: '.restless/b.yaml', language: 'go', lastSyncedAt: '2026-01-02T00:00:00Z' });
    expect(settings.apis.length).toBe(2);
  });
});

/**
 * Every writer does load-find-mutate-save, and they were doing the "find" three
 * times with two different rules - `id` then `projectId` in one place,
 * `projectId` only in another. In a workspace where the two disagree that means
 * one writer updates an entry and another silently updates nothing.
 */
describe('findApiEntry', () => {
  const settings = {
    apis: [
      { id: 'a1', projectId: 'p-1', name: 'First' },
      { id: 'a2', projectId: 'p-2', name: 'Second' },
    ],
  };

  it('prefers the stable local handle', () => {
    expect(findApiEntry(settings, { id: 'a2', projectId: 'p-1' }).name).toBe('Second');
  });

  it('falls back to projectId for an entry with no local id yet', () => {
    // An entry adopted by another checkout may only be identified remotely.
    expect(findApiEntry(settings, { projectId: 'p-2' }).name).toBe('Second');
    expect(findApiEntry(settings, { id: undefined, projectId: 'p-1' }).name).toBe('First');
  });

  it('returns null rather than guessing', () => {
    // Falling back to `apis[0]` here would write someone's edit onto the wrong
    // API in a multi-API repo.
    expect(findApiEntry(settings, { id: 'nope', projectId: 'nope' })).toBeNull();
    expect(findApiEntry(settings, {})).toBeNull();
    expect(findApiEntry({}, { id: 'a1' })).toBeNull();
    expect(findApiEntry({ apis: [] }, { id: 'a1' })).toBeNull();
  });
});

describe('apiDirKey', () => {
  it('collapses the spellings of one directory', () => {
    for (const d of ['.', './', '', undefined, null]) expect(apiDirKey(d)).toBe('.');
    for (const d of ['api', 'api/', './api', 'api//']) expect(apiDirKey(d)).toBe('api');
    for (const d of ['services/api', 'services/api/', './services/api']) {
      expect(apiDirKey(d)).toBe('services/api');
    }
  });

  it('leaves a distinct directory distinct', () => {
    expect(apiDirKey('svc-a')).not.toBe(apiDirKey('svc-b'));
    expect(apiDirKey('api')).not.toBe(apiDirKey('api/v2'));
  });
});
