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
 * "User already has an OAS file" branch. Asks whether it's in the codebase
 * or at a URL, registers it in .restless/settings.json, copies the file into
 * .restless/ if it's outside the repo.
 *
 * If `selectedApi` is provided, reuses its name/framework/language instead
 * of prompting. If not, asks for a name.
 */
async function adoptExistingOas({ rootDir, update, selectedApi = null, isInternal = null }) {
  console.log('');
  const location = await singleSelect(
    [
      { label: "It's in my codebase", hint: "We'll read it from a path you give us." },
      { label: "It's at a URL", hint: "We'll fetch it once and copy it into .restless/." },
    ],
    { message: 'Where is it?', defaultIndex: 0 },
  );

  const settings = loadSettings(rootDir);
  let oasFile;
  let oasUrl;

  if (location === 0) {
    console.log('');
    const input = (await ask('  Path to the OAS file: ')).trim();
    const absPath = path.isAbsolute(input) ? input : path.resolve(rootDir, input);
    if (!fs.existsSync(absPath)) {
      fatalError(`No file at ${absPath}`);
    }

    const rel = path.relative(rootDir, absPath);
    if (rel.startsWith('..')) {
      // Outside the repo - copy into .restless/ so it lives alongside the codebase.
      const apiDir = path.join(rootDir, '.restless');
      if (!fs.existsSync(apiDir)) safeMkdirSync(apiDir, { recursive: true });
      const ext = path.extname(absPath) || '.yaml';
      const dest = path.join(apiDir, `openapi${ext}`);
      fs.copyFileSync(absPath, dest);
      oasFile = path.relative(rootDir, dest);
      console.log('');
      console.log(`  ${green('✓')} Copied to ${bold(oasFile)} so it lives with your code.`);
    } else {
      oasFile = rel;
      console.log('');
      console.log(`  ${green('✓')} Using the file at ${bold(oasFile)}.`);
    }
  } else {
    console.log('');
    const url = (await ask('  OAS URL: ')).trim();
    if (!/^https?:\/\//.test(url)) {
      fatalError("That doesn't look like a valid URL.", [`Got: ${url || '(empty)'}`]);
    }
    oasUrl = url;
    console.log('');
    console.log(`  ${green('✓')} Registered ${bold(url)}.`);
  }

  // Use selectedApi's name/framework/language if available, else prompt.
  let name;
  if (selectedApi) {
    name = selectedApi.name;
  } else {
    console.log('');
    const rawName = (await ask('  What should we call this API? ')).trim();
    name = rawName || 'My API';
  }

  upsertApi(settings, {
    name,
    rootDir: selectedApi?.rootDir || '.',
    ...(oasFile && { oasFile }),
    ...(oasUrl && { oasUrl }),
    ...(selectedApi?.framework && { framework: selectedApi.framework }),
    ...(selectedApi?.language && { language: selectedApi.language.toLowerCase() }),
    ...(isInternal !== null && { internal: isInternal }),
    lastSyncedAt: new Date().toISOString(),
    requestIdPrefix: generatePrefix(name),
  });
  saveSettings(rootDir, settings);

  update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
    `  ${green('✓')} ${bold(name)} registered. Ready for the next step.`,
  ]});

  return {
    detectedLanguage: selectedApi?.language || null,
    detectedFramework: selectedApi?.framework || null,
    domain: null,
  };
}

