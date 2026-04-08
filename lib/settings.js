import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = '.api/settings.json';

export function getSettingsPath(cwd) {
  return path.join(cwd, SETTINGS_FILE);
}

export function loadSettings(cwd) {
  const settingsPath = getSettingsPath(cwd);
  if (fs.existsSync(settingsPath)) {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  return {
    version: 1,
    apis: [],
  };
}

export function saveSettings(cwd, settings) {
  const dir = path.join(cwd, '.api');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getSettingsPath(cwd), JSON.stringify(settings, null, 2) + '\n');
}

export function upsertApi(settings, api) {
  // Ensure every API has a stable UUID
  if (!api.id) {
    api.id = crypto.randomUUID();
  }

  // Match on id first, fall back to rootDir for backwards compat
  const existing = settings.apis.findIndex(a => a.id === api.id || a.rootDir === api.rootDir);
  if (existing >= 0) {
    settings.apis[existing] = { ...settings.apis[existing], ...api };
  } else {
    settings.apis.push(api);
  }
  return settings;
}
