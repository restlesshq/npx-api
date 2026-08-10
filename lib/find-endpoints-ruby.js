import fs from 'fs';
import path from 'path';
import { COMMON_IGNORE_DIRS, scanTree } from './scan-tree.js';

/**
 * Deterministic endpoint + framework discovery for Ruby codebases.
 *
 * Same return shape as the JavaScript and Python scanners so `lib/scanners.js`
 * merges all three without knowing how many ran.
 *
 * Ruby spreads routes across three quite different declarations:
 *
 *   1. **Sinatra / Roda / Grape blocks** - `get "/pets" do`, the closest
 *      thing to the decorator style the other languages use.
 *   2. **A Rails URL DSL** in `config/routes.rb`, where most routes are not
 *      written out at all: `resources :pets` stands for five API endpoints,
 *      and `namespace` / `scope` blocks prefix everything nested inside them.
 *   3. **Explicit Rails verbs** - `get "pets", to: "pets#index"`.
 *
 * Route templates are normalized to `{param}` exactly as the SDK does at
 * runtime (`Middleware.normalize_route_pattern` in the Ruby SDK: strip the
 * leading verb, drop Rails' `(.:format)`, rewrite `:id`). Matching it is what
 * makes a generated spec line up with the logs the dashboard receives.
 */

const IGNORE_DIRS = new Set([
  ...COMMON_IGNORE_DIRS,
  'vendor', 'tmp', 'log', 'coverage', 'public', '.bundle', 'bin', 'db',
]);

const SOURCE_EXTS = new Set(['.rb', '.ru']);
const MANIFESTS = ['Gemfile', 'gems.rb'];

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * `get "/pets" do` (Sinatra, Roda, Grape) and `get "pets", to: "pets#index"`
 * (Rails). One pattern covers both: the verb, then a quoted path.
 */
const VERB_ROUTE_RE = new RegExp(
  String.raw`(?:^|[^\w.])(${VERBS.join('|')})\s+(['"])([^'"]*)\2`,
  'gm',
);

/** `resources :pets`, `resource :session`, with an optional `only:` list. */
const RESOURCES_RE = /(?:^|[^\w.])(resources?)\s+:([A-Za-z_]\w*)([^\n]*)/gm;

