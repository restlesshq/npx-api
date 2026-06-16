import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, red, yellow, orange, ask, singleSelect, waitForKey } from '../lib/ui.js';
import { loadSettings, saveSettings, upsertApi, generatePrefix } from '../lib/settings.js';
import { startStep } from '../lib/step-template.js';
import { fatalError } from '../lib/errors.js';
import { scanCodebase } from '../lib/find-endpoints.js';
import { extractJson } from '../lib/extract-json.js';
import { findOasCandidates } from '../lib/find-oas.js';
import { parseOas } from '../lib/oas-parse.js';
import { loadOas } from '../lib/oas-auth.js';
import { findTestCandidates, buildCurl } from '../lib/test-endpoint.js';
import { safeWriteFileSync, safeMkdirSync } from '../lib/pathGuard.js';

const MAX_OAS_FIX_ATTEMPTS = 2;

// Where a generated/adopted spec lands, and the placeholder server URL the
// generate-oas prompt writes (swapped for the real base URL in finalizeApi).
const OAS_FILE = '.restless/openapi.json';
const PLACEHOLDER_DOMAIN = 'https://example.com';

// Read the file we just wrote and parse it the same way the server will. If
// it doesn't parse, hand the error back to the LLM and ask it to fix the file
// in place. Retries up to MAX_OAS_FIX_ATTEMPTS times.
async function validateAndFixOas({ oasFullPath, packageDir, setSpinner }) {
  for (let attempt = 0; attempt <= MAX_OAS_FIX_ATTEMPTS; attempt++) {
    let raw;
    try {
      raw = fs.readFileSync(oasFullPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `Could not read ${oasFullPath}: ${err.message}` };
    }
    const format = oasFullPath.endsWith('.json') ? 'json' : 'yaml';
    const result = parseOas(raw, format);
    if (result.ok) return { ok: true };

    if (attempt === MAX_OAS_FIX_ATTEMPTS) {
      return { ok: false, error: result.error };
    }

    setSpinner('Fixing OpenAPI spec');
    const fixPrompt = loadPrompt('fix-oas', {
      oasFile: oasFullPath,
      parseError: result.error,
    });
    await runAI(fixPrompt, packageDir, { setSpinner });
  }
  return { ok: false, error: 'Exhausted fix attempts' };
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
function buildFindingsSection(packageDir) {
  const endpointResult = scanCodebase(packageDir);
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
  if (endpointResult.frameworkSignals.length > 0) {
    lines.push('Framework signals (per package.json, from deps + source markers):');
    for (const s of endpointResult.frameworkSignals) {
      const parts = [];
      if (s.frameworkDeps.length) parts.push(`deps[${s.frameworkDeps.join(', ')}]`);
      if (s.sourceMarkers.length) parts.push(`source uses ${s.sourceMarkers.join(', ')}`);
      if (s.oasGenDeps.length) parts.push(`OAS-capable via ${s.oasGenDeps.join(', ')}`);
      parts.push(`${s.endpointCount} inline route${s.endpointCount === 1 ? '' : 's'} matched`);
      const label = s.name ? `${s.package} (${s.name})` : s.package;
      lines.push(`- ${label}: ${parts.join(' · ')}`);
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
async function locateApis({ packageDir, setSpinner, hint = '' }) {
  const findingsSection = buildFindingsSection(packageDir);
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
    return `${bold(s.name || loc)}\n${dim(`${fw} · ${s.endpointCount} route${s.endpointCount === 1 ? '' : 's'} · ${loc}`)}`;
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
}) {
  // Heuristic default for visibility - bias toward "internal" if the name,
  // framework, or routes look service-y.
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
  const looksInternal = internalSignals >= 2;

  const firstEndpoint = endpoints?.[0]?.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '') || '/example';
  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    '  Two quick things before we wrap up the spec.',
  ]});

  const visibilityIndex = await singleSelect(
    [
      { label: 'External', hint: 'Public-facing, used by your API consumers.' },
      { label: 'Internal', hint: 'Private, only your own services or staff hit it.' },
    ],
    {
      message: `Is ${name} external or internal?`,
      defaultIndex: looksInternal ? 1 : 0,
    },
  );
  const isInternal = visibilityIndex === 1;

  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    '  And the base URL of your API in production:',
    `  ${dim(`So we know that ${firstEndpoint} lives at <base_url>${firstEndpoint}.`)}`,
  ]});
  const domain = await ask(`\n  ${bold('Base URL:')} `);

  // Replace placeholder domain in the AI-generated OAS file only when we
  // actually generated one (not when we're reusing a user's existing file).
  if (replacePlaceholderDomain && finalOasFile) {
    const oasFullPath = path.join(rootDir, finalOasFile);
    try {
      const oasContent = fs.readFileSync(oasFullPath, 'utf8');
      const updated = oasContent.replaceAll(PLACEHOLDER_DOMAIN, domain || 'http://localhost:3000');
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
      testCurl = await pickTestCurl({
        oasFullPath: path.join(rootDir, finalOasFile),
        baseUrl: domain,
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
  ]});

  return {
    detectedLanguage: language ? language.toLowerCase() : null,
    detectedFramework: framework || null,
    apiRootDir,
    domain,
  };
}

