import fs from 'fs';
import path from 'path';

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
  '.git', '.restless', 'vendor', 'node_modules', 'testdata', 'dist', 'bin',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_DEPTH = 10;
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

function walk(dir, sourceFiles, manifests, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(full, sourceFiles, manifests, depth + 1);
    } else if (entry.isFile()) {
      if (MANIFESTS.includes(entry.name)) manifests.push(full);
      // `_test.go` files declare routes only for their own fixtures.
      else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        sourceFiles.push(full);
      }
    }
  }
}

export function scanGoCodebase(rootDir) {
  const sourceFiles = [];
  const manifestPaths = [];
  walk(rootDir, sourceFiles, manifestPaths, 0);

  const byDir = new Map();
  for (const abs of manifestPaths) {
    const absDir = path.dirname(abs);
    const meta = readManifest(abs);
    byDir.set(absDir, {
      absDir,
      package: path.relative(rootDir, absDir) || '.',
      name: meta.name,
      deps: meta.deps,
      strong: new Set(),
      weak: new Set(),
      endpointCount: 0,
    });
  }
  if (byDir.size === 0) {
    byDir.set(rootDir, {
      absDir: rootDir, package: '.', name: null, deps: [],
      strong: new Set(), weak: new Set(), endpointCount: 0,
    });
  }

  const packages = [...byDir.values()];
  const byDepth = [...packages].sort((a, b) => b.absDir.length - a.absDir.length);
  const ownerOf = (file) =>
    byDepth.find((p) => file === p.absDir || file.startsWith(p.absDir + path.sep)) || null;

  const endpoints = [];
  const filesWithEndpoints = new Set();

  for (const file of sourceFiles) {
    let content;
    try {
      if (fs.statSync(file).size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(rootDir, file);
    const hits = scanContent(content, rel);
    const owner = ownerOf(file);

    if (hits.length > 0) {
      endpoints.push(...hits);
      filesWithEndpoints.add(rel);
      if (owner) owner.endpointCount += hits.length;
    }
    if (owner) {
      for (const [re, label] of STRONG_MARKERS) {
        if (!owner.strong.has(label) && re.test(content)) owner.strong.add(label);
      }
      for (const [re, label] of WEAK_MARKERS) {
        if (!owner.weak.has(label) && re.test(content)) owner.weak.add(label);
      }
    }
  }

  const frameworkSignals = packages
    .map((p) => ({
      package: p.package,
      name: p.name,
      frameworkDeps: p.deps.filter(isFrameworkDep).sort(),
      oasGenDeps: p.deps.filter((d) => OAS_GEN_PATTERNS.some((re) => re.test(d))).sort(),
      sourceMarkers: [...p.strong, ...p.weak],
      endpointCount: p.endpointCount,
    }))
    .filter((p) => p.frameworkDeps.length > 0 || p.sourceMarkers.length > 0)
    .sort((a, b) => a.package.localeCompare(b.package));

  return {
    endpoints,
    filesWithEndpoints: [...filesWithEndpoints],
    scannedFileCount: sourceFiles.length,
    frameworkSignals,
  };
}
