import fs from 'fs';
import path from 'path';
import { hasWithRestless, hasDefineConfig } from './sdk-writers/javascript.js';

/**
 * Deterministic Next.js layout detection for the SDK installer.
 *
 * The Restless JS SDK has two Next.js integration styles, and neither is
 * middleware:
 *
 *   - **Plugin style (App Router, preferred).** `withRestless(nextConfig)`
 *     in `next.config.*` plus a `restless.config.*` at the project root
 *     (`defineConfig({ setup })`). A build-time loader auto-wraps every
 *     `app/**\/route.*` handler; route files on disk are untouched.
 *     Supported on webpack builds from Next 13.4 and Turbopack builds from
 *     Next 15.3.
 *   - **Manual style (Pages Router / old Next / escape hatch).** WRAP route
 *     handlers by hand: `@restlessai/sdk/next` -> `client.setup(cb)` returns
 *     a handler-wrapper `(handler) => handler`.
 *
 * Either way the SDK must NEVER be wired into Next's middleware file
 * (`middleware.ts`, or `proxy.ts` on Next 16): Next hands middleware a
 * `NextRequestHint` whose `.request` is a booby-trapped getter that throws
 * `PageSignatureError` (E394), and middleware runs on the Edge runtime
 * where a Mongoose/DB `enrich` lookup can't run either.
 *
 * This module answers the questions the installer needs to get that right,
 * deterministically (no AI):
 *   - Is this a Next.js project, and which router (App vs Pages)?
 *   - Which files are route handlers we can wrap?
 *   - Which files are Next middleware (`middleware.*` / `proxy.*`) that must
 *     NEVER be touched?
 *   - Does the installed Next version support the auto-wrap plugin?
 *   - Is the plugin wiring (withRestless + restless.config) in place?
 *
 * It mirrors the file-based-route conventions already encoded in
 * `find-endpoints.js` (App Router `route.<ext>` under `app/`, Pages Router
 * `pages/api/**`) rather than sharing a walk, because the concerns differ:
 * here we also need to locate middleware files and we don't care about the
 * URL paths.
 */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.restless',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.vercel',
  '.turbo',
  '.cache',
  '.svelte-kit',
  '.parcel-cache',
]);

const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.tsx', '.jsx']);
const MAX_DEPTH = 10;

// App Router route handler file: literally named `route.<ext>`.
const APP_ROUTE_FILE = /^route\.(js|jsx|ts|tsx|mjs|cjs)$/;

// Next's request-interception file. `middleware.<ext>` (Next <= 15) and the
// renamed `proxy.<ext>` (Next 16). Next only recognizes it at the project
// root or directly under `src/`.
const MIDDLEWARE_FILE = /^(middleware|proxy)\.(js|jsx|ts|tsx|mjs|cjs)$/;

/**
 * True when a project-relative path is a Next middleware file at a location
 * Next actually honors: `middleware.ts`, `proxy.ts`, `src/middleware.ts`,
 * `src/proxy.ts` (any recognized extension). This is the set of files the
 * installer must never wire the SDK into.
 */
export function isNextMiddlewareFile(rel) {
  if (!rel) return false;
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (!MIDDLEWARE_FILE.test(base)) return false;
  if (parts.length === 1) return true; // <root>/middleware.ts
  if (parts.length === 2 && parts[0] === 'src') return true; // src/middleware.ts
  return false;
}

/**
 * Heuristic: does this framework label (from language detection or a
 * package.json dep) name Next.js? Loose match so "next", "Next.js",
 * "nextjs", "Next 16" all count.
 */
export function isNextFramework(framework) {
  return /\bnext(?:\.?js)?\b/i.test(framework || '');
}

function readPackageJson(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return {
      deps: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) },
      type: pkg.type || 'commonjs',
    };
  } catch {
    return null;
  }
}

function walk(dir, rootDir, depth, visit) {
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
      walk(full, rootDir, depth + 1, visit);
    } else if (entry.isFile()) {
      if (SOURCE_EXTS.has(path.extname(entry.name))) {
        visit(full, path.relative(rootDir, full));
      }
    }
  }
}

