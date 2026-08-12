import fs from 'fs';
import path from 'path';
import { COMMON_IGNORE_DIRS, scanTree } from './scan-tree.js';

/**
 * Deterministic endpoint + framework discovery for Python codebases.
 *
 * The Python counterpart to `find-endpoints.js`, returning the identical
 * shape so `buildFindingsSection` in generate-oas can render either without
 * branching. Same design too: walk once, read each file once, and extract
 * both route hits and per-package framework signals in the same pass.
 *
 * Routes are found four ways, because Python web frameworks disagree about
 * where a route lives:
 *
 *   1. Decorators - `@app.route("/pets")`, `@app.get("/pets")` (Flask 2.0+
 *      and every FastAPI app), `@router.post(...)` on an APIRouter.
 *   2. Django URLconfs - `path("pets/", ...)` / `re_path(...)` inside a
 *      `urlpatterns` list, where the route is an argument rather than a
 *      decorator and the file is conventionally named `urls.py`.
 *   3. Starlette route tables - `Route("/pets", endpoint, methods=[...])`.
 *   4. Flask's imperative form - `add_url_rule("/pets", ...)`.
 *
 * Framework signals exist for the same reason as in the JS scanner: a real
 * API can surface ZERO regex-visible endpoints. A Django project keeps its
 * routes in `urls.py` files that may only `include()` other modules, and a
 * FastAPI app can build routes from a generated schema. Without a separate
 * signal, such a package reads as "no API here" instead of "look harder".
 */

// The shared skips plus Python's own virtualenv / cache / build dirs.
const IGNORE_DIRS = new Set([
  ...COMMON_IGNORE_DIRS,
  '__pycache__', '.venv', 'venv', 'env', 'virtualenv', '.tox', '.nox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages',
  'build', 'dist', '.eggs', 'htmlcov',
]);


const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_DECORATORS = new Set(HTTP_METHODS.map((m) => m.toLowerCase()));

// Files that declare a project's dependencies. The nearest one above a source
// file owns it, the way the nearest package.json does in the JS scanner.
const MANIFESTS = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg'];

/**
 * `@app.route("/pets", methods=["GET"])`, `@app.get("/pets")`,
 * `@router.post("/pets", ...)`.
 *
 * The receiver is any identifier, because the variable is named by the user
 * (`app`, `router`, `bp`, `api`, `v1_router`). The trailing group grabs the
 * remaining arguments so `methods=[...]` can be read off `.route(...)`.
 */
