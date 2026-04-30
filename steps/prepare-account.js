import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, yellow, cyan, ask, askYesNo, waitForKey } from '../lib/ui.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { SITE_URL } from '../lib/config.js';
import { fatalError } from '../lib/errors.js';

/**
 * Resolve the directory that owns the detected API's `package.json`, so
 * `.env` lands next to the server that will read it. Mirrors the same
 * walk we do in install-sdk.js.
 */
function resolveApiDir(packageDir, apiRootDir) {
  if (!apiRootDir || apiRootDir === '.') return packageDir;
  let dir = path.resolve(packageDir, apiRootDir);
  const stop = path.resolve(packageDir);
  while (dir.startsWith(stop)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageDir;
}

/**
 * Read a `.env` file and return whether it already defines `RESTLESS_KEY`.
 * Minimal parser — just checks for a line starting with `RESTLESS_KEY=`.
 */
function existingRestlessKey(envPath) {
  if (!fs.existsSync(envPath)) return null;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^(?:export\s+)?RESTLESS_KEY\s*=\s*(.*)$/m);
    if (!match) return null;
    let val = match[1].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val || null;
  } catch {
    return null;
  }
}

/**
 * Sub 0 of Step 2. Generates the project's write key, registers the
 * project with the metrics/site backend, and writes `RESTLESS_KEY` to
 * `.env`. The OAS upload is deferred to step 4 (Set up account → Upload
 * specs) so failures land on a step that mentions OAS.
 *
 * Running this BEFORE the SDK install means: when the install step edits
 * the server source file, auto-restarters (nodemon, tsx --watch, node
 * --watch) will restart once — and that restart will already see
 * `RESTLESS_KEY` in `.env`.
 */
export default async function prepareAccount({
  packageDir,
  rootDir,
  apiRootDir,
  update,
  setSpinner,
}) {
  const apiDir = resolveApiDir(packageDir, apiRootDir);
  const apiDirRel = path.relative(packageDir, apiDir) || '.';

  // Prefer an existing .env, fall back to .env.local, else create a new .env.
  const envCandidates = ['.env', '.env.local'].map((f) => path.join(apiDir, f));
  let envFile = envCandidates.find((f) => fs.existsSync(f));
  if (!envFile) envFile = path.join(apiDir, '.env');
  const envRelative = path.relative(packageDir, envFile);

  // Idempotency: if the file already has a RESTLESS_KEY, reuse it and
  // re-register with the backend using the same hash.
  const existingKey = existingRestlessKey(envFile);
  const apiKey = existingKey || 'rdme_' + crypto.randomBytes(32).toString('hex');
  const writeKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  update({ status: 'active', activeSub: 0, message: [
    `  Generating a key for this project and registering it with Restless.`,
    dim('  The key goes in .env; we only send its hash to our server.'),
  ]});

  let projectId, setupKey;
  setSpinner('Registering project');
  try {
    const res = await fetch(`${SITE_URL}/api/projects/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write_key_hash: writeKeyHash }),
    });
    if (!res.ok) {
      const text = await res.text();
      setSpinner('');
      fatalError(`Failed to initialize project (HTTP ${res.status}).`, [
        text && text.slice(0, 200),
        `Endpoint: ${SITE_URL}/api/projects/init`,
      ].filter(Boolean));
    }
    const data = await res.json();
    projectId = data.project_id;
    setupKey = data.setup_key;
    const regSettings = loadSettings(rootDir);
    // projectId lives on the API entry (one Restless project per API) — not
    // at the root. Match by rootDir; fall back to the first API if no match
    // is found (typical single-API setup).
    const apiRootKey = apiRootDir || '.';
    const target =
      regSettings.apis.find((a) => (a.rootDir || '.') === apiRootKey) ||
      regSettings.apis[0];
    if (target) {
      target.projectId = projectId;
    }
    saveSettings(rootDir, regSettings);
  } catch (err) {
    setSpinner('');
    fatalError(`Could not reach the site at ${SITE_URL}.`, [
      err?.message || String(err),
      'Is the server running?',
    ]);
  }

  setSpinner('');

  // Write the key to .env unless it's already there.
  if (existingKey) {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} Using the ${bold('RESTLESS_KEY')} already in ${bold(envRelative)}.`,
    ]});
    return { apiKey, projectId, setupKey, envFile, envRelative };
  }

  const appendLine = `RESTLESS_KEY=${apiKey}`;
  const keyPreview = `${cyan(apiKey.slice(0, 8))}${dim('...')}${cyan(apiKey.slice(-4))}`;

  update({ status: 'active', activeSub: 0, message: [
    `  Add ${bold('RESTLESS_KEY')} (${keyPreview}) to ${bold(envRelative)}?`,
    '',
    `  ${bold('y')} ${dim('append the line')}  ·  ${bold('n')} ${dim("I'll add it myself")}`,
  ]});

  const appended = await askYesNo('  ', { defaultValue: true });
  if (appended) {
    fs.appendFileSync(envFile, `\n${appendLine}\n`);
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} Added ${bold('RESTLESS_KEY')} to ${bold(envRelative)}.`,
      dim(`  If your server is running with a file watcher (nodemon, tsx --watch, node --watch),`),
      dim(`  it'll restart automatically once we wire the middleware in the next sub-step.`),
    ]});
  } else {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${bold('Add this line to')} ${bold(envRelative)}  ${yellow("— we won't show this key again:")}`,
      '',
      `    ${bold(appendLine)}`,
      '',
      dim(`  Restart your server after the next sub-step wires the middleware.`),
      '',
      `  ${dim('Press ENTER once you\'ve saved the key.')}`,
    ]});
    while (true) {
      const k = await waitForKey();
      if (k === '\r' || k === '\n') break;
    }
  }

  return { apiKey, projectId, setupKey, envFile, envRelative };
}
