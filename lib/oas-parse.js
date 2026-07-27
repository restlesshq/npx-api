import yaml from 'js-yaml';

// Mirrors app/src/app/api/projects/[projectId]/oas/route.ts. Keep in sync -
// failures here should be the same failures the server would report, so we
// can catch them locally and iterate before uploading.
export function parseOas(raw, format) {
  let oas;
  try {
    oas = format === 'json' ? JSON.parse(raw) : yaml.load(raw);
  } catch {
    try {
      oas = JSON.parse(raw);
    } catch {
      try {
        const fixed = raw.replace(/^(\s+example:\s*)(.+:.+)$/gm, (_m, indent, val) =>
          `${indent}"${val.replace(/"/g, '\\"')}"`,
        );
        oas = yaml.load(fixed);
      } catch (err) {
        return { ok: false, error: err?.message || 'Failed to parse OAS' };
      }
    }
  }

  if (!oas || typeof oas !== 'object') {
    return { ok: false, error: 'Parsed value is not an object' };
  }

  return { ok: true, oas };
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Count operations (method + path pairs) in a parsed OAS document. The one
 * number every surface reports for "how big is this API": `register` and the
 * agent plan both use it, so a path with three methods reads as 3 everywhere
 * instead of "1 path" in one place and "3 endpoints" in another.
 */
export function countOperations(oas) {
  let n = 0;
  for (const ops of Object.values(oas?.paths || {})) {
    for (const m of Object.keys(ops || {})) if (HTTP_METHODS.has(m.toLowerCase())) n++;
  }
  return n;
}
