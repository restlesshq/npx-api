import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadSettings, saveSettings, upsertApi } from '../lib/settings.js';

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
