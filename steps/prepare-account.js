import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, yellow, cyan, ask, askYesNo, singleSelect, waitForKey } from '../lib/ui.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { SITE_URL } from '../lib/config.js';
import { fatalError } from '../lib/errors.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';

/**
 * Resolve the directory that owns the detected API's `package.json`, so
 * `.env` lands next to the server that will read it. Mirrors the same
 * walk we do in install-sdk.js.
 */
export function resolveApiDir(packageDir, apiRootDir) {
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
 * Find a real `.env` (or `.env.local`) regular file inside `apiDir`.
 * `existsSync` alone matches symlinks and directories - we want a plain
 * file. Only checks `apiDir` itself, never escapes upward, so a `.env` in
 * a parent or grandparent directory is invisible to us.
 */
export function findExistingEnvFile(apiDir) {
  for (const name of ['.env', '.env.local']) {
    const p = path.join(apiDir, name);
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Read a `.env` file and return whether it already defines `RESTLESS_KEY`.
 * Minimal parser - just checks for a line starting with `RESTLESS_KEY=`.
 */
export function existingRestlessKey(envPath) {
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
 * --watch) will restart once - and that restart will already see
 * `RESTLESS_KEY` in `.env`.
 */
export default async function prepareAccount({ ctx, update, setSpinner }) {
  const { packageDir, rootDir, apiRootDir, apiDir } = ctx;
  const apiDirRel = path.relative(packageDir, apiDir) || '.';

  // Only treat .env / .env.local as "existing" if it's a real regular file
  // inside apiDir - never walk above. Avoids false positives from symlinks,
  // directories, or env files in parent repos.
  const existingEnvFile = findExistingEnvFile(apiDir);
  let envFile = existingEnvFile || path.join(apiDir, '.env');
  let envRelative = path.relative(packageDir, envFile);

  // Idempotency: if a pre-existing .env already has a RESTLESS_KEY, reuse it
  // and re-register with the backend using the same hash.
  const existingKey = existingEnvFile ? existingRestlessKey(envFile) : null;
  const apiKey = existingKey || 'rdme_' + crypto.randomBytes(32).toString('hex');
  const writeKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  update({ status: 'active', sub: { 0: 'done' }, activeSub: 1, message: [
    `  Generating a key for this project and registering it with Restless.`,
    dim('  The key goes in .env; we only send its hash to our server.'),
  ]});

  let projectId, setupKey;
  // Retry once on 500 / network failure - the metrics service cold-starts
  // and the first request often times out at the Vercel layer with a 500.
  // The second attempt almost always hits a warm container.
  async function callInit() {
    return fetch(`${SITE_URL}/api/projects/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write_key_hash: writeKeyHash }),
    });
  }

  setSpinner({ phase: 'Registering project', detail: `POST ${SITE_URL}/api/projects/init` });
  try {
    let res = await callInit();
    if (res.status >= 500) {
      setSpinner({ phase: 'Server warming up, retrying', detail: `POST ${SITE_URL}/api/projects/init` });
      await new Promise((r) => setTimeout(r, 2000));
      res = await callInit();
    }
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
    // projectId lives on the API entry (one Restless project per API) - not
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

  // Reusing a key that's already in .env - nothing more to do.
  if (existingKey) {
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${green('✓')} Using the ${bold('RESTLESS_KEY')} already in ${bold(envRelative)}.`,
    ]});
    return { apiKey, projectId, setupKey, envFile, envRelative, keyDelivery: 'env' };
  }

  const appendLine = `RESTLESS_KEY=${apiKey}`;
  const keyPreview = `${cyan(apiKey.slice(0, 8))}${dim('...')}${cyan(apiKey.slice(-4))}`;
  let keyDelivery; // 'env' | 'manual' | 'inline'

  // Build the option list. The first option differs based on whether we'd
  // be appending to an existing .env or creating a new one. The inline
  // option is always offered as an explicit testing-only escape hatch.
  const options = [
    existingEnvFile
      ? {
          label: `Append RESTLESS_KEY to ${envRelative}`,
          hint: 'We tack it onto the end of the file. Your other vars stay put.',
        }
      : {
          label: `Create ${envRelative}`,
          hint: 'A new .env at your project root with just RESTLESS_KEY in it.',
        },
    {
      label: 'Add the key inline',
      hint: 'Insecure, but good for testing. Move before committing.',
    },
    {
      label: "Give me the key and I'll set RESTLESS_KEY myself",
      hint: "We'll print the line so you can paste it wherever you load env vars.",
    },
  ];

  update({ status: 'active', sub: { 0: 'done' }, activeSub: 1, message: [
    `  We've generated your ${bold('RESTLESS_KEY')}: ${keyPreview}.`,
  ]});
  const choice = await singleSelect(options, {
    message: 'Where do you want it to be stored?',
    defaultIndex: 0,
  });

  let createdEnvFile = false;
  if (choice === 0) {
    if (existingEnvFile) {
      safeAppendFileSync(envFile, `\n${appendLine}\n`);
    } else {
      safeWriteFileSync(envFile, `${appendLine}\n`);
      createdEnvFile = true;
    }
    keyDelivery = 'env';
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      existingEnvFile
        ? `  ${green('✓')} Added ${bold('RESTLESS_KEY')} to ${bold(envRelative)}.`
        : `  ${green('✓')} Created ${bold(envRelative)} with ${bold('RESTLESS_KEY')}.`,
      ...(existingEnvFile ? [] : [dim(`  Make sure ${bold('.env')} is in your ${bold('.gitignore')} before committing.`)]),
      dim(`  If your server uses a file watcher (nodemon, tsx --watch, node --watch),`),
      dim(`  it'll restart automatically after we wire the middleware in.`),
    ]});
  } else if (choice === 1) {
    keyDelivery = 'inline';
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${yellow('⚠')} Inline mode: we'll embed the key directly in the SDK init line during the next sub-step.`,
      dim(`  Suitable for quick local testing only - don't commit this code.`),
    ]});
  } else {
    keyDelivery = 'manual';
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${bold('Set RESTLESS_KEY however your server reads env vars')}  ${yellow("- we won't show this key again:")}`,
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

  // Write through to the SetupContext - downstream steps read from here.
  ctx.apiKey = apiKey;
  ctx.projectId = projectId;
  ctx.setupKey = setupKey;
  ctx.envFile = envFile;
  ctx.envRelative = envRelative;
  ctx.keyDelivery = keyDelivery;
  ctx.createdEnvFile = createdEnvFile;

  return { apiKey, projectId, setupKey, envFile, envRelative, keyDelivery };
}
