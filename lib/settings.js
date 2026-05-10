import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { safeWriteFileSync, safeMkdirSync } from './pathGuard.js';

const SETTINGS_FILE = '.restless/settings.json';

/**
 * Generate a 3-letter request ID prefix from a project/company name.
 * e.g. "Test Project" → "TST", "Acme" → "ACM", "Big Commerce Platform" → "BCP"
 */
export function generatePrefix(name) {
  const fillers = new Set(['project', 'api', 'app', 'service', 'server', 'backend', 'frontend', 'the', 'my', 'our']);
  const allWords = name.trim().split(/\s+/);
  const words = allWords.filter(w => !fillers.has(w.toLowerCase()));
  const effective = words.length > 0 ? words : allWords;

  let prefix;
  if (effective.length >= 3) {
    // Multiple words: take initials
    prefix = effective.slice(0, 3).map(w => w[0]).join('');
  } else if (effective.length === 2) {
    prefix = effective[0][0] + effective[1].slice(0, 2);
  } else {
    // Single word: prefer consonants (e.g. "Test" → "TST")
    const consonants = effective[0].replace(/[aeiou]/gi, '');
    prefix = consonants.length >= 3 ? consonants.slice(0, 3) : effective[0].slice(0, 3);
  }

  return prefix.toUpperCase().slice(0, 3);
}

/**
 * Format a raw request ID with the project's decorative prefix.
 * e.g. ("abc-123", "TST") → "TST-abc-123"
 */
export function formatRequestId(rawId, prefix) {
  if (!prefix) return rawId;
  return `${prefix}-${rawId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip a decorative prefix from a request ID, returning the raw UUID.
 * e.g. "TST-9f18a0e2-..." → "9f18a0e2-...", "9f18a0e2-..." → "9f18a0e2-..."
 * Only strips if prefix is 1-7 alphanumeric chars and the remainder is a valid UUID.
 */
export function stripRequestIdPrefix(requestId) {
  const match = requestId.match(/^[A-Za-z0-9]{1,7}-(.+)$/);
  if (match && UUID_RE.test(match[1])) return match[1];
  return requestId;
}

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
  const dir = path.join(cwd, '.restless');
  if (!fs.existsSync(dir)) {
    safeMkdirSync(dir, { recursive: true });
  }
  safeWriteFileSync(getSettingsPath(cwd), JSON.stringify(settings, null, 2) + '\n');
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
