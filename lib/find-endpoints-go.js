import fs from 'fs';
import path from 'path';
import { COMMON_IGNORE_DIRS, scanTree } from './scan-tree.js';

/**
 * Deterministic endpoint + framework discovery for Go codebases.
 *
 * Same return shape as the other three scanners so `lib/scanners.js` merges
 * them without knowing how many ran.
 *
 * Go routers disagree about where the METHOD lives, which is the whole
 * problem here:
 *
 *   1. **stdlib ServeMux, Go 1.22+** puts it inside the pattern string:
 *      `mux.HandleFunc("GET /pets/{id}", h)`.
 *   2. **stdlib ServeMux, older** has no method at all:
 *      `mux.HandleFunc("/pets", h)`.
 *   3. **chi, gin, echo** put it in the call name: `r.Get("/pets", h)`,
 *      `r.GET(...)`, `e.GET(...)`.
 *   4. **gorilla/mux** puts it in a chained call:
 *      `r.HandleFunc("/pets", h).Methods("GET")`.
 *
 * Go mostly writes `{id}` already (stdlib patterns and chi), so
 * normalization is only needed for gin and echo's `:id`.
 */

const IGNORE_DIRS = new Set([
  ...COMMON_IGNORE_DIRS,
  'vendor', 'testdata', 'dist', 'bin',
]);

const MANIFESTS = ['go.mod'];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * `mux.HandleFunc("GET /pets/{id}", h)` and `mux.Handle("/pets", h)`.
 * The method is inside the pattern on Go 1.22+ and absent before it.
 *
 * The tail runs to end of line rather than to the closing paren, because
 * gorilla/mux puts the method in a call CHAINED after it -
 * `.HandleFunc("/orders", h).Methods("GET", "POST")` - which stopping at the
 * first `)` would never see.
 */
const HANDLE_RE = /\.(?:HandleFunc|Handle)\s*\(\s*"([^"]*)"([^\n]*)/g;

/**
 * Verb-named methods: chi's `r.Get`, gin and echo's `r.GET`. Matched
 * case-insensitively on the verb but anchored so `r.Getenv` cannot match.
 */
const VERB_CALL_RE = new RegExp(
  String.raw`\.(${METHODS.map((m) => `${m[0]}${m.slice(1).toLowerCase()}|${m}`).join('|')})\s*\(\s*"([^"]*)"`,
  'g',
);

/** chi's `r.Route("/api", func(r chi.Router) {` and gin's `r.Group("/api")`. */
const GROUP_RE = /\.(?:Route|Group|PathPrefix)\s*\(\s*"([^"]*)"/;

/** Normalize gin/echo `:id` and `*splat` to `{id}`; stdlib is already `{id}`. */
function normalizePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return null;
  p = p.replace(/^[A-Z]+\s+/, '');           // a method prefix inside the pattern
  p = p.replace(/:([A-Za-z_]\w*)/g, '{$1}');
  p = p.replace(/\*([A-Za-z_]\w*)/g, '{$1}');
  p = p.replace(/\{([A-Za-z_]\w*)\.\.\.\}/g, '{$1}'); // stdlib wildcard `{path...}`
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

