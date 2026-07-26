import fs from 'fs';
import path from 'path';

/**
 * Best-effort guess at an API's production base URL, so the setup prompt
 * arrives pre-filled instead of asking the user to go look it up.
 *
 * Everything here is a local read of committed files - deployment manifests,
 * env TEMPLATES (`.env.example` and friends, never a real `.env`), the
 * README. Nothing is sent anywhere; the guess is offered as an editable
 * default the user can accept with one keystroke or type over.
 *
 * Ordered by how deliberate the signal is: a spec's `servers` entry or a
 * deploy manifest is a decision someone made, a README URL is a decent
 * inference, and `package.json`'s `homepage` is often a marketing site, so
 * it goes last.
 */

// Hosts that appear in READMEs and configs but are never someone's API.
const NEVER_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'example.com', 'example.org', 'acme.com',
  'github.com', 'raw.githubusercontent.com', 'gitlab.com',
  'npmjs.com', 'www.npmjs.com', 'img.shields.io', 'shields.io',
  'codecov.io', 'travis-ci.org', 'circleci.com', 'badge.fury.io',
  'openapis.org', 'spec.openapis.org', 'json-schema.org', 'swagger.io',
  'opensource.org', 'choosealicense.com', 'nodejs.org', 'npmtrends.com',
];

/** Is this a URL we'd be willing to show as someone's production API? */
export function isPlausibleBaseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url.trim()); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (NEVER_HOSTS.includes(host)) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  // A bare hostname with no dot is a container/service name, not public.
  if (!host.includes('.')) return false;
  return true;
}

