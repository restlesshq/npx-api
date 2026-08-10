import fs from 'fs';
import path from 'path';
import { IGNORE_DIRS, isFrameworkDep, scanCodebase } from './find-endpoints.js';

/**
 * Deterministic "is this even a Node project?" check, run BEFORE any LLM pass.
 *
 * Everything downstream of detection is Node-only: `scanCodebase` reads
 * `.js/.ts/.mjs/.cjs/.tsx/.jsx` and nothing else, `lib/sdk-writers/` has one
 * dialect (JavaScript), and `docs/sdks/` has one guide. A Python or Go repo
 * used to fall into the "we couldn't find any APIs" picker, whose only option
 * is a free-form hint that re-runs the same Node-only scan - so the user could
 * answer "it's a Python FastAPI in backend/api" and loop forever. This turns
 * that into one honest exit.
 *
 * The guard we had before this lived in `prompts/detect-endpoints.md` ("zero
 * endpoints AND no package.json -> return []"). It misses the common shape:
 * a Django or Rails backend with a React frontend HAS a `package.json`, so the
 * bail never fired and the LLM would label the frontend as the API.
 *
 * ## Which way this errs
 *
 * A false "not Node" turns away a repo we could have set up. A false "is Node"
 * just falls through to the behaviour we already had. So every Node
 * signal here is deliberately generous, and blocking requires BOTH:
 *
 *   1. zero Node HTTP evidence anywhere in the tree, and
 *   2. at least one foreign manifest (`requirements.txt`, `go.mod`, ...).
 *
 * A Node API with a `requirements.txt` for some build script keeps working
 * because (1) fails. An empty repo keeps working because (2) fails.
 */

// Base skip list shared with the endpoint scan, plus the foreign-ecosystem
// vendor dirs it never had a reason to name. These matter here specifically:
// `.venv/**/pyproject.toml` and `vendor/bundle/**/Gemfile` are manifests
// belonging to installed dependencies, and counting them would report a Node
// repo as Python for having a virtualenv checked in.
const SKIP_DIRS = new Set([
  ...IGNORE_DIRS,
  '.venv',
  'venv',
  'env',
  'virtualenv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'vendor',
  'target',
  '.gradle',
  '.bundle',
  'Pods',
  '.terraform',
]);

const MAX_DEPTH = 6;
const MAX_SOURCE_BYTES = 512 * 1024;

// Manifests that mean "another language's toolchain builds something here".
// Matched by exact filename, or by extension where the name is project-chosen
// (`.csproj` and friends).
const FOREIGN_MANIFESTS = [
  { file: 'requirements.txt', language: 'Python' },
  { file: 'pyproject.toml', language: 'Python' },
  { file: 'Pipfile', language: 'Python' },
  { file: 'setup.py', language: 'Python' },
  { file: 'manage.py', language: 'Python' },
  { file: 'environment.yml', language: 'Python' },
  { file: 'Gemfile', language: 'Ruby' },
  { file: 'config.ru', language: 'Ruby' },
  { file: 'go.mod', language: 'Go' },
  { file: 'composer.json', language: 'PHP' },
  { file: 'artisan', language: 'PHP' },
  { file: 'Cargo.toml', language: 'Rust' },
  { file: 'pom.xml', language: 'Java' },
  { file: 'build.gradle', language: 'Java' },
  { file: 'build.gradle.kts', language: 'Kotlin' },
  { file: 'mix.exs', language: 'Elixir' },
  { file: 'Package.swift', language: 'Swift' },
  { file: 'pubspec.yaml', language: 'Dart' },
  { ext: '.csproj', language: '.NET' },
  { ext: '.fsproj', language: '.NET' },
  { ext: '.sln', language: '.NET' },
];

