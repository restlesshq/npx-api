import {
  getAuthForOperation,
  authToCurlFragment,
} from './oas-auth.js';

const UNSAFE_PATH_PATTERNS = [
  /\/admin(\/|$)/i,
  /\/internal(\/|$)/i,
  /\/private(\/|$)/i,
  /\/_\//,
  /\/debug(\/|$)/i,
];

/**
 * Walk an OAS and return up to `max` GET-ish operations that look safe to
 * hit blindly. Each candidate carries enough metadata for the LLM picker
 * (and the curl builder) to do its job without re-reading the spec.
 *
 * Ranking: fewer path params first, then shorter paths, then alphabetical.
 * The picker only sees the top `max`, so this is where taste lives.
 */
export function findTestCandidates(oas, { max = 10 } = {}) {
  if (!oas?.paths) return [];

  const candidates = [];
  for (const [pathKey, pathItem] of Object.entries(oas.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    if (UNSAFE_PATH_PATTERNS.some((re) => re.test(pathKey))) continue;

    for (const method of ['get', 'head']) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      if (op.deprecated) continue;
      if (op['x-internal']) continue;

      const params = collectParams(pathItem, op);
      const pathParams = params.filter((p) => p.in === 'path');
      const requiredQuery = params.filter((p) => p.in === 'query' && p.required);

      candidates.push({
        method: method.toUpperCase(),
        path: pathKey,
        summary: op.summary || '',
        description: truncate(op.description || '', 200),
        operationId: op.operationId || '',
        tags: op.tags || [],
        pathParams: pathParams.map((p) => ({
          name: p.name,
          example: pickExample(p),
        })),
        requiredQuery: requiredQuery.map((p) => ({
          name: p.name,
          example: pickExample(p),
        })),
      });
    }
  }

  candidates.sort((a, b) => {
    const ap = a.pathParams.length;
    const bp = b.pathParams.length;
    if (ap !== bp) return ap - bp;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  return candidates.slice(0, max);
}

function collectParams(pathItem, op) {
  const out = [];
  const seen = new Set();
  for (const list of [pathItem.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p || typeof p !== 'object' || !p.name || !p.in) continue;
      const key = `${p.in}:${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function pickExample(param) {
  if (param.example !== undefined) return String(param.example);
  if (param.examples && typeof param.examples === 'object') {
    const first = Object.values(param.examples)[0];
    if (first?.value !== undefined) return String(first.value);
  }
  const schema = param.schema || {};
  if (schema.example !== undefined) return String(schema.example);
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (schema.default !== undefined) return String(schema.default);

  // Type-aware fallback so we never end up with `{id}` literally in a curl.
  const type = schema.type || 'string';
  if (type === 'integer' || type === 'number') return '1';
  if (type === 'boolean') return 'true';
  if (/id$/i.test(param.name)) return '1';
  return 'example';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Build a curl command for a chosen candidate, given the API's base URL
 * and OAS (so we can attach the right auth headers/query).
 *
 * Returns a string ending with `API_KEY_HERE` when auth is required, so the
 * user has one obvious place to paste their key.
 */
export function buildCurl(oas, candidate, baseUrl) {
  const base = (baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  let path = candidate.path;
  for (const p of candidate.pathParams) {
    path = path.replace(`{${p.name}}`, encodeURIComponent(p.example));
  }

  const queryParts = candidate.requiredQuery.map(
    (p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.example)}`,
  );
  const url = queryParts.length ? `${base}${path}?${queryParts.join('&')}` : `${base}${path}`;

  const parts = ['curl -sS'];
  if (candidate.method !== 'GET') parts.push(`-X ${candidate.method}`);
  parts.push(url);

  const auth = getAuthForOperation(oas, candidate.method, candidate.path);
  const fragment = authToCurlFragment(auth);
  if (fragment) parts.push(fragment);

  return parts.join(' ');
}