/** Trailing slashes only ever cause double-slash bugs downstream. */
export function normalize(url) {
  if (!url) return null;
  const trimmed = String(url).trim().replace(/[)>,.'"`]+$/, '');
  if (!isPlausibleBaseUrl(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

/** `servers[0].url` from a spec the user (or their framework) wrote. */
export function fromOas(oas) {
  for (const server of oas?.servers || []) {
    const url = normalize(server?.url);
    if (url) return url;
  }
  return null;
}

/** fly.toml: `app = "my-api"` publishes at `<app>.fly.dev`. */
export function fromFlyToml(text) {
  const m = String(text).match(/^\s*app\s*=\s*["']([\w-]+)["']/m);
  return m ? normalize(`https://${m[1]}.fly.dev`) : null;
}

/** render.yaml: the first web service's name maps to `<name>.onrender.com`. */
export function fromRenderYaml(text) {
  const lines = String(text).split('\n');
  let name = null;
  let sawWeb = false;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-?\s*name:\s*["']?([\w-]+)["']?\s*$/);
    if (nameMatch) name = nameMatch[1];
    if (/^\s*type:\s*web\s*$/.test(line)) { sawWeb = true; break; }
  }
  return sawWeb && name ? normalize(`https://${name}.onrender.com`) : null;
}

/** vercel.json: an `alias` is the domain the deployment answers on. */
export function fromVercelJson(text) {
  try {
    const cfg = JSON.parse(text);
    const alias = Array.isArray(cfg.alias) ? cfg.alias[0] : cfg.alias;
    if (alias) return normalize(/^https?:\/\//.test(alias) ? alias : `https://${alias}`);
  } catch {}
  return null;
}

/** serverless.yml with the domain-manager plugin: `domainName: api.x.com`. */
export function fromServerless(text) {
  const m = String(text).match(/domainName:\s*["']?([\w.-]+\.[a-z]{2,})["']?/i);
  return m ? normalize(`https://${m[1]}`) : null;
}

/** Traefik routing labels in compose files: ``Host(`api.example.com`)``. */
export function fromCompose(text) {
  const m = String(text).match(/Host\(\s*[`"']([\w.-]+\.[a-z]{2,})[`"']\s*\)/i);
  return m ? normalize(`https://${m[1]}`) : null;
}

/** A Kubernetes Ingress rule: `- host: api.example.com`. */
export function fromIngress(text) {
  if (!/kind:\s*Ingress/i.test(text)) return null;
  const m = String(text).match(/^\s*-?\s*host:\s*["']?([\w.-]+\.[a-z]{2,})["']?/m);
  return m ? normalize(`https://${m[1]}`) : null;
}

// Env var names that hold an API's own address, most specific first.
const ENV_KEYS = [
  'API_BASE_URL', 'API_URL', 'BASE_URL', 'PUBLIC_API_URL', 'SERVER_URL',
  'APP_URL', 'PUBLIC_URL', 'NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'HOST_URL',
];

/**
 * An env TEMPLATE (`.env.example`), never a real `.env`. Templates are
 * committed and usually carry the production value as an illustration; real
 * env files hold secrets and are off-limits.
 */
export function fromEnvTemplate(text) {
  const lines = String(text).split('\n');
  for (const key of ENV_KEYS) {
    for (const line of lines) {
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?([^"'\\s#]+)`));
      const url = m && normalize(m[1]);
      if (url) return url;
    }
  }
  return null;
}

/** package.json `homepage` - often a docs or marketing site, so it ranks low. */
export function fromPackageJson(text) {
  try {
    return normalize(JSON.parse(text).homepage);
  } catch {
    return null;
  }
}

/**
 * A README's own examples. Prefer URLs that look like an API (an `api.`
 * host, or a versioned/`/api` path) over a project's marketing link, and
 * prefer ones inside a curl example over prose.
 */
export function fromReadme(text) {
  const urls = String(text).match(/https?:\/\/[^\s"'`)<>\]]+/g) || [];
  const candidates = urls.map(normalize).filter(Boolean);
  const apiish = candidates.filter((u) => {
    try {
      const { hostname, pathname } = new URL(u);
      return /^api[.-]/.test(hostname) || /\/(api|v\d+)(\/|$)/.test(pathname);
    } catch { return false; }
  });
  const pick = apiish[0] || null;
  if (!pick) return null;
  // Keep scheme + host + any mount prefix, drop a specific endpoint path.
  try {
    const u = new URL(pick);
    const prefix = u.pathname.match(/^\/(api|v\d+)(\/(api|v\d+))?/);
    return normalize(`${u.protocol}//${u.host}${prefix ? prefix[0] : ''}`);
  } catch {
    return pick;
  }
}

// Where to look, in order. Each entry names a file and the parser for it.
const FILE_SOURCES = [
  { file: 'fly.toml', parse: fromFlyToml },
  { file: 'render.yaml', parse: fromRenderYaml },
  { file: 'render.yml', parse: fromRenderYaml },
  { file: 'vercel.json', parse: fromVercelJson },
  { file: 'serverless.yml', parse: fromServerless },
  { file: 'serverless.yaml', parse: fromServerless },
  { file: 'docker-compose.yml', parse: fromCompose },
  { file: 'docker-compose.yaml', parse: fromCompose },
  { file: 'compose.yml', parse: fromCompose },
  { file: 'ingress.yaml', parse: fromIngress },
  { file: 'ingress.yml', parse: fromIngress },
  { file: 'k8s/ingress.yaml', parse: fromIngress },
  { file: '.env.example', parse: fromEnvTemplate },
  { file: '.env.sample', parse: fromEnvTemplate },
  { file: '.env.template', parse: fromEnvTemplate },
  { file: 'README.md', parse: fromReadme },
  { file: 'readme.md', parse: fromReadme },
  { file: 'package.json', parse: fromPackageJson },
];

const MAX_BYTES = 512 * 1024;

function read(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Guess the base URL for an API. `dirs` are searched in order (the API's own
 * directory first, then the repo root), so a monorepo package's own fly.toml
 * beats the umbrella repo's README.
 *
 * Returns `{ url, source }` - `source` is a short human label for the dim
 * "we got this from X" line - or null when nothing plausible turned up.
 */
export function guessBaseUrl({ dirs = [], oas = null } = {}) {
  const fromSpec = fromOas(oas);
  if (fromSpec) return { url: fromSpec, source: 'the spec' };

  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const { file, parse } of FILE_SOURCES) {
      const full = path.join(dir, file);
      const text = read(full);
      if (!text) continue;
      const url = parse(text);
      if (url) return { url, source: file };
    }
  }
  return null;
}