// Dependencies that mean Node is serving HTTP here.
//
// MUCH wider than `isFrameworkDep` in find-endpoints.js on purpose: that list
// decides which wiring guide to use, this one decides whether to block. Meta
// frameworks (Next, Nuxt, SvelteKit, Remix, Astro) count because they own API
// routes, and Next is a first-class supported target.
const NODE_SERVER_DEP_PATTERNS = [
  /^(express|fastify|koa|hono|next|nuxt|restify|connect|hapi|polka|micro|h3|elysia|srvx|nitropack)$/,
  /^(sails|feathers|adonis|loopback|marble|tinyhttp|find-my-way|router|body-parser)$/,
  /^(graphql-yoga|apollo-server|apollo-server-express|mercurius|type-graphql)$/,
  /^(socket\.io|ws|uWebSockets\.js)$/,
  /^@(fastify|koa|nestjs|hapi|trpc|apollo|remix-run|sveltejs|adonisjs|feathersjs|tanstack)\//,
  /^(fastify|koa|express)-/,
  /^(astro|@astrojs\/node|remix|@remix-run\/node)$/,
  /^(serverless-http|aws-serverless-express|@vendia\/serverless-express)$/,
];

function isNodeServerDep(name) {
  if (isFrameworkDep(name)) return true;
  return NODE_SERVER_DEP_PATTERNS.some((re) => re.test(name));
}