function joinPath(prefix, rest) {
  const a = (prefix || '').replace(/\/$/, '');
  const b = rest.startsWith('/') ? rest : `/${rest}`;
  const joined = `${a}${b}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

/** `.Methods("GET", "POST")` chained after a gorilla/mux HandleFunc. */
function methodsFrom(tail) {
  if (!tail) return null;
  const m = tail.match(/\.Methods\s*\(([^)]*)\)/);
  if (!m) return null;
  const found = [...m[1].matchAll(/"(\w+)"/g)]
    .map((x) => x[1].toUpperCase())
    .filter((x) => METHODS.includes(x));
  return found.length ? found : null;
}

/**
 * Scan one file, tracking `Route`/`Group` nesting so a route declared inside
 * a subrouter carries its prefix. Brace depth, not a parser: the failure mode
 * is a missing prefix rather than a wrong one.
 */
function scanContent(content, rel) {
  const hits = [];
  const stack = [];
  let depth = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');
    if (!line.trim()) continue;

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    const prefix = stack.length ? stack[stack.length - 1].prefix : '';

    const group = line.match(GROUP_RE);
    // A group only nests when the line opens a block; `r.Group("/api")`
    // assigned to a variable does not, and treating it as nesting would
    // prefix every later route in the file.
    if (group && opens > closes) {
      stack.push({ prefix: joinPath(prefix, group[1]), depth: depth + 1 });
    }

    for (const m of line.matchAll(new RegExp(HANDLE_RE.source, 'g'))) {
      const [, pattern, tail] = m;
      // Split the Go 1.22+ `"GET /pets"` form BEFORE joining any prefix -
      // joining first turns it into `/GET /pets` and the method survives
      // into the path.
      const inline = pattern.match(/^([A-Z]+)\s+(.*)$/);
      const bare = inline ? inline[2] : pattern;
      const normalized = normalizePath(joinPath(prefix, bare));
      if (!normalized) continue;
      // Method inside the pattern (Go 1.22+), chained .Methods (gorilla), or
      // unknown - in which case GET is a placeholder for the checklist.
      const methods = inline ? [inline[1]] : (methodsFrom(tail) || ['GET']);
      for (const method of methods) {
        if (!METHODS.includes(method)) continue;
        hits.push({ method, path: normalized, file: rel, style: 'handler' });
      }
    }

    for (const m of line.matchAll(new RegExp(VERB_CALL_RE.source, 'g'))) {
      const [, verb, pattern] = m;
      const normalized = normalizePath(joinPath(prefix, pattern));
      if (normalized) {
        hits.push({ method: verb.toUpperCase(), path: normalized, file: rel, style: 'verb-call' });
      }
    }

    depth += opens - closes;
    while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
  }

  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.method} ${h.path} ${h.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isFrameworkDep(name) {
  return /^github\.com\/(go-chi\/chi|gorilla\/mux|gin-gonic\/gin|labstack\/echo|julienschmidt\/httprouter|gofiber\/fiber|go-martini\/martini|urfave\/negroni)/.test(name)
    || /^github\.com\/(beego\/beego|astaxie\/beego|emicklei\/go-restful)/.test(name);
}

/** Modules that can emit an OpenAPI document. */
const OAS_GEN_PATTERNS = [
  /^github\.com\/swaggo\//,
  /^github\.com\/go-swagger\//,
  /^github\.com\/deepmap\/oapi-codegen/,
  /^github\.com\/getkin\/kin-openapi/,
  /^github\.com\/danielgtaylor\/huma/,
];

const STRONG_MARKERS = [
  [/http\.NewServeMux\s*\(/, 'http.NewServeMux()'],
  [/chi\.NewRouter\s*\(/, 'chi.NewRouter()'],
  [/mux\.NewRouter\s*\(/, 'mux.NewRouter()'],
  [/gin\.(?:Default|New)\s*\(/, 'gin.Default()'],
  [/echo\.New\s*\(/, 'echo.New()'],
  [/fiber\.New\s*\(/, 'fiber.New()'],
  [/http\.ListenAndServe(?:TLS)?\s*\(/, 'http.ListenAndServe()'],
  [/http\.Server\s*\{/, 'http.Server{}'],
];
const WEAK_MARKERS = [
  [/\.Use\s*\(/, '.Use()'],
  [/http\.HandlerFunc\s*\(/, 'http.HandlerFunc()'],
];

/** Module requirements out of a go.mod. */
function readManifest(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { name: null, deps: [] };
  }
  const deps = new Set();
  for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9][\w./-]*\.[a-z]{2,}\/[\w./-]+)\s+v/gm)) {
    deps.add(m[1].toLowerCase());
  }
  const nameMatch = text.match(/^\s*module\s+(\S+)/m);
  return { name: nameMatch ? nameMatch[1] : null, deps: [...deps] };
}


export function scanGoCodebase(rootDir) {
  return scanTree(rootDir, {
    ignoreDirs: IGNORE_DIRS,
    isManifest: (name) => MANIFESTS.includes(name),
    // `_test.go` files declare routes only for their own fixtures.
    isSource: (name) => name.endsWith('.go') && !name.endsWith('_test.go'),
    readManifest,
    scanContent,
    strongMarkers: STRONG_MARKERS,
    weakMarkers: WEAK_MARKERS,
    isFrameworkDep,
    isOasGenDep: (d) => OAS_GEN_PATTERNS.some((re) => re.test(d)),
  });
}
