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

export const REQUEST_PREFIX_RE = /^[A-Z0-9]{1,7}$/;

/**
 * The fields `npx api update` may change, and how to validate each one.
 *
 * Lives here rather than inside the update command because there are now
 * three ways to set them - the inline editor, the plain-English AI patch, and
 * command-line flags - and they must agree on what is valid. A flag that
 * accepted a base URL the editor would reject is how you end up with a
 * settings file the SDK can't use.
 */
export const EDITABLE_API_FIELDS = ['name', 'baseUrl', 'internal', 'requestIdPrefix'];

/**
 * Validate a single proposed field value. Returns an error string, or null
 * when the value is acceptable.
 */
export function validateApiField(key, value) {
  if (key === 'name') {
    if (typeof value !== 'string' || !value.trim()) return 'name must be a non-empty string';
    return null;
  }
  if (key === 'baseUrl') {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return 'baseUrl must start with http:// or https://';
    return null;
  }
  if (key === 'internal') {
    if (typeof value !== 'boolean') return 'internal must be a boolean';
    return null;
  }
  if (key === 'requestIdPrefix') {
    if (typeof value !== 'string' || !REQUEST_PREFIX_RE.test(value)) return 'requestIdPrefix must be 1-7 uppercase letters or digits';
    return null;
  }
  return `unknown field "${key}"`;
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

/**
 * Dropped into `.restless/` the first time we create it. `.restless/` is
 * source, not a cache: the SDK reads `settings.json` at startup, so a
 * teammate (or CI, or a container build) who doesn't have it gets a
 * differently-configured SDK. The most common way that happens is a coding
 * agent tidying up "generated" directories into `.gitignore`, or leaving the
 * folder out of a commit because the name looks tool-ish - so the answer
 * lives in the directory itself, where anyone working in the repo will see
 * it before making that call.
 */
const DIR_README = `# .restless/

Created by \`npx api init\`. **Commit this directory along with your code.**

It is configuration, not a build artifact or a cache. Do not add it to
\`.gitignore\`, and include it in commits that change it.

| file | what it is |
| ---- | ---------- |
| \`settings.json\` | Which APIs live in this repo, where their specs are, and the redaction rules the SDK applies. Read by \`@restlessai/sdk\` at startup. |
| \`openapi.json\` | The OpenAPI spec describing your API. Regenerate with \`npx api init\`. |

No credentials are stored here. Your \`RESTLESS_KEY\` belongs in \`.env\`
(or wherever you keep secrets), which should stay out of git.
`;

export function saveSettings(cwd, settings) {
  const dir = path.join(cwd, '.restless');
  if (!fs.existsSync(dir)) {
    safeMkdirSync(dir, { recursive: true });
  }
  // Written once, on creation. Never rewritten - if someone edits or deletes
  // it, that's their call to keep.
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    try { safeWriteFileSync(readme, DIR_README); } catch {}
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
