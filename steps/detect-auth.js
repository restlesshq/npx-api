import { runAI, loadPrompt } from '../lib/ai.js';
import { loadSettings, saveSettings, upsertApi } from '../lib/settings.js';
import { bold, dim, green } from '../lib/ui.js';

/**
 * Scan the project for custom auth mechanisms (headers, query params, body
 * fields) not already covered by the SDK's built-in redaction defaults, and
 * write them to `.api/settings.json` under `apis[].redact`.
 *
 * The Restless SDK reads this block at startup and merges it with its
 * defaults — so anything detected here gets automatically redacted from
 * captured request logs.
 */
export default async function detectAuth({ packageDir, rootDir, apiId, apiName, oasFile, update, setSpinner, subIndex = 0, prevSubs = {} }) {
  update({ status: 'active', activeSub: subIndex, sub: prevSubs, message: [
    `  Scanning ${bold(apiName)} for custom auth mechanisms so we can redact them from logs.`,
    dim('  Looking at the OpenAPI spec + how the code reads credentials.'),
  ]});

  const prompt = loadPrompt('detect-auth', {
    rootDir: rootDir || '.',
    oasFile: oasFile || '(none)',
  });

  let detected = { headers: [], queryParams: [], bodyKeys: [] };
  try {
    const result = await runAI(prompt, packageDir, { setSpinner });
    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      detected = {
        headers: Array.isArray(parsed.headers) ? parsed.headers : [],
        queryParams: Array.isArray(parsed.queryParams) ? parsed.queryParams : [],
        bodyKeys: Array.isArray(parsed.bodyKeys) ? parsed.bodyKeys : [],
      };
    }
  } catch (err) {
    update({ sub: { ...prevSubs, [subIndex]: 'done' }, message: [
      `  ${dim(`Could not auto-detect auth fields — the SDK's built-in redaction will still apply.`)}`,
      `  ${dim(`You can add custom fields by hand in .api/settings.json → apis[].redact.`)}`,
    ]});
    return { redact: null };
  }

  // If nothing custom, the defaults already have it
  const nothingCustom =
    detected.headers.length === 0 &&
    detected.queryParams.length === 0 &&
    detected.bodyKeys.length === 0;

  if (nothingCustom) {
    update({ sub: { ...prevSubs, [subIndex]: 'done' }, message: [
      `  ${green('✓')} No custom auth fields found. The SDK's built-in redaction covers this API.`,
    ]});
    return { redact: null };
  }

  // Write to settings
  const settings = loadSettings(packageDir);
  upsertApi(settings, { id: apiId, redact: detected });
  saveSettings(packageDir, settings);

  const summary = [];
  if (detected.headers.length) summary.push(`${detected.headers.length} header${detected.headers.length > 1 ? 's' : ''}`);
  if (detected.queryParams.length) summary.push(`${detected.queryParams.length} query param${detected.queryParams.length > 1 ? 's' : ''}`);
  if (detected.bodyKeys.length) summary.push(`${detected.bodyKeys.length} body field${detected.bodyKeys.length > 1 ? 's' : ''}`);

  update({ sub: { ...prevSubs, [subIndex]: 'done' }, message: [
    `  ${green('✓')} Flagged ${summary.join(', ')} for redaction.`,
    dim(`    ${[...detected.headers, ...detected.queryParams, ...detected.bodyKeys].join(', ')}`),
  ]});

  return { redact: detected };
}
