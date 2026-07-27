import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SITE_URL } from './config.js';
import { loadSettings, saveSettings } from './settings.js';
import { countOperations, parseOas } from './oas-parse.js';

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
 * Find the project this write key belongs to, from the creds this machine
 * has saved. This is the recovery path for "key on disk, but settings has
 * no projectId" - a fresh branch, a wiped `.restless/`, a re-init after
 * reset. Without it, that state re-registers the key and orphans it (see
 * ensureProject below).
 *
 * The same key can appear in several creds files precisely because of a
 * past re-registration. Ingress attributes uploads to the FIRST project
 * registered for a key, so the oldest `savedAt` is the one that matches
 * where the logs actually go.
 */
export function findCredsByApiKey(apiKey) {
  if (!apiKey) return null;
  try {
    const dir = path.join(os.homedir(), '.restless', 'projects');
    const matches = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (creds?.apiKey === apiKey && creds.projectId && creds.setupKey) matches.push(creds);
      } catch {}
    }
    if (!matches.length) return null;
    matches.sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
    return matches[0];
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
 * permanently empty one, and reports "your key is stale". Reuse instead, in
 * two tiers: settings already names a project whose stored creds match this
 * key, or - when settings has no projectId at all - the creds this machine
 * saved when it first registered the key (`findCredsByApiKey`).
 *
 * `registerUnknown: false` makes an unrecognized key return null instead of
 * registering it. Callers holding a key of unknown provenance (found on
 * disk, no local creds) use this to mint a fresh key rather than create the
 * orphaned pairing described above - registering someone's old key is the
 * one move guaranteed to be wrong.
 *
 * Returns `{ projectId, setupKey, reused, recovered }`, or null when
 * `registerUnknown` is false and nothing matched.
 */
export async function ensureProject({ rootDir, apiRootDir, apiKey, registerUnknown = true, fetchImpl = fetch }) {
  const settings = loadSettings(rootDir);
  const key = apiRootDir || '.';
  const entry = (settings.apis || []).find((a) => (a.rootDir || '.') === key) || settings.apis?.[0];
  const stored = entry?.projectId ? loadProjectCreds(entry.projectId) : null;

  if (entry?.projectId && stored?.setupKey && stored.apiKey === apiKey) {
    return { projectId: entry.projectId, setupKey: stored.setupKey, reused: true };
  }

  const recovered = findCredsByApiKey(apiKey);
  if (recovered) {
    recordProjectId({ rootDir, apiRootDir, projectId: recovered.projectId });
    return { projectId: recovered.projectId, setupKey: recovered.setupKey, reused: true, recovered: true };
  }

  if (!registerUnknown) return null;

  const { projectId, setupKey } = await registerProject({ writeKeyHash: hashWriteKey(apiKey), fetchImpl });
  recordProjectId({ rootDir, apiRootDir, projectId });
  saveProjectCreds({ projectId, setupKey, apiKey });
  return { projectId, setupKey, reused: false };
}

/**
 * Stage the local artifacts (OAS spec + settings) on the server so the
 * claim flow can attach them. The dashboard's claim route consumes
 * PendingOAS / PendingSettings rows keyed by setupKeyHash - anything not
 * uploaded BEFORE the user claims simply never appears on the project.
 * Mirrors the uploads the guided setup-account step performs; `api login`
 * calls this so the agent flow's claim isn't empty.
 *
 * Failures are reported, not thrown - a claim without a spec is degraded,
 * not broken. Returns { oas, settings, endpoints, error?, settingsError? }
 * where oas and settings are 'uploaded' | 'none' | 'failed'.
 *
 * The API entry is picked by projectId first (the project being claimed),
 * then by apiRootDir when given, then the first entry - so both callers
 * (the guided setup-account step and `api login`) resolve the same spec.
 */
export async function uploadPendingArtifacts({ rootDir, apiRootDir, projectId, setupKey, fetchImpl = fetch }) {
  const settings = loadSettings(rootDir);
  const apis = settings.apis || [];
  const entry = apis.find((a) => a.projectId === projectId)
    || (apiRootDir ? apis.find((a) => (a.rootDir || '.') === apiRootDir) : null)
    || apis[0];
  const result = { oas: 'none', settings: 'none', endpoints: 0 };

  const oasFile = entry?.oasFile;
  const oasPath = oasFile ? path.join(rootDir, oasFile) : null;
  if (oasPath && fs.existsSync(oasPath)) {
    try {
      const oasRaw = fs.readFileSync(oasPath, 'utf8');
      const isJson = oasPath.endsWith('.json');
      const res = await fetchImpl(`${SITE_URL}/api/projects/${projectId}/oas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key: setupKey, oas_raw: oasRaw, format: isJson ? 'json' : 'yaml' }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        result.oas = 'uploaded';
        try {
          const parsed = parseOas(oasRaw, isJson ? 'json' : 'yaml');
          if (parsed.ok) result.endpoints = countOperations(parsed.oas);
        } catch {}
      } else {
        result.oas = 'failed';
        result.error = `OAS upload failed (HTTP ${res.status}).`;
      }
    } catch (err) {
      result.oas = 'failed';
      result.error = `OAS upload error: ${err.message}`;
    }
  }

  if (apis.length) {
    try {
      const res = await fetchImpl(`${SITE_URL}/api/projects/${projectId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key: setupKey, settings }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        result.settings = 'failed';
        result.settingsError = `Settings upload skipped (HTTP ${res.status}).`;
      } else {
        result.settings = 'uploaded';
      }
    } catch (err) {
      result.settings = 'failed';
      result.settingsError = `Settings upload skipped: ${err.message}`;
    }
  }

  return result;
}

/**
 * Poll the dashboard for a log landing in `projectId` after `since`.
 * A clean SDK response header only proves capture; this is the other half
 * of the verdict - the upload actually arriving under the key's project.
 * Nothing landing after a clean header is the stale-key signature.
 *
 * Same endpoint and shape the guided test step uses. Returns true as soon
 * as a log shows up, false when `timeoutMs` runs out. Network errors are
 * treated as "not landed yet" - the caller already knows the server is up.
 */
export async function pollForLandedLog({
  projectId,
  setupKey,
  since,
  timeoutMs = 8000,
  delayMs = 1000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const res = await fetchImpl(`${SITE_URL}/api/logs/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, setupKey, since, limit: 5 }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) return true;
      }
    } catch {}
    if (Date.now() >= deadline) return false;
    await sleep(delayMs);
  }
}

export function recordProjectId({ rootDir, apiRootDir, projectId }) {
  const settings = loadSettings(rootDir);
  const key = apiRootDir || '.';
  const target = (settings.apis || []).find((a) => (a.rootDir || '.') === key) || settings.apis?.[0];
  if (target) target.projectId = projectId;
  saveSettings(rootDir, settings);
  return target || null;
}