/**
 * Fetch a spec from a URL once, validate it parses (same parser the server
 * uses), and save it under .restless/. Returns the repo-relative path, or
 * null on any failure so the caller can re-prompt.
 */
async function fetchOasFromUrl({ url, rootDir, apiDir, setSpinner }) {
  setSpinner({ phase: 'Fetching spec', detail: url });
  let raw;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      setSpinner('');
      console.log('');
      console.log(`  ${red('✗')} ${url} returned ${res.status}.`);
      return null;
    }
    raw = await res.text();
  } catch (err) {
    setSpinner('');
    console.log('');
    console.log(`  ${red('✗')} Couldn't fetch ${url}: ${err.message}`);
    return null;
  }
  setSpinner('');

  // Detect JSON vs YAML so we save with the right extension (validateAndFixOas
  // and the server both key off it). Try strict JSON first, then YAML.
  let format = 'json';
  let parsed = parseOas(raw, 'json');
  if (!parsed.ok || !isStrictJson(raw)) {
    const asYaml = parseOas(raw, 'yaml');
    if (asYaml.ok && !isStrictJson(raw)) {
      parsed = asYaml;
      format = 'yaml';
    }
  }
  if (!parsed.ok) {
    console.log('');
    console.log(`  ${red('✗')} That URL didn't return a valid OpenAPI spec.`);
    console.log(`  ${dim(parsed.error)}`);
    return null;
  }

  if (!fs.existsSync(apiDir)) safeMkdirSync(apiDir, { recursive: true });
  const dest = path.join(apiDir, format === 'yaml' ? 'openapi.yaml' : 'openapi.json');
  safeWriteFileSync(dest, raw);
  const rel = path.relative(rootDir, dest);
  console.log('');
  console.log(`  ${green('✓')} Downloaded to ${bold(rel)}.`);
  return rel;
}