// Source-level evidence of a Node HTTP server that declares no dependency we
// recognize: the built-in `http`/`https` modules, and Deno/Bun-style
// `serve()`. Only consulted on the path where we are otherwise about to
// block, so the cost is paid once and never on a normal run.
const NODE_SERVER_MARKERS = [
  /\bcreateServer\s*\(/,
  /\bfrom\s+['"]node:https?['"]/,
  /\bfrom\s+['"]node:http2['"]/,
  /require\s*\(\s*['"](?:node:)?https?['"]\s*\)/,
  /require\s*\(\s*['"](?:node:)?http2['"]\s*\)/,
  /\bBun\.serve\s*\(/,
  /\bDeno\.serve\s*\(/,
  /\bexport\s+default\s*\{[^}]*\bfetch\b/,
  /\.listen\s*\(\s*(?:process\.env\.PORT|PORT|port|\d{2,5})/,
];

const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.tsx', '.jsx']);

/** Which foreign language a filename implies, or null. */
function foreignLanguageFor(name) {
  for (const entry of FOREIGN_MANIFESTS) {
    if (entry.file && entry.file === name) return entry.language;
    if (entry.ext && name.endsWith(entry.ext)) return entry.language;
  }
  return null;
}

/**
 * One shallow walk collecting only what the verdict needs: foreign manifests,
 * `package.json` paths, and Node source paths. Reads no file contents - the
 * `package.json` parse and the marker scan happen after, and the marker scan
 * only when we're about to block.
 */
function walk(dir, rootDir, acc, depth) {
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
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      walk(full, rootDir, acc, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    const rel = path.relative(rootDir, full);
    if (entry.name === 'package.json') {
      acc.packageJsons.push({ abs: full, rel });
      continue;
    }
    const language = foreignLanguageFor(entry.name);
    if (language) {
      acc.foreignFiles.push({ rel, language });
      continue;
    }
    if (SOURCE_EXTS.has(path.extname(entry.name))) acc.sourceFiles.push(full);
  }
}

/** Node server deps declared across every package.json in the tree. */
function nodeDepEvidence(packageJsons) {
  const evidence = [];
  for (const { abs, rel } of packageJsons) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      // An unreadable/invalid package.json is still a Node signal in itself,
      // but a weak one - a broken manifest shouldn't decide the verdict.
      continue;
    }
    const deps = Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {}),
    });
    const hits = deps.filter(isNodeServerDep).sort();
    if (hits.length) evidence.push(`${hits.join(', ')} in ${rel}`);
  }
  return evidence;
}

/**
 * Last-chance scan for a Node server with no recognizable dependency, e.g. a
 * bare `node:http` service or a framework newer than our lists. Runs only when
 * every cheaper signal came back empty and a foreign manifest is present, so
 * the one repo shape that pays for this scan is the one about to be blocked.
 */
function nodeSourceEvidence(sourceFiles) {
  for (const file of sourceFiles) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_SOURCE_BYTES) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const marker = NODE_SERVER_MARKERS.find((re) => re.test(content));
    if (marker) return `Node server code in ${file}`;
  }
  return null;
}

/**
 * Classify a repo as something we can set up or not.
 *
 * Returns:
 *   {
 *     supported,      // false only when we're confident there's no Node here
 *     nodeEvidence,   // why we think it IS Node (empty when unsupported)
 *     foreign: [{ language, files: string[] }],  // strongest first
 *     languages,      // foreign language names, most-evidence-first
 *   }
 */
export function detectStack(rootDir) {
  const acc = { packageJsons: [], foreignFiles: [], sourceFiles: [] };
  walk(rootDir, rootDir, acc, 0);

  // Group foreign manifests by language, most evidence first, so the message
  // leads with the language the repo is actually written in rather than
  // whichever manifest the walk happened to reach first.
  const byLanguage = new Map();
  for (const { rel, language } of acc.foreignFiles) {
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(rel);
  }
  const foreign = [...byLanguage.entries()]
    .map(([language, files]) => ({ language, files: files.sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.language.localeCompare(b.language));

  const nodeEvidence = nodeDepEvidence(acc.packageJsons);

  // No foreign manifest anywhere - nothing to be confident about, so stay out
  // of the way and let detection run exactly as it did before.
  if (foreign.length === 0) {
    return { supported: true, nodeEvidence, foreign, languages: [] };
  }

  if (nodeEvidence.length === 0) {
    // Routes our regex can see are proof of a Node server whatever the deps say.
    let scan;
    try {
      scan = scanCodebase(rootDir);
    } catch {
      scan = { endpoints: [], frameworkSignals: [] };
    }
    if (scan.endpoints.length > 0) {
      nodeEvidence.push(`${scan.endpoints.length} Node route(s) matched in source`);
    } else if (scan.frameworkSignals.length > 0) {
      nodeEvidence.push('Node framework signals in source');
    } else {
      const marker = nodeSourceEvidence(acc.sourceFiles);
      if (marker) nodeEvidence.push(marker);
    }
  }

  return {
    supported: nodeEvidence.length > 0,
    nodeEvidence,
    foreign,
    languages: foreign.map((f) => f.language),
  };
}

/** `Python`, `Python and Go`, `Python, Go and Rust`. */
export function describeLanguages(languages) {
  if (languages.length === 0) return 'another language';
  if (languages.length === 1) return languages[0];
  return `${languages.slice(0, -1).join(', ')} and ${languages[languages.length - 1]}`;
}

/**
 * The headline + detail lines for an unsupported repo, ready to hand to
 * `fatalError` (which appends the "book a call" block itself). Kept next to
 * the detection so both entry points - the interactive setup step and the
 * coding-agent playbook - say the same thing.
 */
export function unsupportedStackMessage(stack, { rootDir, cliName = 'api' } = {}) {
  const label = describeLanguages(stack.languages);
  const evidence = stack.foreign.flatMap((f) => f.files).slice(0, 6);
  const headline = `We only support Node and TypeScript APIs today, and this looks like ${
    stack.languages.length > 1 ? 'a mixed' : `a ${label}`
  } project.`;

  const details = [
    `Found: ${evidence.join(', ')}${
      stack.foreign.flatMap((f) => f.files).length > evidence.length ? ', …' : ''
    }`,
    `No Node HTTP server (Express, Fastify, Koa, Hono, NestJS, Next.js) under ${rootDir}.`,
    '',
    `${label} SDKs are on the roadmap. Book a call below and we'll tell you when`,
    `yours lands - it's also the fastest way to move it up the list.`,
    '',
    `Think we got this wrong? Scan anyway with:`,
    `  RESTLESS_SKIP_STACK_CHECK=1 npx ${cliName} init`,
  ];

  return { headline, details };
}

/** The documented escape hatch for a repo we misjudge. */
export function stackCheckDisabled() {
  return process.env.RESTLESS_SKIP_STACK_CHECK === '1';
}