/** `namespace :api do` / `scope "/v1" do` / `scope path: "/v1" do`. */
const SCOPE_RE = /(?:^|[^\w.])(namespace|scope)\s+(?::([A-Za-z_]\w*)|(['"])([^'"]*)\3|path:\s*(['"])([^'"]*)\5)/;

/** `root "home#index"` / `root to: "home#index"`. */
const ROOT_RE = /(?:^|[^\w.])root\s+(?:to:\s*)?['"]/;

/**
 * Normalize a route the way the SDK does at runtime, so one endpoint groups
 * identically in the spec and in the dashboard.
 */
function normalizePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return null;
  p = p.replace(/^[A-Z]+[ \t]+/, '');        // a leading verb, as Sinatra stores it
  p = p.replace(/\(\.:format\)$/, '');        // Rails' optional format suffix
  p = p.replace(/:([A-Za-z_]\w*)/g, '{$1}');  // :id -> {id}
  p = p.replace(/\*([A-Za-z_]\w*)/g, '{$1}'); // splat
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

function joinPath(prefix, rest) {
  const a = (prefix || '').replace(/\/$/, '');
  const b = rest.startsWith('/') ? rest : `/${rest}`;
  const joined = `${a}${b}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

/** Is this a Rails URL map? Its DSL means different things than a Sinatra app. */
function looksLikeRoutesFile(rel, content) {
  return path.basename(rel) === 'routes.rb' || /Rails\.application\.routes\.draw/.test(content);
}

/**
 * The actions `resources :pets` stands for.
 *
 * Only the five that serve data. `new` and `edit` render HTML forms and do
 * not exist at all in an `api_only` app, so emitting them would invent two
 * endpoints per resource that the API does not have. `only:` and `except:`
 * are honoured when present.
 */
const RESOURCE_ACTIONS = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'show', method: 'GET', suffix: '/{id}' },
  { action: 'update', method: 'PATCH', suffix: '/{id}' },
  { action: 'destroy', method: 'DELETE', suffix: '/{id}' },
];

function actionsFor(tail) {
  const only = tail.match(/only:\s*(?:\[([^\]]*)\]|:(\w+))/);
  const except = tail.match(/except:\s*(?:\[([^\]]*)\]|:(\w+))/);
  const names = (m) => (m ? [...(m[1] || m[2] || '').matchAll(/(\w+)/g)].map((x) => x[1]) : null);
  const keep = names(only);
  const drop = names(except);
  return RESOURCE_ACTIONS.filter((a) => {
    if (keep) return keep.includes(a.action);
    if (drop) return !drop.includes(a.action);
    return true;
  });
}

/**
 * Walk a Rails URLconf line by line, tracking `namespace` / `scope` nesting
 * so routes declared inside them carry their prefix.
 *
 * A brace/`do`-depth stack rather than a parser: the DSL is regular enough
 * that "a line opening a block pushes, a line that is only `end` pops" holds,
 * and the failure mode of getting it wrong is a missing prefix rather than a
 * wrong one.
 */
function scanRoutesFile(content, rel) {
  const hits = [];
  const stack = [];
  let depth = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    if (!line.trim()) continue;

    if (/^\s*end\b/.test(line)) {
      depth = Math.max(0, depth - 1);
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      continue;
    }

    // Each frame already holds the CUMULATIVE prefix, so the current one is
    // the innermost frame - joining them all would repeat every outer
    // segment (`namespace :api` + `scope "/v1"` came out as /api/api/v1).
    const prefix = stack.length ? stack[stack.length - 1].prefix : '';
    const opensBlock = /\bdo\s*(\|[^|]*\|)?\s*$/.test(line);

    const resources = [...line.matchAll(RESOURCES_RE)];
    if (resources.length) {
      for (const [, kind, name, tail] of resources) {
        const base = joinPath(prefix, name);
        for (const a of actionsFor(tail)) {
          // `resource` (singular) has no collection index and no :id.
          if (kind === 'resource' && a.action === 'index') continue;
          const p = kind === 'resource' ? base : `${base}${a.suffix}`;
          hits.push({ method: a.method, path: normalizePath(p), file: rel, style: 'rails-resources' });
        }
        if (opensBlock) stack.push({ prefix: joinPath(prefix, name), depth: depth + 1 });
      }
      if (opensBlock) depth++;
      continue;
    }

    const scope = line.match(SCOPE_RE);
    if (scope && opensBlock) {
      const name = scope[2] || scope[4] || scope[6] || '';
      stack.push({ prefix: name ? joinPath(prefix, name) : prefix, depth: depth + 1 });
      depth++;
      continue;
    }

    for (const m of line.matchAll(new RegExp(VERB_ROUTE_RE.source, 'g'))) {
      const [, verb, , routePath] = m;
      const p = normalizePath(joinPath(prefix, routePath));
      if (p) hits.push({ method: verb.toUpperCase(), path: p, file: rel, style: 'rails-route' });
    }

    if (ROOT_RE.test(line)) {
      hits.push({ method: 'GET', path: normalizePath(prefix || '/'), file: rel, style: 'rails-route' });
    }

    if (opensBlock) depth++;
  }

  return hits;
}

/** Sinatra / Roda / Grape blocks, which carry their own path inline. */
function scanBlockRoutes(content, rel) {
  const hits = [];
  for (const m of content.matchAll(new RegExp(VERB_ROUTE_RE.source, 'gm'))) {
    const [, verb, , routePath] = m;
    const p = normalizePath(routePath);
    if (p) hits.push({ method: verb.toUpperCase(), path: p, file: rel, style: 'block' });
  }
  return hits;
}

function scanContent(content, rel) {
  const hits = looksLikeRoutesFile(rel, content)
    ? scanRoutesFile(content, rel)
    : scanBlockRoutes(content, rel);

  const seen = new Set();
  return hits.filter((h) => {
    if (!h.path) return false;
    const k = `${h.method} ${h.path} ${h.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isFrameworkDep(name) {
  return /^(rails|railties|actionpack|sinatra|hanami|grape|roda|rack|padrino|cuba)$/.test(name)
    || /^(grape-entity|sinatra-contrib|hanami-api|rails-api)$/.test(name);
}

/** Gems that can emit an OpenAPI document themselves. */
const OAS_GEN_DEPS = new Set([
  'rswag', 'rswag-api', 'rswag-specs', 'grape-swagger', 'swagger-blocks',
  'apipie-rails', 'oas_rails', 'rspec-openapi', 'committee',
]);

const STRONG_MARKERS = [
  [/Rails\.application\.routes\.draw/, 'routes.draw'],
  [/<\s*Rails::Application/, 'Rails::Application'],
  [/<\s*Sinatra::(Base|Application)/, 'Sinatra::Base'],
  [/<\s*Grape::API/, 'Grape::API'],
  [/<\s*Roda\b/, 'Roda'],
  [/Hanami::API/, 'Hanami::API'],
  [/\brun\s+[A-Z]\w*/, 'rackup run'],
];
const WEAK_MARKERS = [
  [/^\s*use\s+[A-Z]/m, 'use middleware'],
  [/config\.middleware\./, 'config.middleware'],
];

/** Gem names out of a Gemfile or gemspec. */
function readManifest(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { name: null, deps: [] };
  }
  const deps = new Set();
  for (const m of text.matchAll(/^\s*(?:gem|spec\.add(?:_runtime|_development)?_dependency)\s+["']([^"']+)["']/gm)) {
    deps.add(m[1].toLowerCase());
  }
  const nameMatch = text.match(/\.name\s*=\s*["']([^"']+)["']/);
  return { name: nameMatch ? nameMatch[1] : null, deps: [...deps] };
}


export function scanRubyCodebase(rootDir) {
  return scanTree(rootDir, {
    ignoreDirs: IGNORE_DIRS,
    isManifest: (name) => MANIFESTS.includes(name) || name.endsWith('.gemspec'),
    isSource: (name) => SOURCE_EXTS.has(path.extname(name)) || name === 'config.ru',
    readManifest,
    scanContent,
    strongMarkers: STRONG_MARKERS,
    weakMarkers: WEAK_MARKERS,
    isFrameworkDep,
    isOasGenDep: (d) => OAS_GEN_DEPS.has(d),
  });
}