function isStrictJson(raw) {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adopt an OAS file already on disk. Copies it into .restless/ if it lives
 * outside the repo (so it ships with the code), validates it parses, and
 * returns the repo-relative path, or null if it doesn't parse.
 */
function adoptOasFile({ absPath, rootDir, apiDir }) {
  const raw = (() => {
    try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  })();
  if (raw === null) {
    console.log('');
    console.log(`  ${red('✗')} Couldn't read ${absPath}.`);
    return null;
  }
  const format = absPath.endsWith('.json') ? 'json' : 'yaml';
  const parsed = parseOas(raw, format);
  if (!parsed.ok) {
    console.log('');
    console.log(`  ${red('✗')} ${path.relative(rootDir, absPath)} didn't parse as an OpenAPI spec.`);
    console.log(`  ${dim(parsed.error)}`);
    return null;
  }

  const rel = path.relative(rootDir, absPath);
  if (rel.startsWith('..')) {
    // Outside the repo - copy into .restless/ so it lives with the codebase.
    if (!fs.existsSync(apiDir)) safeMkdirSync(apiDir, { recursive: true });
    const ext = path.extname(absPath) || '.yaml';
    const dest = path.join(apiDir, `openapi${ext}`);
    fs.copyFileSync(absPath, dest);
    const destRel = path.relative(rootDir, dest);
    console.log('');
    console.log(`  ${green('✓')} Copied to ${bold(destRel)} so it lives with your code.`);
    return destRel;
  }
  console.log('');
  console.log(`  ${green('✓')} Using the file at ${bold(rel)}.`);
  return rel;
}

/**
 * Hand the user's freeform description to the AI: it locates an existing spec
 * in the repo or runs the project's own generation, landing a spec at the
 * absolute oas path. Returns the repo-relative path if a valid spec shows up,
 * else null so the caller can re-prompt.
 */
async function locateOasWithAi({ input, rootDir, oasFile, packageDir, setSpinner }) {
  const oasFileAbsolute = path.resolve(rootDir, oasFile);
  // Clear any stale file so a no-op AI run is detectable.
  try { if (fs.existsSync(oasFileAbsolute)) fs.rmSync(oasFileAbsolute); } catch {}

  setSpinner({ phase: 'Looking for your spec', detail: input });
  try {
    await runAI(loadPrompt('locate-oas', { userInstruction: input, oasFile: oasFileAbsolute }), packageDir, { setSpinner });
  } catch {}
  setSpinner('');

  if (!fs.existsSync(oasFileAbsolute)) {
    console.log('');
    console.log(`  ${yellow('•')} Couldn't find or generate a spec from that.`);
    return null;
  }
  const validation = await validateAndFixOas({ oasFullPath: oasFileAbsolute, packageDir, setSpinner });
  if (!validation.ok) {
    console.log('');
    console.log(`  ${yellow('•')} Found something, but it didn't parse as a valid spec.`);
    return null;
  }
  console.log('');
  console.log(`  ${green('✓')} Spec ready at ${bold(oasFile)}.`);
  return oasFile;
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
async function adoptExistingOas({ rootDir, packageDir, update, setSpinner }) {
  const apiDir = path.join(rootDir, '.restless');

  while (true) {
    console.log('');
    console.log(`  ${dim('Paste a file path, a URL, or describe where your spec is. For example:')}`);
    console.log(`  ${dim('• "docs/openapi.yaml"')}`);
    console.log(`  ${dim('• "https://api.acme.com/openapi.json"')}`);
    console.log(`  ${dim('• "it\'s served at /docs-json" or "run npm run openapi"')}`);
    console.log('');
    const input = (await ask('  Where is it? ')).trim();
    if (!input) continue;

    let finalOasFile = null;
    if (/^https?:\/\//i.test(input)) {
      finalOasFile = await fetchOasFromUrl({ url: input, rootDir, apiDir, setSpinner });
    } else {
      const absPath = path.isAbsolute(input) ? input : path.resolve(rootDir, input);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        finalOasFile = adoptOasFile({ absPath, rootDir, apiDir });
      } else {
        finalOasFile = await locateOasWithAi({ input, rootDir, oasFile: OAS_FILE, packageDir, setSpinner });
      }
    }

    if (finalOasFile) {
      // Recover where the API lives (which package to install the SDK into)
      // and a best-effort framework/language, from one deterministic scan.
      let signals = [];
      try { signals = scanCodebase(packageDir).frameworkSignals; } catch {}
      const apiRootDir = await chooseApiRootDir(signals);
      const { framework, language } = guessShape(signals, packageDir, apiRootDir);

      const { name, source } = inferApiName({ rootDir, finalOasFile });
      console.log('');
      console.log(`  ${green('✓')} Calling it ${bold(name)} ${dim(`(from ${source}).`)}`);
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

export default async function generateOas({ packageDir, rootDir, update, setSpinner, aiTool = 'Claude Code', existingOas = false }) {
  await startStep({
    update,
    stepNum: 1,
    title: 'Map your API',
    intro: "Alright, let's get your API's OpenAPI spec.",
    sections: [
      {
        label: 'Why',
        body:
          `An OpenAPI spec is the shape of your API, every endpoint, parameter,\n` +
          `and response. Later steps use it to install the right adapter and wire up\n` +
          `the middleware exactly.`,
      },
      {
        label: "What we'll do",
        body:
          `If you already have an OpenAPI or Swagger spec, point us at it, a file, a\n` +
          `URL, or just a description of where it is. If you don't, ${orange(aiTool)} (running\n` +
          `locally) reads your routes and writes one. Either way it lands in a new\n` +
          `${bold('.restless/')} folder, commit that along with your code, it's meant to live there.`,
      },
      {
        label: 'Privacy',
        body:
          `Anything we read or generate happens on your machine via your own\n` +
          `${orange(aiTool)} install. We don't see a single line of your code, and nothing\n` +
          `gets sent to our servers at this step.`,
      },
    ],
    action: 'map your API',
  });

  // Up front: does the user already have a spec? If so, take it directly
  // (file, URL, or a description the AI resolves) and skip AI detection
  // entirely. Only fall through to the scan-and-generate flow when they don't,
  // or when adoptExistingOas couldn't get a spec and they chose to generate.
  update({ status: 'active', activeSub: 0, message: [
    `  Let's get the OpenAPI spec that describes your API.`,
  ]});
  const haveSpec = await singleSelect(
    [
      { label: 'Yes, I already have an OpenAPI spec', hint: 'Point us at a file, a URL, or describe where it is.' },
      { label: 'No, generate one with AI', hint: "We'll scan your code and write the spec." },
    ],
    { message: 'Do you already have an OpenAPI / Swagger spec?', defaultIndex: existingOas ? 0 : 1 },
  );
  if (haveSpec === 0) {
    const res = await adoptExistingOas({ rootDir, packageDir, update, setSpinner });
    if (!res.fallbackToGenerate) return res;
  }

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

    const apis = await locateApis({ packageDir, setSpinner, hint });

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
    console.log(`  ${dim('We support Node and TypeScript projects (more coming soon).')}`);
    console.log('');
    const chosenIdx = await singleSelect(labels, {
      message: apis.length === 0
        ? "We couldn't find any APIs. Can you point us at one?"
        : 'Which API should we map out?',
      defaultIndex: 0,
    });

    // "Other" - prompt for a plain-English hint, then loop and re-detect.
    if (chosenIdx === labels.length - 1) {
      console.log('');
      console.log(`  ${dim('Tell us where to look. For example:')}`);
      console.log(`  ${dim('• "it\'s a Python FastAPI in backend/api"')}`);
      console.log(`  ${dim('• "look in services/gateway - it\'s a Go server"')}`);
      console.log(`  ${dim('• "there are three workers in packages/, I want the one named billing"')}`);
      console.log('');
      const newHint = (await ask('  Where should we look? ')).trim();
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

  // === Detection: can we skip OAS generation? ===
  // We skip generation ONLY when the user already has an OAS file on disk -
  // we point at theirs and don't overwrite it. A framework that CAN generate
  // OAS natively (e.g. @fastify/swagger) is NOT a skip: we still produce a
  // `.restless/openapi.json`, but the AI is told (via `frameworkNote`) to
  // prefer the framework's own generation. "Skipping" on can-generate used to
  // leave the project with no spec at all - nothing captured the runtime one,
  // and the upload step had nothing to send.
  const existingOasPath = selectedApi.existingOasFile
    ? path.join(rootDir, selectedApi.existingOasFile)
    : null;
  const hasExistingOas = existingOasPath && fs.existsSync(existingOasPath);

  const oasFile = OAS_FILE;
  let skipReason = null;
  let finalOasFile = oasFile;

  if (hasExistingOas) {
    // Point settings at their file - don't overwrite their work.
    finalOasFile = selectedApi.existingOasFile;
    skipReason = `found OAS at ${bold(selectedApi.existingOasFile)}`;
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

    const existingOasNote = selectedApi.existingOasFile
      ? `An existing OAS file was found at ${selectedApi.existingOasFile}. Use it as a starting point - update it if the code has diverged, but preserve any hand-written descriptions or examples.`
      : '';
    const frameworkNote = selectedApi.frameworkCanGenerateOas
      ? `This framework (${selectedApi.framework}) supports generating an OAS file natively. Try using the framework's built-in OAS generation first. If it doesn't produce a complete spec, fill in the gaps manually.`
      : '';
    const internalNote = selectedApi.internalEndpoints?.length
      ? `The following endpoints were detected as internal/admin and should be marked as such:\n${selectedApi.internalEndpoints.join(', ')}\n\nFor internal endpoints: include them in the spec but tag them with \`x-internal: true\` and add them to a tag called "Internal". This way they're documented but can be filtered out by tools that consume the spec.`
      : '';

    // Pass an absolute path to the AI so it can't accidentally walk up
    // the tree and write into a parent's `.restless/` directory. The relative
    // path was getting resolved against whatever the AI considered "the
    // project root," which sometimes meant the monorepo above the user's
    // actual package.
    const oasFileAbsolute = path.resolve(rootDir, oasFile);
    const vars = {
      name: selectedApi.name,
      domain: PLACEHOLDER_DOMAIN,
      oasFile: oasFileAbsolute,
      existingOasNote,
      frameworkNote,
      internalNote,
    };

    await runAI(loadPrompt('generate-oas', vars), packageDir, { setSpinner });

    // Validate before we go any further - server uses the same parse logic,
    // so if it fails here it'll fail there too. Hand errors back to the LLM
    // and let it iterate.
    const oasFullPath = oasFileAbsolute;
    const validation = await validateAndFixOas({ oasFullPath, packageDir, setSpinner });
    if (!validation.ok) {
      fatalError('Generated OpenAPI spec failed to parse.', [
        validation.error,
        `File: ${oasFullPath}`,
        'Try re-running, or open the file and fix it by hand.',
      ]);
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
  });
}
