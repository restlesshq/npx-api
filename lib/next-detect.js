import fs from 'fs';
import path from 'path';

/**
 * Deterministic Next.js layout detection for the SDK installer.
 *
 * The Restless JS SDK integrates with Next.js by WRAPPING App Router route
 * handlers (`@restlessai/sdk/next` -> `client.setup(cb)` returns a
 * handler-wrapper `(handler) => handler`), NOT by registering middleware.
 * Wiring the request-capturing SDK into Next's middleware file
 * (`middleware.ts`, or `proxy.ts` on Next 16) crashes at runtime: Next hands
 * middleware a `NextRequestHint` whose `.request` is a booby-trapped getter
 * that throws `PageSignatureError` (E394), and middleware runs on the Edge
 * runtime where a Mongoose/DB `enrich` lookup can't run either.
 *
 * This module answers the questions the installer needs to get that right,
 * deterministically (no AI):
 *   - Is this a Next.js project, and which router (App vs Pages)?
 *   - Which files are route handlers we can wrap?
 *   - Which files are Next middleware (`middleware.*` / `proxy.*`) that must
 *     NEVER be touched?
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
