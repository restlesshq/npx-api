import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, red, yellow, cyan, ask, askWithPreview, singleSelect } from '../lib/ui.js';
import { guessBaseUrl } from '../lib/base-url.js';
import { loadSettings, saveSettings, upsertApi, generatePrefix } from '../lib/settings.js';
import { startStep } from '../lib/step-template.js';
import { fatalError } from '../lib/errors.js';
import { scanCodebase } from '../lib/find-endpoints.js';
import { scanFor } from '../lib/scanners.js';
import { detectStack, stackCheckDisabled, unsupportedStackMessage } from '../lib/detect-stack.js';
import { SUPPORTED_LANGUAGES_LABEL } from '../lib/sdk-writers/index.js';
import { extractJson } from '../lib/extract-json.js';
import { findOasCandidates } from '../lib/find-oas.js';
import { loadOas } from '../lib/oas-auth.js';
import { findTestCandidates, buildCurl } from '../lib/test-endpoint.js';
import { safeWriteFileSync, safeMkdirSync } from '../lib/pathGuard.js';
import { isInteractive } from '../lib/env.js';
import { CLI_NAME } from '../lib/config.js';
import {
  MANAGED_OAS_FILE,
  adoptOasFile,
  countOasEndpoints,
  describeOasSource,
  describeSpecOutcome,
  fetchOasFromUrl,
  normalizeApiPath,
  oasSourceForPick,
  validateAndFixOas,
} from '../lib/oas-source.js';
import * as debug from '../lib/debug.js';

// How many follow-up passes we'll make to add file-based routes the first
// generation pass left out. See ensurePathCoverage for why this exists.
const MAX_COVERAGE_ATTEMPTS = 2;

// Where a generated/adopted spec lands, and the placeholder server URL the
// generate-oas prompt writes (swapped for the real base URL in finalizeApi).
// Aliased rather than re-declared so there is one definition of the path the
// CLI owns - `update` decides what it may overwrite from the same constant.
const OAS_FILE = MANAGED_OAS_FILE;
const PLACEHOLDER_DOMAIN = 'https://example.com';

// Where the locate-oas AI pass lists multiple matching specs when it can't
// pick one unambiguously, so the CLI can ask the user which to use.
const OAS_CANDIDATES_FILE = '.restless/.oas-candidates.json';

/**
 * Compare the file-based routes on disk against the paths the generated spec
 * actually emitted, and return the ones the spec is missing (grouped by path,
 * with the methods and a source file to read).
 *
 * Deliberately scoped to file-based routes (Next.js App/Pages Router), where
 * the enumerated path IS the full, authoritative URL. Call-expression routes
 * (Express/Fastify) are relative to a mount prefix we can't resolve
 * deterministically, so enforcing coverage on them would produce false
 * "missing" entries - we leave those to the single-pass generation.
 */
function missingFileRoutes(apiDir, oasFullPath) {
  let scan;
  try {
    scan = scanCodebase(apiDir);
  } catch {
    return [];
  }
  const fileRoutes = scan.endpoints.filter((e) => e.style === 'file');
  if (fileRoutes.length === 0) return [];

  const oas = loadOas(oasFullPath);
  const specPaths = new Set(Object.keys(oas?.paths || {}).map(normalizeApiPath));

  const byPath = new Map();
  for (const e of fileRoutes) {
    if (!byPath.has(e.path)) byPath.set(e.path, { path: e.path, methods: new Set(), file: e.file });
    byPath.get(e.path).methods.add(e.method);
  }

  const missing = [];
  for (const info of byPath.values()) {
    if (!specPaths.has(normalizeApiPath(info.path))) {
      missing.push({ path: info.path, methods: [...info.methods], file: info.file });
    }
  }
  return missing;
}

/**
 * Build a checklist of the file-based routes on disk to hand the generator up
 * front, so the first pass aims for full path coverage instead of discovering
 * endpoints as it goes (which is where it runs out of room and drops trees).
 * Empty string when there are no file routes - nothing authoritative to list,
 * and the generator's own exploration is fine for call-expression frameworks.
 */
