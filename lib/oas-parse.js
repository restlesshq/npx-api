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
