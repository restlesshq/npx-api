import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SITE_URL } from './config.js';
import { loadSettings, saveSettings } from './settings.js';

/**
 * Project registration, split out from the interactive `prepare-account`
 * step so the agent-facing commands (`api key`) and the guided setup mint
 * projects exactly the same way. Everything here is deterministic plumbing -
 * no UI, no AI, no prompts.
 */

/** A fresh write key. Same shape the SDK expects in `RESTLESS_KEY`. */
export function generateWriteKey() {
  return 'rstlss_' + crypto.randomBytes(32).toString('hex');
}

export function hashWriteKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Register a project for this write key. The server only ever sees the
 * hash - never the key itself. Retries once on a 5xx: the metrics service
 * cold-starts and the first request often times out at the edge.
 *
 * Returns `{ projectId, setupKey }`. Throws with a readable message.
 */
export async function registerProject({ writeKeyHash, fetchImpl = fetch }) {
  const call = () => fetchImpl(`${SITE_URL}/api/projects/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ write_key_hash: writeKeyHash }),
  });

  let res = await call();
  if (res.status >= 500) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await call();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to initialize project (HTTP ${res.status}). ${text.slice(0, 200)}`.trim());
  }
  const data = await res.json();
  return { projectId: data.project_id, setupKey: data.setup_key };
}

/**
 * Where per-project credentials live: the user's home dir, never the repo,
 * so they don't travel with the code. Mirrors the device-auth token cache
 * `npx api update` already keeps here.
 */
export function credsPath(projectId) {
  return path.join(os.homedir(), '.restless', 'projects', `${projectId}.json`);
}

/**
 * Persist the setup key so a LATER command can still prove ownership of a
 * project it didn't mint. Without this the setup key only existed in the
 * memory of the process that created it, which is why claiming had to
 * happen inside the same run - and why a failed setup could never be
 * resumed. Written 0600.
 */
export function saveProjectCreds({ projectId, setupKey, apiKey }) {
  try {
    const file = credsPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = loadProjectCreds(projectId) || {};
    fs.writeFileSync(
      file,
      JSON.stringify({ ...existing, projectId, setupKey, apiKey, savedAt: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
    return file;
  } catch {
    return null;
  }
}

export function loadProjectCreds(projectId) {
  try {
    return JSON.parse(fs.readFileSync(credsPath(projectId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Record the project id on the API entry it belongs to (one Restless
 * project per API, so this lives on the entry, not at the root). Matches by
 * `rootDir`, falling back to the first API for the common single-API repo.
 */
/**
 * The project this write key belongs to - minting one only when we don't
 * already have it.
 *
 * `/api/projects/init` is not idempotent: it returns a fresh project id on
 * every call. So re-registering an unchanged key on each run silently
 * orphans the previous project - the running server keeps uploading under a
 * key the server maps to the OLD project, while the CLI verifies the new and
 * permanently empty one, and reports "your key is stale". Reuse instead: if
 * settings already names a project and we hold its setup key for this same
 * write key, that project is still the right answer.
 *
 * Returns `{ projectId, setupKey, reused }`.
 */
export async function ensureProject({ rootDir, apiRootDir, apiKey, fetchImpl = fetch }) {
  const settings = loadSettings(rootDir);
  const key = apiRootDir || '.';
  const entry = (settings.apis || []).find((a) => (a.rootDir || '.') === key) || settings.apis?.[0];
  const stored = entry?.projectId ? loadProjectCreds(entry.projectId) : null;

  if (entry?.projectId && stored?.setupKey && stored.apiKey === apiKey) {
    return { projectId: entry.projectId, setupKey: stored.setupKey, reused: true };
  }

  const { projectId, setupKey } = await registerProject({ writeKeyHash: hashWriteKey(apiKey), fetchImpl });
  recordProjectId({ rootDir, apiRootDir, projectId });
  saveProjectCreds({ projectId, setupKey, apiKey });
  return { projectId, setupKey, reused: false };
}

export function recordProjectId({ rootDir, apiRootDir, projectId }) {
  const settings = loadSettings(rootDir);
  const key = apiRootDir || '.';
  const target = (settings.apis || []).find((a) => (a.rootDir || '.') === key) || settings.apis?.[0];
  if (target) target.projectId = projectId;
  saveSettings(rootDir, settings);
  return target || null;
}