export default async function generateOas({ packageDir, rootDir, update, setSpinner, aiTool = 'Claude Code', existingOas = false }) {
  await startStep({
    update,
    stepNum: 1,
    title: 'Map your API',
    intro: "Alright, let's map out your API.",
    sections: [
      {
        label: 'Why',
        body:
          `An OAS file is the shape of your API, every endpoint, parameter,\n` +
          `and response. Later steps use it to install the right adapter and wire up\n` +
          `the middleware exactly.`,
      },
      {
        label: "What we'll do",
        body:
          `Point ${orange(aiTool)} (running locally on your machine) at\n` +
          `your codebase, find your routes, and write an OAS file. It lands in a new\n` +
          `${bold('.restless/')} folder, commit that along with your code, it's meant to live there.`,
      },
      {
        label: 'Privacy',
        body:
          `Scanning runs entirely on your machine via your own ${orange(aiTool)}\n` +
          `install. We don't see a single line of your code, and nothing gets sent to\n` +
          `our servers at this step.`,
      },
    ],
    action: 'locate APIs',
  });

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

  const oasFile = '.restless/openapi.json';
  const placeholderDomain = 'https://example.com';
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
      domain: placeholderDomain,
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

  // Ask the user the two things we need to finalize the spec: visibility
  // and the production base URL. Grouped so they answer them back to back
  // instead of having visibility split off into its own pre-AI screen.

  // Heuristic default for visibility - bias toward "internal" if the name,
  // framework, or routes look service-y.
  const nameLower = (selectedApi.name || '').toLowerCase();
  const frameworkLower = (selectedApi.framework || '').toLowerCase();
  const endpointsLower = (selectedApi.endpoints || []).map((e) => e.toLowerCase());
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

  const firstEndpoint = selectedApi.endpoints?.[0]?.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '') || '/example';
  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    '  Two quick things before we wrap up the spec.',
  ]});

  const visibilityIndex = await singleSelect(
    [
      { label: 'External', hint: 'Public-facing, used by your API consumers.' },
      { label: 'Internal', hint: 'Private, only your own services or staff hit it.' },
    ],
    {
      message: `Is ${selectedApi.name} external or internal?`,
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
  if (finalOasFile === oasFile && !skipReason) {
    const oasFullPath = path.join(rootDir, oasFile);
    try {
      const oasContent = fs.readFileSync(oasFullPath, 'utf8');
      const updated = oasContent.replaceAll(placeholderDomain, domain || 'http://localhost:3000');
      safeWriteFileSync(oasFullPath, updated);
    } catch {}
  }

  // Sub 2: Pick a test endpoint now, while the OAS is fresh in our hands.
  // Step 3 ("Test your setup") just reads `testCurl` off the API entry,
  // skipping a whole AI round-trip when the user is sitting at the prompt.
  // Picking a test endpoint is rolled into the Generate OAS file sub-step
  // since it's a small post-generation pick. We surface it via the spinner
  // so it doesn't disappear, but it's not a top-level sub.
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

  // Sub 2: Write to .restless/
  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
    dim('  Saving settings...'),
  ]});

  const settings = loadSettings(rootDir);
  upsertApi(settings, {
    name: selectedApi.name,
    rootDir: selectedApi.rootDir || '.',
    ...(finalOasFile && { oasFile: finalOasFile }),
    framework: selectedApi.framework,
    language: selectedApi.language?.toLowerCase(),
    baseUrl: domain || null,
    internal: isInternal,
    ...(testCurl && { testCurl }),
    lastSyncedAt: new Date().toISOString(),
  });

  // Generate a request ID prefix on the API entry (not top-level)
  const apiEntry = settings.apis.find(a => a.rootDir === (selectedApi.rootDir || '.'));
  if (apiEntry && !apiEntry.requestIdPrefix) {
    // Migrate from top-level if it exists
    if (settings.requestIdPrefix) {
      apiEntry.requestIdPrefix = settings.requestIdPrefix;
      delete settings.requestIdPrefix;
    } else {
      let projectName;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
        projectName = pkg.name;
      } catch {}
      if (!projectName) {
        projectName = path.basename(rootDir);
      }
      apiEntry.requestIdPrefix = generatePrefix(projectName);
    }
  }

  saveSettings(rootDir, settings);

  {
    const doneMsg = `  ${green('✓')} OpenAPI spec ready at ${bold(finalOasFile)}${isInternal ? dim(' (internal)') : ''}.`;
    update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [doneMsg] });
  }

  return {
    apis: [selectedApi],
    detectedLanguage: selectedApi.language?.toLowerCase() || null,
    detectedFramework: selectedApi.framework || null,
    apiRootDir: selectedApi.rootDir || '.',
    domain,
  };
}