/**
 * Inspect a Next.js project layout under `rootDir`.
 *
 * Returns:
 *   {
 *     isNext,             // Next dep present OR a router/middleware file found
 *     hasNextDep,         // `next` in (dev)dependencies
 *     router,             // 'app' | 'pages' | null
 *     appRouteFiles,      // App Router `route.<ext>` files (relative paths)
 *     pagesApiFiles,      // Pages Router `pages/api/**` files (relative paths)
 *     routeHandlerFiles,  // the wrap targets for the detected router
 *     middlewareFiles,    // `middleware.*` / `proxy.*` files (must NOT touch)
 *     moduleSystem,       // 'esm' | 'cjs' (package.json "type", Next => esm)
 *   }
 *
 * `router` is 'app' when any App Router handler exists (App Router takes
 * precedence when a project mixes both), 'pages' when only Pages Router API
 * routes exist, and null when neither is present.
 */
export function detectNext(rootDir) {
  const pkg = readPackageJson(rootDir);
  const hasNextDep = !!(pkg && pkg.deps && pkg.deps.next != null);

  const appRouteFiles = [];
  const pagesApiFiles = [];
  const middlewareFiles = [];

  walk(rootDir, rootDir, 0, (_abs, rel) => {
    const parts = rel.split(path.sep);
    const base = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    if (isNextMiddlewareFile(rel)) {
      middlewareFiles.push(rel);
      return;
    }

    // App Router: a `route.<ext>` with an `app` directory somewhere in its
    // ancestry (covers `app/`, `src/app/`, `apps/web/app/`).
    if (APP_ROUTE_FILE.test(base) && dirParts.includes('app')) {
      appRouteFiles.push(rel);
      return;
    }

    // Pages Router API routes: any file under `pages/api/**` (skipping the
    // private `_`-prefixed helpers Next doesn't route).
    const pagesIdx = dirParts.lastIndexOf('pages');
    if (pagesIdx !== -1 && dirParts[pagesIdx + 1] === 'api' && !base.startsWith('_')) {
      pagesApiFiles.push(rel);
    }
  });

  appRouteFiles.sort();
  pagesApiFiles.sort();
  middlewareFiles.sort();

  const router = appRouteFiles.length > 0 ? 'app' : pagesApiFiles.length > 0 ? 'pages' : null;
  const routeHandlerFiles = router === 'app' ? appRouteFiles : router === 'pages' ? pagesApiFiles : [];
  const isNext = hasNextDep || router !== null || middlewareFiles.length > 0;
  const moduleSystem = pkg && pkg.type === 'module' ? 'esm' : hasNextDep ? 'esm' : 'cjs';

  return {
    isNext,
    hasNextDep,
    router,
    appRouteFiles,
    pagesApiFiles,
    routeHandlerFiles,
    middlewareFiles,
    moduleSystem,
  };
}

// Next only loads its config from the project root, and only under these
// names (in this precedence order).
const NEXT_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
];

// The SDK's discovery set for the capture config, from the plugin's
// documented lookup: restless.config.{ts,mts,cts,js,mjs,cjs} at the
// project root (next to the Next config).
const RESTLESS_CONFIG_FILES = [
  'restless.config.ts',
  'restless.config.mts',
  'restless.config.cts',
  'restless.config.js',
  'restless.config.mjs',
  'restless.config.cjs',
];

function firstReadable(rootDir, names) {
  for (const name of names) {
    try {
      fs.accessSync(path.join(rootDir, name), fs.constants.R_OK);
      return name;
    } catch {}
  }
  return null;
}

/** Relative filename of the Next config at `rootDir`, or null when absent. */
export function findNextConfigFile(rootDir) {
  return firstReadable(rootDir, NEXT_CONFIG_FILES);
}

/** Relative filename of the restless.config at `rootDir`, or null. */
export function findRestlessConfigFile(rootDir) {
  return firstReadable(rootDir, RESTLESS_CONFIG_FILES);
}

/**
 * The installed Next.js version, as a plain semver string, or null when it
 * can't be determined. Reads `node_modules/next/package.json`, walking up
 * from `rootDir` (monorepo hoisting - same reasoning as install-sdk's
 * `resolveInstalledSdk`). Falls back to the version RANGE declared in the
 * nearest package.json, which is good enough for the major.minor gate below
 * but can under-report (`^15.0.0` reads as 15.0 even when 15.4 is installed).
 */
export function resolveNextVersion(rootDir) {
  let dir = path.resolve(rootDir);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, 'node_modules', 'next', 'package.json'), 'utf8'),
      );
      if (pkg.version) return pkg.version;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const pkg = readPackageJson(rootDir);
  return (pkg && pkg.deps && pkg.deps.next) || null;
}

function parseMajorMinor(version) {
  const m = /(\d+)(?:\.(\d+))?/.exec(version || '');
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0) };
}

