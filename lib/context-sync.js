import { SITE_URL } from './config.js';

/**
 * Talking to the dashboard about one repo's context.
 *
 * Two calls: ask what this repo was last indexed at (so the run can be
 * incremental) and hand over what this run found. Both authenticate with the
 * account-scoped session from `context-auth.js`, and both are scoped to one
 * project by its projectId in the path.
 */

/** Query string for the repo descriptor, so the server can find its watermark. */
function repoQuery(repo) {
  const params = new URLSearchParams();
  if (repo.host) params.set('host', repo.host);
  if (repo.owner) params.set('owner', repo.owner);
  if (repo.repo) params.set('repo', repo.repo);
  if (repo.rootPath) params.set('rootPath', repo.rootPath);
  if (repo.localId) params.set('localId', repo.localId);
  return params;
}

/**
 * What the project already knows, and when this repo was last read.
 *
 * Returns `{ ok: true, project, existing, source, reviewUrl }` or
 * `{ ok: false, expired?, error }`. `existing` is titles only - the CLI uses
 * them to steer the extraction away from re-proposing what is saved, and has
 * no use for the bodies.
 */
export async function fetchScope({ projectId, token, repo }) {
  const params = repoQuery(repo);
  params.set('token', token);
  try {
    const res = await fetch(
      `${SITE_URL}/api/projects/${projectId}/context?${params.toString()}`,
      { cache: 'no-store', signal: AbortSignal.timeout(15000) },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Your session expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `Couldn't read the project's context (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}`,
      };
    }
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, error: `Couldn't read the project's context: ${err.message}` };
  }
}

/**
 * Hand this run's candidates to the inbox.
 *
 * Everything lands as pending for a human to approve; there is no mode in
 * which this publishes. The response reports what the server's own safety pass
 * made of them, which is how the CLI can tell the developer that something was
 * dropped on arrival rather than silently vanishing.
 */
export async function pushCandidates({ projectId, token, repo, run, candidates }) {
  try {
    const res = await fetch(`${SITE_URL}/api/projects/${projectId}/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, repo, run, candidates }),
      // Generous: the server runs a safety review per candidate before it
      // answers, and that is a model call apiece.
      signal: AbortSignal.timeout(180000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Your session expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `Upload failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}`,
      };
    }
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, error: `Upload failed: ${err.message}` };
  }
}