const DECORATOR_RE = /@(\w+)\.(route|get|post|put|patch|delete|head|options)\s*\(\s*(['"])([^'"]*)\3([^)]*)\)?/g;

/** Django: `path("pets/", ...)`, `re_path(r"^pets/$", ...)`, legacy `url(...)`. */
const DJANGO_ROUTE_RE = /(?:^|[^\w.])(path|re_path|url)\s*\(\s*[rbuf]*(['"])([^'"]*)\2/g;

/** Starlette: `Route("/pets", endpoint, methods=["GET"])`. */
const STARLETTE_ROUTE_RE = /(?:^|[^\w.])(?:Route|WebSocketRoute)\s*\(\s*(['"])([^'"]*)\1([^)]*)\)?/g;

/** Flask imperative: `app.add_url_rule("/pets", view_func=..., methods=[...])`. */
const ADD_URL_RULE_RE = /\.add_url_rule\s*\(\s*(['"])([^'"]*)\1([^)]*)\)?/g;

/** `methods=["GET", "POST"]` / `methods=('GET',)` out of a trailing arg blob. */
function methodsFrom(tail) {
  if (!tail) return null;
  const m = tail.match(/methods\s*=\s*[[(]([^\])]*)[\])]/);
  if (!m) return null;
  const found = [...m[1].matchAll(/['"](\w+)['"]/g)]
    .map((x) => x[1].toUpperCase())
    .filter((x) => HTTP_METHODS.includes(x));
  return found.length ? found : null;
}

/**
 * Normalize a framework's parameter syntax to OpenAPI's `{name}`.
 *
 * Flask and Django write `<int:pet_id>` / `<pet_id>`; FastAPI already writes
 * `{pet_id}`. The Python SDK does this same normalization at runtime (see its
 * `_route_pattern`), so matching it here is what makes the generated spec
 * line up with the routes the dashboard actually receives.
 */
function normalizePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return null;
  // `<converter:name>` and `<name>` -> `{name}`.
  p = p.replace(/<(?:[^:>]+:)?([^>]+)>/g, '{$1}');
  // Django writes patterns without a leading slash, relative to their include.
  if (!p.startsWith('/')) p = `/${p}`;
  // A regex URLconf is not a usable path template; keep it recognizable but
  // do not pretend the anchors are part of the URL.
  p = p.replace(/^\/\^/, '/').replace(/\$$/, '');
  return p;
}

/** Is this a Django URLconf file? Route args there are paths, not strings. */
function looksLikeUrlConf(rel, content) {
  return path.basename(rel) === 'urls.py' || /\burlpatterns\s*=/.test(content);
}

function scanContent(content, rel) {
  const hits = [];

  for (const m of content.matchAll(DECORATOR_RE)) {
    const [, receiver, verb, , routePath, tail] = m;
    const normalized = normalizePath(routePath);
    if (!normalized) continue;
    const methods = verb === 'route'
      ? (methodsFrom(tail) || ['GET'])
      : [verb.toUpperCase()];
    for (const method of methods) {
      hits.push({ method, path: normalized, file: rel, style: 'decorator', receiver });
    }
  }

  if (looksLikeUrlConf(rel, content)) {
    for (const m of content.matchAll(DJANGO_ROUTE_RE)) {
      // `path("", views.index)` is the index route of whatever prefix this
      // URLconf is included under, so an empty pattern means `/` here rather
      // than "no path" the way it does for a decorator.
      const normalized = m[3] === '' ? '/' : normalizePath(m[3]);
      if (normalized === null) continue;
      hits.push({ method: 'GET', path: normalized, file: rel, style: 'urlconf' });
    }
  }

  for (const m of content.matchAll(STARLETTE_ROUTE_RE)) {
    const normalized = normalizePath(m[2]);
    if (!normalized) continue;
    for (const method of methodsFrom(m[3]) || ['GET']) {
      hits.push({ method, path: normalized, file: rel, style: 'route-table' });
    }
  }

  for (const m of content.matchAll(ADD_URL_RULE_RE)) {
    const normalized = normalizePath(m[2]);
    if (!normalized) continue;
    for (const method of methodsFrom(m[3]) || ['GET']) {
      hits.push({ method, path: normalized, file: rel, style: 'add-url-rule' });
    }
  }

  // De-duplicate: a decorator stack (`@app.get` + `@app.post` on one handler)
  // is two hits, but the same route matched by two patterns is one.
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.method} ${h.path} ${h.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Dependencies that identify an HTTP framework. */
function isFrameworkDep(name) {
  return /^(flask|fastapi|django|starlette|quart|bottle|pyramid|falcon|sanic|tornado|aiohttp|connexion|litestar|blacksheep|responder|hug|eve|masonite)$/.test(name)
    || /^(djangorestframework|django-ninja|flask-restful|flask-restx|flask-smorest|apiflask|fastapi-users)$/.test(name);
}

/**
 * Dependencies that let a framework emit an OpenAPI spec natively. Mirrors
 * the JS scanner's `OAS_GEN_DEPS`, and drives the "we can ask the framework
 * for a spec instead of writing one" offer in generate-oas.
 */
const OAS_GEN_DEPS = new Set([
  'fastapi',            // /openapi.json out of the box
  'apiflask',
  'flask-smorest',
  'flask-restx',
  'drf-spectacular',
  'drf-yasg',
  'connexion',
  'litestar',
  'django-ninja',
  'sanic-ext',
]);

/** Source markers that reveal the framework actually handling requests. */
const STRONG_MARKERS = [
  [/\bFlask\s*\(/, 'Flask()'],
  [/\bFastAPI\s*\(/, 'FastAPI()'],
  [/\bAPIRouter\s*\(/, 'APIRouter()'],
  [/\bBlueprint\s*\(/, 'Blueprint()'],
  [/\bStarlette\s*\(/, 'Starlette()'],
  [/\bQuart\s*\(/, 'Quart()'],
  [/\bget_wsgi_application\s*\(/, 'get_wsgi_application()'],
  [/\bget_asgi_application\s*\(/, 'get_asgi_application()'],
  [/\burlpatterns\s*=/, 'urlpatterns'],
  [/\bDJANGO_SETTINGS_MODULE\b/, 'DJANGO_SETTINGS_MODULE'],
];
const WEAK_MARKERS = [
  [/\binclude_router\s*\(/, 'include_router()'],
  [/\bregister_blueprint\s*\(/, 'register_blueprint()'],
  [/\badd_middleware\s*\(/, 'add_middleware()'],
];

/**
 * Pull dependency names out of any of Python's manifest formats.
 *
 * Deliberately regex-based rather than a real TOML/INI parse: we only need
 * the NAMES, every format quotes or line-separates them, and a scanner that
 * throws on an exotic manifest is worse than one that under-reports.
 */
function readManifest(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { name: null, deps: [] };
  }
  const base = path.basename(abs);
  const deps = new Set();

  const add = (raw) => {
    // Strip extras, markers and version specifiers: `uvicorn[standard]>=0.2`.
    const cleaned = String(raw).trim().toLowerCase()
      .split(/[;#]/)[0]
      .replace(/\[.*?\]/g, '')
      .split(/[<>=!~ ]/)[0]
      .trim();
    if (cleaned) deps.add(cleaned);
  };

  if (base === 'requirements.txt') {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('-')) continue;
      add(t);
    }
  } else {
    // pyproject.toml / Pipfile / setup.py / setup.cfg. Quoted strings cover
    // PEP 621 `dependencies = [...]`, Poetry tables and Pipfile `[packages]`;
    // bare `key = "version"` lines cover Poetry/Pipfile entries.
    for (const m of text.matchAll(/["']([A-Za-z][\w.-]*(?:\[[^\]]*\])?[^"']*)["']/g)) add(m[1]);
    for (const m of text.matchAll(/^\s*([A-Za-z][\w.-]*)\s*=\s*[["'{]/gm)) add(m[1]);
  }

  let name = null;
  const nameMatch = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (nameMatch) name = nameMatch[1];

  return { name, deps: [...deps] };
}


/**
 * Single-pass scan of a Python codebase. Returns the same shape as
 * `scanCodebase` in find-endpoints.js:
 *
 *   { endpoints, filesWithEndpoints, scannedFileCount, frameworkSignals }
 */
export function scanPythonCodebase(rootDir) {
  return scanTree(rootDir, {
    ignoreDirs: IGNORE_DIRS,
    isManifest: (name) => MANIFESTS.includes(name),
    isSource: (name) => path.extname(name) === '.py',
    readManifest,
    scanContent,
    strongMarkers: STRONG_MARKERS,
    weakMarkers: WEAK_MARKERS,
    isFrameworkDep,
    isOasGenDep: (d) => OAS_GEN_DEPS.has(d),
  });
}