function mmAtLeast(mm, major, minor) {
  return mm.major > major || (mm.major === major && mm.minor >= minor);
}

/**
 * The installed @restlessai/sdk version (or the legacy `restlessai`
 * package name), walking up node_modules like `resolveNextVersion`.
 * Returns null when the SDK isn't installed yet - which is fine for the
 * auto-wrap gate below: the installer is about to `npm install` the
 * latest release.
 */
export function resolveInstalledSdkVersion(rootDir) {
  const names = [
    ['@restlessai', 'sdk'],
    ['restlessai'],
  ];
  let dir = path.resolve(rootDir);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of names) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(dir, 'node_modules', ...name, 'package.json'), 'utf8'),
        );
        if (pkg.version) return pkg.version;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function scriptsUseTurbopack(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return Object.values(pkg.scripts || {}).some((s) => /--turbo(?:pack)?\b/.test(String(s)));
  } catch {
    return false;
  }
}

/**
 * Can this project use the SDK's auto-wrap plugin (`withRestless`)?
 * Two support matrices apply:
 *
 *   - Next: webpack builds on >= 13.4, Turbopack builds on >= 15.3
 *     (older Turbopack gets a build warning and NO capture - a silent
 *     runtime failure, so the installer must fall back to manual
 *     wrapping rather than ship it).
 *   - The SDK itself: `withRestless` / `defineConfig` first shipped in
 *     @restlessai/sdk 0.4.0. A project that pre-installed an older SDK
 *     (the installer skips `npm install` when the package is already
 *     reachable) would get scaffolded imports that don't resolve at
 *     build time. The manual per-route API exists on those older
 *     releases, so falling back is safe.
 *
 * When a version can't be resolved we assume the good case: an App
 * Router layout implies Next >= 13.4 in practice, and a missing SDK is
 * about to be installed at latest by the install step.
 *
 * Returns { supported, version, sdkVersion, reason } - `reason` set
 * when unsupported.
 */
export function nextAutoWrapSupport(rootDir) {
  const version = resolveNextVersion(rootDir);
  const sdkVersion = resolveInstalledSdkVersion(rootDir);
  const mm = parseMajorMinor(version);
  if (mm) {
    if (!mmAtLeast(mm, 13, 4)) {
      return {
        supported: false,
        version,
        sdkVersion,
        reason: `auto-wrap needs Next >= 13.4 (found ${version})`,
      };
    }
    if (!mmAtLeast(mm, 15, 3) && scriptsUseTurbopack(rootDir)) {
      return {
        supported: false,
        version,
        sdkVersion,
        reason: `this project builds with Turbopack, which needs Next >= 15.3 for auto-wrap (found ${version})`,
      };
    }
  }
  const sdkMM = parseMajorMinor(sdkVersion);
  if (sdkMM && !mmAtLeast(sdkMM, 0, 4)) {
    return {
      supported: false,
      version,
      sdkVersion,
      reason: `the installed @restlessai/sdk ${sdkVersion} predates the withRestless plugin (needs >= 0.4.0)`,
    };
  }
  return { supported: true, version, sdkVersion, reason: null };
}

/**
 * Is the plugin-style wiring in place? Checks the two files the single-
 * config integration consists of:
 *   - next.config.* wraps its exported config with `withRestless`
 *   - restless.config.* builds the capture config with `defineConfig`
 *
 * Neither file satisfies `hasInit()` (named imports, no factory call), so
 * the wiring gates in install-sdk / final-checks check this separately.
 * `ok` requires BOTH: `withRestless` alone is the SDK's zero-config mode
 * (env key, no owner attribution), which the installer never leaves a user
 * on - owner attribution is the point of the setup flow.
 */
export function nextPluginWiringStatus(rootDir) {
  const nextConfigFile = findNextConfigFile(rootDir);
  const restlessConfigFile = findRestlessConfigFile(rootDir);
  let pluginWired = false;
  let configWired = false;
  if (nextConfigFile) {
    try {
      pluginWired = hasWithRestless(fs.readFileSync(path.join(rootDir, nextConfigFile), 'utf8'));
    } catch {}
  }
  if (restlessConfigFile) {
    try {
      configWired = hasDefineConfig(fs.readFileSync(path.join(rootDir, restlessConfigFile), 'utf8'));
    } catch {}
  }
  return {
    nextConfigFile,
    restlessConfigFile,
    hasWithRestless: pluginWired,
    hasDefineConfig: configWired,
    ok: pluginWired && configWired,
  };
}
