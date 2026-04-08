import path from 'path';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, ask, singleSelect } from '../lib/ui.js';
import { loadSettings, saveSettings, upsertApi } from '../lib/settings.js';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default async function generateOas({ packageDir, rootDir, update, setSpinner }) {
  // Sub 0: Detect endpoints
  update({ status: 'active', activeSub: 0, message: [
    '  Let\'s take a look at your project and see what APIs you have.',
  ]});

  const detectResult = await runAI(loadPrompt('detect-endpoints'), packageDir, { setSpinner });

  let apis = [];
  try {
    const jsonMatch = detectResult.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      apis = parsed.apis || [];
    }
  } catch {}

  if (apis.length === 0) {
    update({ sub: { 0: 'done' }, activeSub: -1, message: [
      dim('  No APIs detected. Try running from your project root.'),
    ]});
    return { apis: [], detectedLanguage: null, detectedFramework: null, domain: null };
  }

  // Pick one API
  let selectedApi;
  if (apis.length === 1) {
    selectedApi = apis[0];
    const ep = selectedApi.endpoints?.length || 0;
    const internal = selectedApi.internalEndpoints?.length || 0;
    const lang = selectedApi.language ? ` (${selectedApi.language})` : '';
    const lines = [
      `  We found ${bold('1 API')} in your project — it's ${bold(selectedApi.framework || selectedApi.language)}${selectedApi.framework && selectedApi.language ? lang : ''} with ${bold(String(ep))} endpoints.`,
    ];
    if (selectedApi.rootDir && selectedApi.rootDir !== '.') {
      lines.push(`  ${dim(`Located in ${selectedApi.rootDir}`)}`);
    }
    if (internal > 0) {
      lines.push(`  ${dim(`${internal} endpoint${internal > 1 ? 's' : ''} look${internal === 1 ? 's' : ''} internal — we'll tag ${internal === 1 ? 'it' : 'them'} as such in the spec.`)}`);
    }
    update({ sub: { 0: 'done' }, activeSub: -1, message: lines });
  } else {
    update({ sub: { 0: 'done' }, activeSub: -1, message: [
      `  We found ${bold(String(apis.length))} APIs in your project. Let's set up one at a time.`,
    ]});

    const labels = apis.map(a => {
      const ep = a.endpoints?.length || 0;
      return `${a.name} — ${a.framework || a.language}, ${ep} endpoints`;
    });

    console.log('');
    const selectedIndex = await singleSelect(labels, {
      message: 'Which API do you want to set up?',
      defaultIndex: 0,
    });
    selectedApi = apis[selectedIndex];

    update({ sub: { 0: 'done' }, activeSub: -1, message: [
      `  Setting up ${bold(selectedApi.name)}.`,
    ]});
  }

  // Ask internal vs external
  // Guess internal vs external based on signals
  const nameLower = (selectedApi.name || '').toLowerCase();
  const frameworkLower = (selectedApi.framework || '').toLowerCase();
  const endpoints = (selectedApi.endpoints || []).map(e => e.toLowerCase());
  const allPaths = endpoints.join(' ');

  const internalSignals = [
    // Name signals
    nameLower.includes('internal'),
    nameLower.includes('admin'),
    nameLower.includes('private'),
    nameLower.includes('backoffice'),
    nameLower.includes('back-office'),
    // Microservice signals
    nameLower.includes('service'),
    nameLower.includes('worker'),
    nameLower.includes('queue'),
    nameLower.includes('consumer'),
    nameLower.includes('processor'),
    nameLower.includes('gateway') && !nameLower.includes('api gateway'),
    // Path signals — mostly RPC-style or infra endpoints
    allPaths.includes('/internal/'),
    allPaths.includes('/admin/'),
    allPaths.includes('/_/'),
    allPaths.includes('/rpc/'),
    allPaths.includes('/grpc'),
    // No versioned paths (external APIs usually have /v1/, /v2/)
    !allPaths.includes('/v1') && !allPaths.includes('/v2') && endpoints.length > 3,
    // Framework signals — things like gRPC, message queues
    frameworkLower.includes('grpc'),
    frameworkLower.includes('trpc'),
  ].filter(Boolean).length;

  const looksInternal = internalSignals >= 2;
  const recommendedIndex = looksInternal ? 1 : 0;
  const recommended = looksInternal ? 'internal' : 'external';

  update({ sub: { 0: 'done' }, activeSub: -1, message: [
    `  Is ${bold(selectedApi.name)} a public-facing API or an internal one?`,
    dim(`  We think it's ${bold(recommended)} based on the name.`),
  ]});

  console.log('');
  const visibilityIndex = await singleSelect(
    [
      `External — public-facing, for your API consumers`,
      `Internal — private, for internal use only`,
    ],
    {
      message: 'API visibility:',
      defaultIndex: recommendedIndex,
    }
  );
  const isInternal = visibilityIndex === 1;

  // Ask for the base URL
  const firstEndpoint = selectedApi.endpoints?.[0]?.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '') || '/example';
  update({ sub: { 0: 'done' }, activeSub: -1, message: [
    '  For the OpenAPI spec, we need to know the base URL of your API in production.',
    `  ${dim(`This is so we know that ${firstEndpoint} lives at <base_url>${firstEndpoint}.`)}`,
  ]});
  const domain = await ask(`\n  ${bold('Base URL:')} `);

  // Sub 1: Generate OAS file
  const ep = selectedApi.endpoints?.length || 0;
  update({ sub: { 0: 'done' }, activeSub: 1, message: [
    `  Now we'll generate an OpenAPI spec — this is a standard format that`,
    `  documents your API so tools and SDKs know how to talk to it.`,
    '',
    `  We're turning those ${bold(String(ep))} endpoints into a complete spec for ${bold(domain || 'http://localhost:3000')}.`,
  ]});

  const oasFile = '.api/openapi.yaml';
  const internalList = selectedApi.internalEndpoints?.length
    ? selectedApi.internalEndpoints.join(', ')
    : '';

  const vars = {
    name: selectedApi.name,
    domain: domain || 'http://localhost:3000',
    oasFile,
    framework: selectedApi.framework || '',
    existingOasFile: selectedApi.existingOasFile || '',
    frameworkCanGenerateOas: selectedApi.frameworkCanGenerateOas ? 'true' : '',
    internalEndpoints: internalList,
  };

  await runAI(loadPrompt('generate-oas', vars), packageDir, { setSpinner });

  // Sub 2: Write to .api/
  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
    dim('  Saving settings...'),
  ]});

  const settings = loadSettings(rootDir);
  upsertApi(settings, {
    name: selectedApi.name,
    rootDir: selectedApi.rootDir || '.',
    oasFile,
    framework: selectedApi.framework,
    language: selectedApi.language?.toLowerCase(),
    baseUrl: domain || null,
    internal: isInternal,
    lastSyncedAt: new Date().toISOString(),
  });
  saveSettings(rootDir, settings);

  update({ sub: { 0: 'done', 1: 'done', 2: 'done' }, status: 'done', message: [
    `  ${green('✓')} OpenAPI spec written to ${bold(oasFile)}${isInternal ? dim(' (internal)') : ''}.`,
  ]});

  return {
    apis: [selectedApi],
    detectedLanguage: selectedApi.language?.toLowerCase() || null,
    detectedFramework: selectedApi.framework || null,
    domain,
  };
}
