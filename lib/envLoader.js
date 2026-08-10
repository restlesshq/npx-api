import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { normalizeLanguage } from './sdk-writers/languages.js';

/**
 * Detect how (or whether) the project loads environment variables at
 * runtime. Drives whether the wired SDK call should pass
 * `process.env.RESTLESS_KEY` (only safe when env actually populates) or
 * call `restless()` with no args (the SDK then auto-walks for `.env`
 * itself).
 *
 * Returns `{ mode, evidence }` where mode is one of:
 *   - 'auto'     : framework auto-loads `.env` (Next.js / Astro / Remix / SvelteKit).
 *   - 'dotenv'   : a dotenv-family package is in deps, OR source imports it.
 *   - 'env-file' : `--env-file` flag in a package.json script (Node 20.6+).
 *   - 'none'     : no detectable env loader.
 *
 * `installDir` should be the directory of the `package.json` that owns
 * the API. We never walk above it (the contract: detection is scoped to
 * the user's package).
 */
/**
 * Python's answer to the same question.
 *
 * Unlike Node, the Python SDK does NOT auto-load `.env` - install.md §12 says
 * so explicitly, because Python has no single convention and the SDK ships
 * with no dependencies. So `mode: 'none'` means something different here than
 * for Node: there is no `.env` walk to fall back on, and the honest wiring is
 * a no-arg `Restless()` that reads whatever the process environment actually
 * has. Naming the variable explicitly would only look more correct while
 * failing the same way. `getSdkLineSpec` reads this off `envLoaderHasKey`.
 */
function detectPythonEnvLoader(installDir) {
  const manifests = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg'];
  let declared = '';
  for (const file of manifests) {
    try { declared += fs.readFileSync(path.join(installDir, file), 'utf8'); } catch {}
  }

  // Django and Flask both load .env themselves in the common setups, so a
  // key in the environment is reliable before the client is constructed.
  for (const [dep, why] of [
    ['django-environ', 'django-environ is installed'],
    ['python-decouple', 'python-decouple is installed'],
    ['python-dotenv', 'python-dotenv is installed'],
    ['pydantic-settings', 'pydantic-settings is installed'],
    ['environs', 'environs is installed'],
    ['dynaconf', 'dynaconf is installed'],
  ]) {
    if (new RegExp(`(^|[^\\w-])${dep}([^\\w-]|$)`, 'im').test(declared)) {
      return { mode: 'dotenv', evidence: why };
    }
  }

  // Source-level loading, which is how plenty of projects do it without
  // declaring the dep at the top level (it arrives via a framework extra).
  try {
    const out = execSync(
      `grep -rE "load_dotenv|dotenv_values|environ\\.Env|from dotenv import" --include="*.py" -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    const hits = out.trim().split('\n').filter((f) => f && !f.includes('site-packages') && !f.includes('/.venv/'));
    if (hits.length > 0) return { mode: 'dotenv', evidence: `dotenv loaded in ${hits[0].replace(/^\.\//, '')}` };
  } catch {}

  // A manage.py project reads settings through Django, which most deployments
  // populate from the real environment rather than a file.
  try {
    if (fs.existsSync(path.join(installDir, 'manage.py'))) {
      return { mode: 'none', evidence: 'Django project, env comes from the process environment' };
    }
  } catch {}

  return { mode: 'none', evidence: 'no env loader detected' };
}

export function detectEnvLoader(installDir, language = 'javascript') {
  if (normalizeLanguage(language) === 'python') return detectPythonEnvLoader(installDir);

  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')); } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Frameworks that auto-load .env at runtime.
  for (const f of ['next', 'astro', '@sveltejs/kit', '@remix-run/node', '@remix-run/dev', 'remix']) {
    if (deps[f]) return { mode: 'auto', evidence: `${f} auto-loads .env at runtime` };
  }

  // dotenv-family packages declared in deps.
  for (const d of ['dotenv', 'dotenv-flow', 'dotenv-cli', '@dotenvx/dotenvx', 'dotenv-expand']) {
    if (deps[d]) return { mode: 'dotenv', evidence: `${d} is installed` };
  }

  // Node's built-in --env-file flag in scripts.
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (typeof cmd === 'string' && /--env-file[=\s]/.test(cmd)) {
      return { mode: 'env-file', evidence: `--env-file in scripts.${name}` };
    }
  }

  // Source-level dotenv import (added locally / via pnpm hoist).
  try {
    const out = execSync(
      `grep -rE "dotenv/config|require\\(['\\\"]dotenv['\\\"]\\)|from ['\\\"]dotenv['\\\"]" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    const hits = out.trim().split('\n').filter((f) => f && !f.includes('node_modules'));
    if (hits.length > 0) return { mode: 'dotenv', evidence: `dotenv imported in ${hits[0]}` };
  } catch {}

  return { mode: 'none', evidence: 'no env loader detected' };
}

/**
 * `process.env.RESTLESS_KEY` is reliable when an env loader populates it
 * before the SDK runs. Otherwise we'd rather have the AI emit
 * `restless()` (no args) and let the SDK's built-in `ensureEnvLoaded`
 * handle the `.env` walk - cleaner than referencing an env var that's
 * never set.
 */
export function envLoaderHasKey(envLoader) {
  return !!(envLoader && envLoader.mode && envLoader.mode !== 'none');
}