function buildEndpointChecklist(apiDir) {
  let scan;
  try {
    scan = scanCodebase(apiDir);
  } catch {
    return '';
  }
  const fileRoutes = scan.endpoints.filter((e) => e.style === 'file');
  if (fileRoutes.length === 0) return '';

  const byPath = new Map();
  for (const e of fileRoutes) {
    if (!byPath.has(e.path)) byPath.set(e.path, new Set());
    byPath.get(e.path).add(e.method);
  }
  const lines = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, methods]) => `- ${[...methods].sort().join(', ')} ${p}`);

  return [
    `## Endpoint checklist (${byPath.size} paths, enumerated deterministically from the route files)`,
    '',
    'These paths MUST all appear in the generated spec. Read each route file to model its real request/response shapes, but do not drop any of these paths:',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Guard against the single-pass generator's failure mode: it models schemas
 * well but silently drops the largest/most-nested route trees when it runs
 * out of output budget, emitting orphaned components and no error. We diff the
 * authoritative file-route list against the spec's paths and, for anything
 * missing, run a targeted follow-up pass that ADDS just those operations
 * (chunked into one prompt so it can't truncate the way a whole-spec pass can).
 * Re-checks after each pass. Returns `{ ok, missing }` - `ok` false means some
 * routes are still absent after MAX_COVERAGE_ATTEMPTS, so the caller can
 * surface the gap instead of shipping an incomplete spec silently.
 */
async function ensurePathCoverage({ apiDir, oasFullPath, packageDir, setSpinner }) {
  for (let attempt = 0; attempt <= MAX_COVERAGE_ATTEMPTS; attempt++) {
    const missing = missingFileRoutes(apiDir, oasFullPath);
    if (missing.length === 0) return { ok: true, missing: [] };
    if (attempt === MAX_COVERAGE_ATTEMPTS) return { ok: false, missing };

    setSpinner({
      phase: 'Adding missing endpoints',
      detail: `${missing.length} route${missing.length === 1 ? '' : 's'} not yet in the spec`,
    });
    const missingList = missing
      .map((m) => `- ${m.methods.join(', ')} ${m.path}  (${m.file})`)
      .join('\n');
    await runAI(loadPrompt('fill-oas-paths', { oasFile: oasFullPath, missingList }), packageDir, {
      setSpinner,
    });

    // Re-validate after the edit - a broken write would wedge the next diff
    // (loadOas returns null -> every route reads as "missing" forever).
    const validation = await validateAndFixOas({ oasFullPath, packageDir, setSpinner });
    if (!validation.ok) return { ok: false, missing };
  }
  return { ok: false, missing: [] };
}

/**
 * Build a compact findings section to prepend to the LLM prompt.
 *
 * We run the endpoint + OAS scans locally (cheap, deterministic) before
 * asking the LLM anything. That way the LLM's job is just to synthesize:
 * group the endpoints into one or more named APIs, pick the framework
 * from package.json, and choose an existing OAS file if we found one.
 *
 * If the scans find nothing (unusual framework, non-Node codebase), we
 * still fall back to letting the LLM explore - see the prompt.
 */
function buildFindingsSection(packageDir, languages = ['javascript']) {
  const endpointResult = scanFor(packageDir, languages);
  const oasResult = findOasCandidates(packageDir);

  const lines = ['## Findings (from a deterministic pre-scan)'];
  lines.push('');

  if (endpointResult.endpoints.length > 0) {
    // Cap the inline list so the prompt doesn't balloon on huge repos.
    const capped = endpointResult.endpoints.slice(0, 200);
    const byFile = new Map();
    for (const e of capped) {
      if (!byFile.has(e.file)) byFile.set(e.file, []);
      byFile.get(e.file).push(`${e.method} ${e.path}`);
    }
    lines.push(`Endpoints (${endpointResult.endpoints.length} total across ${endpointResult.filesWithEndpoints.length} file(s)):`);
    for (const [file, routes] of byFile) {
      lines.push(`- ${file}:`);
      for (const r of routes) lines.push(`    - ${r}`);
    }
    if (endpointResult.endpoints.length > capped.length) {
      lines.push(`  … ${endpointResult.endpoints.length - capped.length} more truncated`);
    }
  } else {
    lines.push('Endpoints: none found by the pre-scan. The codebase may use a framework/language our regex does not cover - please explore.');
  }
  lines.push('');

  // Per-package framework signals. The endpoint regex only catches inline
  // string-literal routes, so a package can be a real API yet show zero
  // endpoints above (Fastify route modules, `fastify.route({...})`,
  // helper-registered routes with variable paths, etc.). These signals give
  // the LLM the framework truth per package - a package with a framework dep
  // but `0 inline routes matched` is the signature of a route style our regex
  // missed, and should be explored rather than ignored.
  const multiLanguage = new Set(endpointResult.frameworkSignals.map((s) => s.language)).size > 1;
  if (endpointResult.frameworkSignals.length > 0) {
    lines.push('Framework signals (per package, from deps + source markers):');
    for (const s of endpointResult.frameworkSignals) {
      const parts = [];
      if (s.frameworkDeps.length) parts.push(`deps[${s.frameworkDeps.join(', ')}]`);
      if (s.sourceMarkers.length) parts.push(`source uses ${s.sourceMarkers.join(', ')}`);
      if (s.oasGenDeps.length) parts.push(`OAS-capable via ${s.oasGenDeps.join(', ')}`);
      parts.push(`${s.endpointCount} inline route${s.endpointCount === 1 ? '' : 's'} matched`);
      const label = s.name ? `${s.package} (${s.name})` : s.package;
      const lang = multiLanguage ? `${s.language}: ` : '';
      lines.push(`- ${lang}${label}: ${parts.join(' · ')}`);
    }
    lines.push('');
  }

  if (oasResult.length > 0) {
    lines.push('OAS/Swagger spec candidates (found by parsing every YAML/JSON for a top-level `openapi` or `swagger` field):');
    for (const c of oasResult) {
      lines.push(`- ${c.path} (${c.type} ${c.version})`);
    }
  } else {
    lines.push('OAS spec candidates: none found by the pre-scan.');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Narrow the OAS to a shortlist of safe candidates, then ask the LLM to
 * pick the one that'd make the best demo endpoint. If anything goes wrong we
 * fall back to the top deterministically-ranked candidate, so the user
 * always gets a working curl.
 *
 * Returns a curl string (with `API_KEY_HERE` if auth is required) or
 * `null` if the OAS has no usable GET endpoints.
 */
async function pickTestCurl({ oasFullPath, baseUrl, packageDir, setSpinner }) {
  const oas = loadOas(oasFullPath);
  if (!oas) return null;

  const candidates = findTestCandidates(oas, { max: 10 });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return buildCurl(oas, candidates[0], baseUrl);

  const formatted = candidates.map((c, i) => {
    const params = c.pathParams.length
      ? ` (path params: ${c.pathParams.map((p) => `${p.name}=${p.example}`).join(', ')})`
      : '';
    const summary = c.summary || c.description || '(no description)';
    return `${i}. ${c.method} ${c.path}${params}\n   ${summary}`;
  }).join('\n\n');

  let pick = 0;
  try {
    const result = await runAI(
      loadPrompt('find-test-endpoint', { candidates: formatted }),
      packageDir,
      { setSpinner },
    );
    const parsed = extractJson(result, { requireKey: 'index' });
    if (parsed && Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < candidates.length) {
      pick = parsed.index;
    }
  } catch {}

  return buildCurl(oas, candidates[pick], baseUrl);
}

/**
 * Run the detect-endpoints AI pass. If `hint` is provided (from the user
 * picking "Other" in the picker), inject it as a "user hint" section so the
 * AI narrows its search.
 */
async function locateApis({ packageDir, setSpinner, hint = '', languages = ['javascript'] }) {
  const findingsSection = buildFindingsSection(packageDir, languages);
  const hintSection = hint
    ? [
        '## User hint',
        '',
        "The user ran the setup but we couldn't auto-detect their API. They said:",
        '',
        `> ${hint}`,
        '',
        'Search based on this hint. The hint is authoritative - prioritize it over anything else.',
        '',
      ].join('\n')
    : '';
  const prompt = loadPrompt('detect-endpoints', { findingsSection, hintSection });
  const result = await runAI(prompt, packageDir, { setSpinner });
  const parsed = extractJson(result, { requireKey: 'apis' });
  return parsed?.apis || [];
}

/**
 * Map a deterministic framework signal (deps + source markers from
 * scanCodebase) to a display label. Lets the "I already have a spec" branch
 * hand install-sdk a real framework without an AI pass. Returns null when
 * nothing recognizable matches.
 */
function labelFromSignal(sig) {
  const deps = sig.frameworkDeps || [];
  const markers = sig.sourceMarkers || [];
  const dep = (re) => deps.some((d) => re.test(d));
  if (dep(/^@nestjs\//) || markers.includes('@Controller()')) return 'NestJS';
  if (dep(/^(fastify|@fastify\/|fastify-)/) || markers.some((m) => m.startsWith('fastify') || m === 'FastifyInstance')) return 'Fastify';
  if (deps.includes('next')) return 'Next.js';
  if (deps.includes('hono') || markers.includes('new Hono()')) return 'Hono';
  if (deps.includes('koa') || dep(/^@koa\//) || markers.includes('new Koa()')) return 'Koa';
  if (deps.includes('express') || markers.includes('express()') || markers.includes('express.Router()')) return 'Express';
  if (deps.includes('hapi') || dep(/^@hapi\//)) return 'hapi';
  if (deps.includes('restify')) return 'Restify';
  return null;
}

/**
 * Decide which package the API lives in - the dir the SDK gets installed
 * into. In a monorepo this is the part the AI detection flow used to pick;
 * the "I already have a spec" branch has to recover it without that pass.
 * Zero or one framework-bearing package -> infer silently. Several -> ask,
 * since guessing wrong installs the SDK into the wrong workspace. Returns a
 * path relative to packageDir, suitable as `apiRootDir`.
 */
async function chooseApiRootDir(signals) {
  const candidates = signals.filter((s) => s.frameworkDeps.length || s.sourceMarkers.length);
  if (candidates.length <= 1) {
    const sig = candidates[0];
    return sig && sig.package !== '.' ? sig.package : '.';
  }
  const ranked = [...candidates].sort((a, b) => (b.endpointCount || 0) - (a.endpointCount || 0));
  const labels = ranked.map((s) => {
    const loc = s.package === '.' ? './' : `./${s.package}`;
    const fw = labelFromSignal(s) || s.frameworkDeps[0] || 'unknown';
    return `${bold(s.name || loc)}\n${dim(`${fw}  ${loc}`)}`;
  });
  console.log('');
  const idx = await singleSelect(labels, { message: 'Which package is this API in?', defaultIndex: 0 });
  return ranked[idx].package || '.';
}

/**
 * Cheap, AI-free guess of the framework + language for `apiRootDir`, used by
 * the "I already have a spec" branch (which skips AI detection). Reuses the
 * framework signals we already scanned. Both are best-effort: install-sdk
 * defaults language to javascript and the AI re-derives the framework from
 * the code, so a miss is harmless.
 */
function guessShape(signals, packageDir, apiRootDir) {
  let framework = null;
  const sig =
    signals.find((s) => s.package === apiRootDir) ||
    [...signals].sort((a, b) => (b.endpointCount || 0) - (a.endpointCount || 0))[0];
  if (sig) framework = labelFromSignal(sig);

  let language = 'javascript';
  const apiDir = path.resolve(packageDir, apiRootDir);
  try {
    if (fs.existsSync(path.join(apiDir, 'tsconfig.json'))) {
      language = 'typescript';
    } else {
      const pkg = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript) language = 'typescript';
    }
  } catch {}

  return { framework, language };
}

/**
 * Shared tail for both paths (generate-with-AI and adopt-existing): ask for
 * visibility + base URL, optionally swap the placeholder domain in a freshly
 * generated file, pick a demo curl, then write the API entry to
 * .restless/settings.json. Keeps both paths producing the same settings shape
 * so downstream steps (upload, test) behave identically.
 */
async function finalizeApi({
  rootDir,
  packageDir,
  update,
  setSpinner,
  name,
  apiRootDir = '.',
  framework = null,
  language = null,
  finalOasFile,
  endpoints = [],
  replacePlaceholderDomain = false,
  oasSource = null,
}) {
  // Visibility (external vs internal) is recorded, not asked. Nothing in
  // setup branches on it and the dashboard doesn't read it yet, so the
  // question was spending one of the user's few decisions on a field only
  // `npx restless update` touches. The heuristic below fills it in: it biases
  // toward "internal" when the name, framework, or routes look service-y,
  // and is wrong cheaply - `npx restless update` flips it in one keystroke.
  const nameLower = (name || '').toLowerCase();
  const frameworkLower = (framework || '').toLowerCase();
  const endpointsLower = (endpoints || []).map((e) => e.toLowerCase());
  const allPaths = endpointsLower.join(' ');
  const internalSignals = [
    nameLower.includes('internal'),
    nameLower.includes('admin'),
    nameLower.includes('private'),
    nameLower.includes('backoffice'),
    nameLower.includes('back-office'),
    nameLower.includes('service'),
    nameLower.includes('worker'),
    nameLower.includes('queue'),
    nameLower.includes('consumer'),
    nameLower.includes('processor'),
    nameLower.includes('gateway') && !nameLower.includes('api gateway'),
    allPaths.includes('/internal/'),
    allPaths.includes('/admin/'),
    allPaths.includes('/_/'),
    allPaths.includes('/rpc/'),
    allPaths.includes('/grpc'),
    !allPaths.includes('/v1') && !allPaths.includes('/v2') && endpointsLower.length > 3,
    frameworkLower.includes('grpc'),
    frameworkLower.includes('trpc'),
  ].filter(Boolean).length;
  const isInternal = internalSignals >= 2;

  const firstEndpoint = endpoints?.[0]?.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '') || '/example';

  // Look for the answer before asking for it. Deploy manifests, env
  // templates, and the README usually already say where this API lives, and
  // the base URL is the one thing in setup the user has to go look up.
  let oasDoc = null;
  try { if (finalOasFile) oasDoc = loadOas(path.join(rootDir, finalOasFile)); } catch {}
  const apiDirAbs = path.resolve(packageDir, apiRootDir || '.');
  const guess = guessBaseUrl({ dirs: [apiDirAbs, packageDir, rootDir], oas: oasDoc });
  debug.log('generate-oas.base-url-guess', guess || { url: null });

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    `  ${bold("What's your API's base URL in production?")}`,
    '',
    guess
      ? `  ${dim(`We found this in ${guess.source} - press enter to keep it, or edit it.`)}`
      : `  ${dim(`So we know ${firstEndpoint} lives at <base-url>${firstEndpoint}.`)}`,
  ]});
  // The guess is prefilled into the line editor, not just accepted for them:
  // backspace / arrows work, so a near-miss is a quick fix rather than a
  // retype from scratch. The line underneath shows a real request URL built
  // from whatever is currently typed, so a missing scheme or a stray
  // trailing path is obvious before they hit enter.
  const domain = (await askWithPreview(`\n  ${cyan('❯')} `, {
    defaultValue: guess?.url || '',
    // What they typed stays solid; the example path is dim, since it's the
    // illustrative half of the line.
    preview: (value) => {
      const base = value.trim().replace(/\/+$/, '');
      return `  ${dim('Your requests:')} ${base || dim('<base-url>')}${dim(firstEndpoint)}`;
    },
  })).trim();

  // Replace placeholder domain in the AI-generated OAS file only when we
  // actually generated one (not when we're reusing a user's existing file).
  if (replacePlaceholderDomain && finalOasFile) {
    const oasFullPath = path.join(rootDir, finalOasFile);
    try {
      const oasContent = fs.readFileSync(oasFullPath, 'utf8');
      // A blank answer means "no public URL confirmed". A relative server is
      // the honest spelling of that - this file gets uploaded, and a made-up
      // localhost:3000 would ship to the dashboard as the API's base URL.
      const updated = oasContent.replaceAll(PLACEHOLDER_DOMAIN, domain || '/');
      safeWriteFileSync(oasFullPath, updated);
    } catch {}
  }

  // Pick a test endpoint now, while the OAS is fresh in our hands. Step 3
  // ("Test your setup") just reads `testCurl` off the API entry, skipping a
  // whole AI round-trip when the user is sitting at the prompt.
  let testCurl = null;
  if (finalOasFile) {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  Picking a safe ${bold('GET')} endpoint to use as a demo endpoint.`,
    ]});
    setSpinner({ phase: 'Picking a test endpoint', detail: `Reading ${finalOasFile}` });
    try {
      // Build the curl against localhost, not the prod `domain`. This curl is
      // only ever used by step 3, which tests the SDK wiring against the local
      // dev server - the test step swaps in the detected port at run time.
      testCurl = await pickTestCurl({
        oasFullPath: path.join(rootDir, finalOasFile),
        baseUrl: 'http://localhost:3000',
        packageDir,
        setSpinner,
      });
    } catch {}
    setSpinner('');
  }

  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
    dim('  Saving settings...'),
  ]});

  const settings = loadSettings(rootDir);
  upsertApi(settings, {
    name,
    rootDir: apiRootDir,
    ...(finalOasFile && { oasFile: finalOasFile }),
    ...(framework && { framework }),
    ...(language && { language: language.toLowerCase() }),
    baseUrl: domain || null,
    internal: isInternal,
    ...(testCurl && { testCurl }),
    ...(oasSource && { oasSource }),
    lastSyncedAt: new Date().toISOString(),
  });

  // Generate a request ID prefix on the API entry (not top-level).
  const apiEntry = settings.apis.find((a) => a.rootDir === apiRootDir);
  if (apiEntry && !apiEntry.requestIdPrefix) {
    if (settings.requestIdPrefix) {
      apiEntry.requestIdPrefix = settings.requestIdPrefix;
      delete settings.requestIdPrefix;
    } else {
      let projectName;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
        projectName = pkg.name;
      } catch {}
      if (!projectName) projectName = path.basename(rootDir);
      apiEntry.requestIdPrefix = generatePrefix(projectName);
    }
  }

  saveSettings(rootDir, settings);

  update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
    `  ${green('✓')} OpenAPI spec ready at ${bold(finalOasFile)}${isInternal ? dim(' (internal)') : ''}.`,
    `  ${dim("Commit .restless/ along with your code, it's meant to live there.")}`,
  ]});

  return {
    detectedLanguage: language ? language.toLowerCase() : null,
    detectedFramework: framework || null,
    apiRootDir,
    domain,
  };
}

/**
 * Hand the user's freeform description to the AI: it locates an existing spec
 * in the repo or runs the project's own generation, landing a spec at
 * `destFile`.
 *
 * Returns `{ ok, oasFile, summary }` or `{ ok, error }`, and prints nothing.
 * The caller decides what to say, because the same call is both a foreground
 * action ("point me at a spec") and the engine behind a background check, and
 * those want opposite amounts of narration.
 *
 * `onAmbiguous` is how the caller resolves several matching specs. Without it
 * the first is taken and the summary records that, because the alternative was
 * worse: this used to open a picker itself, which meant the "check before
 * asking anything" pass could draw a full-screen prompt over a running
 * spinner, with the picker's exact-row redraw math fighting the spinner's
 * line rewrite.
 *
 * NOTE: `destFile` is emptied before the AI runs, so callers must pass a
 * scratch path, never the spec they still want if this fails.
 */
export async function locateOasWithAi({
  input, rootDir, destFile, packageDir, setSpinner, onAmbiguous = null,
}) {
  const oasFileAbsolute = path.resolve(rootDir, destFile);
  const apiDir = path.dirname(oasFileAbsolute);
  const candidatesAbsolute = path.resolve(rootDir, OAS_CANDIDATES_FILE);
  // Clear any stale outputs so a no-op AI run is detectable and a prior run's
  // manifest can't leak into this one.
  try { if (fs.existsSync(oasFileAbsolute)) fs.rmSync(oasFileAbsolute); } catch {}
  try { if (fs.existsSync(candidatesAbsolute)) fs.rmSync(candidatesAbsolute); } catch {}

  setSpinner({ phase: 'Looking for your spec', detail: input });
  try {
    await runAI(loadPrompt('locate-oas', {
      userInstruction: input,
      oasFile: oasFileAbsolute,
      candidatesFile: candidatesAbsolute,
    }), packageDir, { setSpinner });
  } catch {}
  setSpinner('');

  // The AI reports what it did in the manifest: a one-line `summary` of the
  // action it took, and `candidates` when it found several specs and left the
  // choice to us. We record the summary as the spec's source - never the raw
  // instruction the user typed, which isn't a faithful record of what happened.
  const manifest = readOasManifest({ candidatesAbsolute, rootDir });
  try { if (fs.existsSync(candidatesAbsolute)) fs.rmSync(candidatesAbsolute); } catch {}

  // Single clear answer: the AI copied/generated the spec straight to the
  // destination. Validate and use it.
  if (fs.existsSync(oasFileAbsolute)) {
    const validation = await validateAndFixOas({ oasFullPath: oasFileAbsolute, packageDir, setSpinner });
    if (!validation.ok) {
      return { ok: false, error: "Found something, but it didn't parse as a valid spec." };
    }
    return {
      ok: true,
      oasFile: destFile,
      summary: manifest.summary || `located the spec at ${destFile}`,
    };
  }

  // Ambiguous: the AI found several matching specs and left the choice to us.
  const candidates = manifest.candidates;
  if (candidates.length === 0) {
    return { ok: false, error: "Couldn't find or generate a spec from that." };
  }

  let chosen = candidates[0];
  let autoPicked = false;
  if (candidates.length > 1) {
    if (onAmbiguous) {
      chosen = await onAmbiguous(candidates);
      if (!chosen) return { ok: false, error: 'No spec chosen.' };
    } else {
      autoPicked = true;
    }
  }

  // Copy the chosen spec next to the destination so it ships with the code,
  // then validate the copy (never mutating the user's original).
  if (!fs.existsSync(apiDir)) safeMkdirSync(apiDir, { recursive: true });
  const ext = path.extname(chosen.absPath).toLowerCase() === '.json' ? '.json' : '.yaml';
  const dest = path.join(apiDir, `openapi${ext}`);
  try {
    fs.copyFileSync(chosen.absPath, dest);
  } catch (err) {
    return { ok: false, error: `Couldn't read ${chosen.path}: ${err.message}` };
  }
  const validation = await validateAndFixOas({ oasFullPath: dest, packageDir, setSpinner });
  if (!validation.ok) {
    return { ok: false, error: `${chosen.path} didn't parse as a valid spec.` };
  }

  // Record which one we landed on and, when nobody was asked, that the choice
  // was ours - so a later replay reproduces the same decision knowingly.
  const picked = candidates.length > 1
    ? `used ${chosen.path} (${autoPicked ? 'first of' : 'chosen from'} ${candidates.length} matching specs)`
    : `used the spec found at ${chosen.path}`;
  // Keep the AI's account of how the specs are produced (e.g. the generation
  // command) alongside which one we landed on.
  return {
    ok: true,
    oasFile: path.relative(rootDir, dest),
    summary: manifest.summary ? `${manifest.summary}; ${picked}` : picked,
    chosenPath: chosen.path,
  };
}

/** The candidate picker `init` hands to `locateOasWithAi`. Kept next to the
 *  call so the engine itself stays promptless. */
export function pickOasCandidate(candidates) {
  const labels = candidates.map((c) => {
    const title = c.title && c.title !== c.path ? c.title : null;
    return title ? `${bold(title)}\n${dim(c.path)}` : bold(c.path);
  });
  console.log('');
  return singleSelect(labels, {
    message: `Found ${candidates.length} specs that match. Which API do you want to import to Restless?`,
    defaultIndex: 0,
  }).then((idx) => candidates[idx]);
}

/**
 * Read the manifest the locate-oas AI pass writes. Returns `{ summary,
 * candidates }`: `summary` is the AI's one-line account of what it did (or
 * null), `candidates` is the list of matching spec files, filtered to ones
 * that actually exist on disk (resolved relative to the repo root). Both
 * degrade safely - a missing or malformed manifest yields an empty result.
 */
function readOasManifest({ candidatesAbsolute, rootDir }) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(candidatesAbsolute, 'utf8'));
  } catch {
    return { summary: null, candidates: [] };
  }
  // Capped because this is model-written prose that gets persisted as
  // `oasSource.summary` and then rendered in places that assume one short
  // line: a picker hint (the picker's redraw math counts exactly one row per
  // item) and a spinner label. A paragraph-length summary breaks both.
  const SUMMARY_MAX = 120;
  const rawSummary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  const summary = rawSummary
    ? (rawSummary.length > SUMMARY_MAX ? `${rawSummary.slice(0, SUMMARY_MAX - 1)}…` : rawSummary)
    : null;
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const seen = new Set();
  const candidates = [];
  for (const c of list) {
    const rel = typeof c?.path === 'string' ? c.path.trim() : '';
    if (!rel) continue;
    const absPath = path.resolve(rootDir, rel);
    if (seen.has(absPath)) continue;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
    seen.add(absPath);
    candidates.push({ path: path.relative(rootDir, absPath), absPath, title: typeof c.title === 'string' ? c.title.trim() : '' });
  }
  return { summary, candidates };
}

/**
 * Infer a name for an adopted spec instead of asking. The spec's own
 * `info.title` is the most accurate source; fall back to the package name,
 * then the repo folder. Skips generic titles like "API" / "OpenAPI".
 */
function inferApiName({ rootDir, finalOasFile }) {
  try {
    const oas = loadOas(path.join(rootDir, finalOasFile));
    const title = oas?.info?.title?.trim();
    if (title && !/^(api|openapi|swagger|title)$/i.test(title)) return { name: title, source: 'the spec' };
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    if (pkg.name) return { name: pkg.name, source: 'package.json' };
  } catch {}
  return { name: path.basename(rootDir) || 'My API', source: 'the folder name' };
}

/**
 * "User already has an OAS file" branch. One freeform prompt that accepts a
 * file path, a URL, or a plain-English description; resolves it; then runs the
 * shared finalize. If the user can't point us at a spec, returns
 * { fallbackToGenerate: true } so the caller drops into the AI generate flow.
 */
async function adoptExistingOas({ rootDir, packageDir, update, setSpinner, known = null }) {
  const apiDir = path.join(rootDir, '.restless');

  // Non-interactive (agent / CI): there's no one to paste a file path or
  // URL, and the loop below `continue`s forever on empty input. Fall
  // straight through to AI generation, which needs no typed input.
  if (!isInteractive()) return { fallbackToGenerate: true };

  while (true) {
    // This screen REPLACES the yes/no picker rather than printing under it.
    // Pushing the question into the plan message re-renders the frame (which
    // clears everything below it), so the user sees one question at a time
    // instead of an answered one stacked above a live one. It also means the
    // re-prompt on a failed lookup redraws cleanly instead of accumulating.
    update({ status: 'active', activeSub: 0, message: [
      `  ${bold('Where is your OpenAPI spec?')}`,
      '',
      `  ${dim('A file path, a URL, or just tell us where to look:')}`,
      `  ${dim('  docs/openapi.yaml')}`,
      `  ${dim('  https://api.acme.com/openapi.json')}`,
      `  ${dim("  it's served at /docs-json")}`,
      `  ${dim('  run npm run openapi')}`,
    ]});
    console.log('');
    // No second question here - the prompt glyph is enough once the question
    // is the heading.
    const input = (await ask(`  ${cyan('❯')} `)).trim();
    if (!input) continue;

    let finalOasFile = null;
    let oasSource = null;
    if (/^https?:\/\//i.test(input)) {
      const res = await fetchOasFromUrl({ url: input, rootDir, destDir: apiDir, setSpinner });
      for (const line of describeSpecOutcome(res)) console.log(line);
      finalOasFile = res.ok ? res.oasFile : null;
      oasSource = { kind: 'url', url: input };
    } else {
      const absPath = path.isAbsolute(input) ? input : path.resolve(rootDir, input);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const res = adoptOasFile({ absPath, rootDir, destDir: apiDir });
        for (const line of describeSpecOutcome(res)) console.log(line);
        finalOasFile = res.ok ? res.oasFile : null;
        oasSource = { kind: 'file', input };
      } else {
        // Nothing to lose here: setup has no spec yet, so the destination is
        // the file we are about to create either way.
        const located = await locateOasWithAi({
          input, rootDir, destFile: OAS_FILE, packageDir, setSpinner,
          onAmbiguous: pickOasCandidate,
        });
        console.log('');
        if (located.ok) {
          console.log(located.chosenPath
            ? `  ${green('✓')} Using ${bold(located.chosenPath)}, copied to ${bold(located.oasFile)}.`
            : `  ${green('✓')} Spec ready at ${bold(located.oasFile)}.`);
        } else {
          console.log(`  ${yellow('•')} ${located.error}`);
        }
        finalOasFile = located.ok ? located.oasFile : null;
        // Record what was actually done to find the spec, not the freeform
        // instruction the user typed.
        oasSource = { kind: 'describe', summary: located.summary };
      }
    }

    if (finalOasFile) {
      // The caller usually already knows which API this spec belongs to (the
      // scan ran first), so take its identity rather than re-deriving a
      // second, differently-named one for the same code.
      let name, apiRootDir, framework, language;
      if (known) {
        ({ name, apiRootDir, framework, language } = known);
      } else {
        // Standalone use: recover where the API lives (which package to
        // install the SDK into) and a best-effort framework/language.
        let signals = [];
        try { signals = scanCodebase(packageDir).frameworkSignals; } catch {}
        apiRootDir = await chooseApiRootDir(signals);
        ({ framework, language } = guessShape(signals, packageDir, apiRootDir));
        const inferred = inferApiName({ rootDir, finalOasFile });
        name = inferred.name;
        console.log('');
        console.log(`  ${green('✓')} Calling it ${bold(name)} ${dim(`(from ${inferred.source}).`)}`);
      }
      return await finalizeApi({
        rootDir,
        packageDir,
        update,
        setSpinner,
        name,
        apiRootDir,
        framework,
        language,
        finalOasFile,
        endpoints: [],
        replacePlaceholderDomain: false,
        oasSource,
      });
    }

    // Couldn't resolve - re-prompt, with an escape hatch to full AI generation.
    console.log('');
    const next = await singleSelect(
      [
        { label: 'Try again', hint: 'Enter a different path, URL, or description.' },
        { label: 'Generate it with AI instead', hint: "We'll scan your code and write the spec." },
      ],
      { message: "We couldn't get a spec from that. What now?", defaultIndex: 0 },
    );
    if (next === 1) return { fallbackToGenerate: true };
  }
}

/**
 * APIs a previous run already mapped: an `oasSource` recorded in settings and
 * a spec still on disk that still parses. A spec we can't read is dropped
 * from the list rather than offered, so the caller falls through to the normal
 * flow and re-maps it instead of carrying a broken file forward.
 */
function rememberedApis({ rootDir }) {
  const settings = loadSettings(rootDir);
  const out = [];
  for (const api of settings.apis || []) {
    if (!api.oasSource || !api.oasFile) continue;
    const abs = path.join(rootDir, api.oasFile);
    if (!fs.existsSync(abs)) continue;
    const endpoints = countOasEndpoints(abs);
    if (endpoints === null) {
      debug.log('generate-oas.remembered-unparseable', { oasFile: api.oasFile });
      continue;
    }
    out.push({ api, endpoints });
  }
  return out;
}

/** The shape generateOas hands downstream, built from a settings entry. */
function shapeFromRemembered(api) {
  return {
    detectedLanguage: api.language ? api.language.toLowerCase() : null,
    detectedFramework: api.framework || null,
    apiRootDir: api.rootDir || '.',
    domain: api.baseUrl || null,
  };
}

/**
 * Re-run path: one or more APIs in this repo are already mapped. Rather than
 * flashing a "reusing your spec" line and jumping straight to step 2 (which
 * read as a flicker - you couldn't tell what got picked, or that a choice had
 * even been made), show what we found and have the user confirm it.
 *
 * With several mapped APIs this is the picker - previously more than one fell
 * through to a full re-scan, throwing away specs we already had.
 *
 * Returns the chosen `{ api, endpoints }`, or null to fall through to the
 * scan / adopt flow. Non-interactive runs take the first entry (the picker's
 * default), which keeps the old silent-reuse behaviour for agents.
 */
/**
 * The one-line summary this screen leads with. Exposed separately so the
 * step intro can render it as its own body: `startStep` reveals the intro
 * line by line, and having this function repaint the block right afterwards
 * meant the intro visibly typed itself in and was then wiped - a flicker
 * that read as the CLI changing its mind.
 */
function rememberedSummary(remembered) {
  return remembered.length === 1
    ? `${green('✓')} ${bold(remembered[0].api.name)} is already mapped ${dim(`(${describeOasSource(remembered[0].api.oasSource)})`)}.`
    : `${green('✓')} Found ${bold(String(remembered.length))} APIs in this repo that are already mapped.`;
}

async function confirmRememberedOas({ remembered }) {
  const one = remembered.length === 1;
  // One plain line, no ANSI: the picker renders a hint as a single dim row
  // (`linesPerItem` counts exactly one), so a newline here would desync its
  // redraw math, and a nested bold/dim would cancel the dim mid-line.
  const describe = ({ api, endpoints }) => [
    api.oasFile,
    `${endpoints} endpoint${endpoints === 1 ? '' : 's'}`,
    api.framework || api.language || null,
    api.rootDir && api.rootDir !== '.' ? `./${api.rootDir}` : './',
  ].filter(Boolean).join(' · ');

  const options = one
    ? [
        { label: 'Yes, use this spec', hint: describe(remembered[0]) },
        { label: 'No, map a different API', hint: "We'll look at your code again, or you can point us at another spec." },
      ]
    : [
        ...remembered.map((r) => ({ label: r.api.name, hint: describe(r) })),
        { label: 'Something else', hint: "Map an API we haven't set up yet." },
      ];

  const picked = await singleSelect(options, {
    message: one ? 'Is this the API you want to set up?' : 'Which API do you want to set up?',
    defaultIndex: 0,
  });

  if (one) return picked === 0 ? remembered[0] : null;
  return picked < remembered.length ? remembered[picked] : null;
}

/**
 * The lines describing routes a generation pass couldn't cover. Shared so
 * `init` and `update` report an incomplete spec identically - a gap that is
 * loud in one flow and silent in the other is worse than either.
 */
export function describeCoverageGap(coverage) {
  const n = coverage.missing.length;
  return [
    `  ${yellow('•')} ${n} route${n === 1 ? '' : 's'} couldn't be added to the spec automatically:`,
    ...coverage.missing.slice(0, 8).map((m) => `    ${dim(`${m.methods.join(', ')} ${m.path}`)}`),
    ...(n > 8 ? [`    ${dim(`… and ${n - 8} more`)}`] : []),
  ];
}

/**
 * Write a spec by reading the routes: the AI pass, its parse-and-fix loop, and
 * the file-route coverage guard. Exported because `npx restless update` regenerates
 * through exactly this path - "re-scan my routes" has to mean the same thing
 * after setup as during it, including the coverage guard, or an update would
 * quietly produce a less complete spec than the original.
 *
 * Returns `{ ok, oasFile, oasFullPath, coverage }`, and on a parse failure
 * `{ ok: false, error }` rather than exiting: `init` treats that as fatal
 * because it has no spec to fall back on, while `update` still has the
 * previous one on disk and should say so instead of dying.
 */
export async function generateOasWithAi({
  rootDir,
  packageDir,
  apiRootDir = '.',
  name,
  framework = null,
  internalEndpoints = [],
  existingOasFile = null,
  preferNative = false,
  oasFile = OAS_FILE,
  setSpinner,
}) {
  const existingOasNote = existingOasFile
    ? `An existing OAS file was found at ${existingOasFile}. Use it as a starting point - update it if the code has diverged, but preserve any hand-written descriptions or examples.`
    : '';
  // Only when the user actually chose native generation. Previously this
  // note went out whenever the framework *could* generate, so someone who
  // wanted the routes read directly still got a spec assembled from the
  // framework's output.
  const frameworkNote = preferNative
    ? `This framework (${framework}) supports generating an OAS file natively, and the user asked for that. Use the framework's built-in OAS generation first. If it doesn't produce a complete spec, fill in the gaps from the routes.`
    : '';
  const internalNote = internalEndpoints?.length
    ? `The following endpoints were detected as internal/admin and should be marked as such:\n${internalEndpoints.join(', ')}\n\nFor internal endpoints: include them in the spec but tag them with \`x-internal: true\` and add them to a tag called "Internal". This way they're documented but can be filtered out by tools that consume the spec.`
    : '';

  // Pass an absolute path to the AI so it can't accidentally walk up
  // the tree and write into a parent's `.restless/` directory. The relative
  // path was getting resolved against whatever the AI considered "the
  // project root," which sometimes meant the monorepo above the user's
  // actual package.
  const oasFullPath = path.resolve(rootDir, oasFile);
  const apiDir = path.resolve(packageDir, apiRootDir || '.');
  const endpointChecklist = buildEndpointChecklist(apiDir);

  await runAI(
    loadPrompt('generate-oas', {
      name,
      domain: PLACEHOLDER_DOMAIN,
      oasFile: oasFullPath,
      existingOasNote,
      frameworkNote,
      internalNote,
      endpointChecklist,
    }),
    packageDir,
    { setSpinner },
  );

  // Validate before we go any further - server uses the same parse logic,
  // so if it fails here it'll fail there too. Hand errors back to the LLM
  // and let it iterate.
  const validation = await validateAndFixOas({ oasFullPath, packageDir, setSpinner });
  if (!validation.ok) {
    return { ok: false, error: validation.error, oasFile, oasFullPath };
  }

  // Completeness guard: the single-pass generator can silently drop large,
  // deeply-nested route trees while still emitting their schemas. Diff the
  // authoritative file-route list against what landed and fill any gaps.
  const coverage = await ensurePathCoverage({ apiDir, oasFullPath, packageDir, setSpinner });
  return { ok: true, oasFile, oasFullPath, coverage };
}

export default async function generateOas({ packageDir, rootDir, update, setSpinner, aiTool = 'Claude Code' }) {
  // Work out what this step is about BEFORE drawing anything. On a re-run the
  // answer is "you already have a spec", and the generic explainer would be
  // revealed and then immediately overwritten by that - a flash of text that
  // reads like the CLI changing its mind mid-thought.
  const remembered = rememberedApis({ rootDir });

  await startStep({
    update,
    stepNum: 1,
    title: 'Map your API',
    // No Privacy block: the welcome screen already promised the agent is
    // local and nothing uploads until the end, and repeating it at every
    // step reads as protesting too much.
    intro: remembered.length
      ? rememberedSummary(remembered)
      : `An OpenAPI spec is the map of your API - every endpoint, parameter,\n` +
        `and response. The next steps wire the SDK up from it.`,
    sections: [],
    // The question below is the gate - no separate keypress, so the intro
    // stays on screen with the question under it.
    skipWait: true,
  });

  // Re-run path: anything already mapped gets confirmed (or picked, with
  // several) rather than silently reused.
  if (remembered.length) {
    const chosen = await confirmRememberedOas({ remembered });
    if (chosen) {
      update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
        `  ${green('✓')} Using ${bold(chosen.api.name)}: ${bold(chosen.api.oasFile)} ${dim(`(${chosen.endpoints} endpoint${chosen.endpoints === 1 ? '' : 's'})`)}.`,
      ]});
      debug.log('generate-oas.reused', { oasFile: chosen.api.oasFile, endpoints: chosen.endpoints });
      return shapeFromRemembered(chosen.api);
    }
  }

  // Bail on a repo we can't set up BEFORE spending an AI pass on it. Detection
  // is Node-only end to end, and the "we couldn't find any APIs" picker below
  // offers exactly one option - a free-form hint that re-runs the same
  // Node-only scan - so a Python repo used to loop there indefinitely with no
  // way out but Ctrl-C. Scoped to `packageDir` because that's the tree
  // `locateApis` actually scans.
  // Which languages to scan this repo as. Normally one; a Django API behind
  // a Next.js frontend is legitimately two, and both get scanned so the
  // picker can offer either rather than us silently choosing for the user.
  let setupLanguages = ['javascript'];
  if (!stackCheckDisabled()) {
    const stack = detectStack(packageDir);
    debug.log('generate-oas.stack-check', {
      supported: stack.supported,
      languages: stack.languages,
      setupLanguages: stack.setupLanguages,
      nodeEvidence: stack.nodeEvidence,
    });
    if (!stack.supported) {
      const { headline, details } = unsupportedStackMessage(stack, {
        rootDir: packageDir,
        cliName: CLI_NAME,
      });
      fatalError(headline, details);
    }
    setupLanguages = stack.setupLanguages;
  }

  // Find the API BEFORE asking about specs. Asking first meant answering
  // "do you have a spec?" with no shared idea of which API we meant - and it
  // threw away what the scan knows: whether a spec is already sitting in the
  // repo, and whether the framework can emit one itself. Both become options
  // once we ask second.
  //
  // Detect APIs in the repo and let the user pick one.
  //
  // Loop: detect → (optionally cross-reference with .restless/settings.json for
  // already-set-up markers) → pick. If user picks "Other", collect a free-form
  // hint and re-detect with it.
  let hint = '';
  let selectedApi;
  let selectedExisting;  // matching settings.apis[] entry if already set up
  while (!selectedApi) {
    update({
      status: 'active',
      activeSub: 0,
      message: hint
        ? [`  ${dim('Searching again with your hint…')}`]
        : [`  We're looking through your code to find every endpoint and detect the framework.`],
    });

    const apis = await locateApis({ packageDir, setSpinner, hint, languages: setupLanguages });

    // Cross-reference each detected API with .restless/settings.json. Match by
    // rootDir first, then by name.
    const settings = loadSettings(rootDir);
    const annotated = apis.map((a) => {
      const match = settings.apis?.find((s) =>
        (s.rootDir && s.rootDir === a.rootDir) || s.name === a.name,
      );
      const isSetup = !!(
        match &&
        match.oasFile &&
        fs.existsSync(path.join(rootDir, match.oasFile))
      );
      return { ...a, existing: match, isSetup };
    });

    const labels = annotated.map((a) => {
      const count = (a.endpoints?.length || 0) + (a.internalEndpoints?.length || 0);
      const lang = a.framework ? `${a.language}/${a.framework}` : a.language || 'unknown';
      const locPath = a.rootDir && a.rootDir !== '.' ? `./${a.rootDir}` : './';
      const setupBadge = a.isSetup ? `  ${green('✓ already set up')}` : '';
      const meta = dim(`${count} endpoints · ${lang} · ${locPath}`);
      return `${bold(a.name)}${setupBadge}\n${meta}`;
    });
    // Always include "Other" as the last option so the user can redirect us.
    labels.push(`${bold('Other')}\n${dim('tell us where to look')}`);

    console.log('');
    console.log(`  ${dim(`We support ${SUPPORTED_LANGUAGES_LABEL} projects (more coming soon).`)}`);
    console.log('');
    const chosenIdx = await singleSelect(labels, {
      message: apis.length === 0
        ? "We couldn't find any APIs. Can you point us at one?"
        : 'Which API should we map out?',
      defaultIndex: 0,
    });

    // "Other" - prompt for a plain-English hint, then loop and re-detect.
    if (chosenIdx === labels.length - 1) {
      // Same shape as the spec question: replace the picker with the prompt
      // rather than printing beneath the choice they just made.
      update({ status: 'active', activeSub: 0, message: [
        `  ${bold('Where should we look?')}`,
        '',
        `  ${dim('Point us at it however you like:')}`,
        `  ${dim("  it's a Python FastAPI in backend/api")}`,
        `  ${dim("  look in services/gateway - it's a Go server")}`,
        `  ${dim('  three workers in packages/, I want the one named billing')}`,
      ]});
      console.log('');
      const newHint = (await ask(`  ${cyan('❯')} `)).trim();
      if (!newHint) {
        console.log('');
        console.log(`  ${dim('No hint given. Exiting.')}`);
        process.exit(0);
      }
      hint = newHint;
      continue;
    }

    selectedApi = annotated[chosenIdx];
    selectedExisting = selectedApi.existing;
  }

  // If the chosen API is already fully set up, short-circuit.
  if (selectedApi.isSetup && selectedExisting) {
    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
      `  ${green('✓')} ${bold(selectedApi.name)} is already set up (${selectedExisting.oasFile}).`,
      `  ${dim('Delete the entry from .restless/settings.json if you want to regenerate.')}`,
    ]});
    return {
      detectedLanguage: selectedExisting.language || selectedApi.language || null,
      detectedFramework: selectedExisting.framework || selectedApi.framework || null,
      domain: selectedExisting.baseUrl || null,
    };
  }

  // === Summary of the chosen API ===
  const ep = selectedApi.endpoints?.length || 0;
  const internal = selectedApi.internalEndpoints?.length || 0;
  const totalEp = ep + internal;
  const framework = selectedApi.framework || selectedApi.language || 'unknown';
  {
    const lines = [
      `  Setting up ${bold(selectedApi.name)} - ${bold(framework)} with ${bold(String(totalEp))} endpoint${totalEp === 1 ? '' : 's'}${internal > 0 ? ` ${dim(`(${internal} internal)`)}` : ''}.`,
    ];
    if (selectedApi.rootDir && selectedApi.rootDir !== '.') {
      lines.push(`  ${dim(`Located in ${selectedApi.rootDir}`)}`);
    }
    update({ sub: { 0: 'done' }, activeSub: 1, message: lines });
  }

  // === Where should the spec come from? ===
  // Now that we know which API we're talking about, the scan's findings turn
  // into offers: a spec it already found in the repo, and native generation
  // when the framework supports it (@fastify/swagger, @nestjs/swagger, tsoa,
  // …). Both used to be applied silently or buried in a prompt note.
  const existingOasPath = selectedApi.existingOasFile
    ? path.join(rootDir, selectedApi.existingOasFile)
    : null;
  const hasExistingOas = existingOasPath && fs.existsSync(existingOasPath);
  const canGenerateNatively = !!selectedApi.frameworkCanGenerateOas;

  const oasFile = OAS_FILE;
  let skipReason = null;
  let finalOasFile = oasFile;
  let preferNativeGeneration = canGenerateNatively;
  // How this spec came to be, recorded on the settings entry. This is not
  // decoration: `npx restless update` reads it to decide what "refresh my spec"
  // means, and the right answer is completely different per kind (re-fetch a
  // URL, re-read a file the user maintains, re-run a framework generator,
  // re-scan the routes). Every branch below has to set it.
  let oasSource = null;

  {
    const options = [];
    const kinds = [];
    if (hasExistingOas) {
      options.push({
        label: `Use the spec we found`,
        hint: `${selectedApi.existingOasFile} - we point at it and never overwrite it.`,
      });
      kinds.push('found');
    }
    if (canGenerateNatively) {
      options.push({
        label: `Generate it with ${framework}`,
        hint: `${framework} can emit its own spec - usually the most accurate option.`,
      });
      kinds.push('native');
    }
    options.push({
      label: 'Generate one with AI',
      hint: `${aiTool} reads your routes and writes it, locally.`,
    });
    kinds.push('ai');
    options.push({
      label: hasExistingOas ? 'Use a different spec' : 'I already have a spec',
      hint: 'Point us at a file, a URL, or describe where it is.',
    });
    kinds.push('adopt');

    const picked = kinds[await singleSelect(options, {
      // Plain text - the picker bolds the whole message itself.
      message: `Where should the spec for ${selectedApi.name} come from?`,
      defaultIndex: 0,
    })];
    debug.log('generate-oas.spec-source', { picked, hasExistingOas, canGenerateNatively });

    if (picked === 'found') {
      // Point settings at their file - don't overwrite their work.
      finalOasFile = selectedApi.existingOasFile;
      skipReason = `using ${bold(selectedApi.existingOasFile)}`;
      oasSource = oasSourceForPick('found', { existingOasFile: selectedApi.existingOasFile });
    } else if (picked === 'adopt') {
      // Hand the detected API's identity over so the adopted spec lands on
      // the same settings entry instead of a second, re-inferred one.
      const res = await adoptExistingOas({
        rootDir, packageDir, update, setSpinner,
        known: {
          name: selectedApi.name,
          apiRootDir: selectedApi.rootDir || '.',
          framework: selectedApi.framework,
          language: selectedApi.language,
        },
      });
      // adoptExistingOas records its own provenance (url / file / describe)
      // and finalizes, so a successful adopt never reaches the tail below.
      if (!res.fallbackToGenerate) return res;
      preferNativeGeneration = canGenerateNatively;
      oasSource = oasSourceForPick(preferNativeGeneration ? 'native' : 'ai', {
        framework: selectedApi.framework,
      });
    } else {
      // 'ai' means write it from the routes even if the framework could have
      // emitted one; 'native' means try the framework's generator first.
      preferNativeGeneration = picked === 'native';
      oasSource = oasSourceForPick(preferNativeGeneration ? 'native' : 'ai', {
        framework: selectedApi.framework,
      });
    }
  }

  if (skipReason) {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} Skipped OAS generation ${dim(skipReason)}.`,
    ]});
  } else {
    // Run the AI generator.
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  Turning your ${bold(String(totalEp))} endpoints into an OpenAPI spec - the standard`,
      `  format tools and SDKs use to talk to your API.`,
      '',
    ]});

    const gen = await generateOasWithAi({
      rootDir,
      packageDir,
      apiRootDir: selectedApi.rootDir || '.',
      name: selectedApi.name,
      framework: selectedApi.framework,
      internalEndpoints: selectedApi.internalEndpoints,
      existingOasFile: selectedApi.existingOasFile,
      preferNative: preferNativeGeneration,
      oasFile,
      setSpinner,
    });

    if (!gen.ok) {
      fatalError('Generated OpenAPI spec failed to parse.', [
        gen.error,
        `File: ${gen.oasFullPath}`,
        'Try re-running, or open the file and fix it by hand.',
      ]);
    }

    if (gen.coverage && !gen.coverage.ok && gen.coverage.missing.length) {
      // Never ship an incomplete spec silently - name what's still missing.
      update({ sub: { 0: 'done' }, activeSub: 1, message: describeCoverageGap(gen.coverage) });
    }
  }

  // Visibility + base URL + demo curl + settings write. Shared with the
  // adopt-existing-spec path so both produce the same settings shape.
  return await finalizeApi({
    rootDir,
    packageDir,
    update,
    setSpinner,
    name: selectedApi.name,
    apiRootDir: selectedApi.rootDir || '.',
    framework: selectedApi.framework,
    language: selectedApi.language,
    finalOasFile,
    endpoints: selectedApi.endpoints || [],
    replacePlaceholderDomain: finalOasFile === oasFile && !skipReason,
    oasSource,
  });
}
