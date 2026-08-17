import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, yellow, cyan, ask, askYesNo, singleSelect, waitForKey } from '../lib/ui.js';
import { SITE_URL } from '../lib/config.js';
import { fatalError } from '../lib/errors.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';
import { generateWriteKey, ensureProject } from '../lib/project-init.js';
import * as debug from '../lib/debug.js';

/**
 * Find a real `.env` (or `.env.local`) regular file, searching from
 * `apiDir` up to `rootDir` (the repo / git root) inclusive. In a monorepo
 * the API code lives in e.g. `packages/api` but the `.env` is usually at
 * the repo root, so we walk up to find it - but never above `rootDir`.
 *
 * Returns the FIRST match walking up (the one closest to the API code).
 * This mirrors the SDK's own `findEnvFile` resolution at runtime (closest
 * `.env` to the process wins), so the file we write to is the same file
 * the SDK will load - avoiding a closer `.env` shadowing the one we chose.
 *
 * `existsSync` alone matches symlinks and directories - we want a plain
 * file. `rootDir` defaults to `apiDir`, preserving the single-dir behavior
 * (check only `apiDir`) when no root is supplied.
 */
export function findExistingEnvFile(apiDir, rootDir = apiDir) {
  const top = path.resolve(rootDir);
  let dir = path.resolve(apiDir);
  while (true) {
    for (const name of ['.env', '.env.local']) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
    if (dir === top) break;            // reached the repo-root bound
    const parent = path.dirname(dir);
    if (parent === dir) break;         // filesystem-root safety
    // Never step outside rootDir's subtree (handles apiDir not under rootDir).
    if (!(parent === top || parent.startsWith(top + path.sep))) break;
    dir = parent;
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
 * Swap the value of an existing `RESTLESS_KEY=` line in place, leaving
 * every other line untouched. Used when a key on disk turns out to be
 * unrecoverable (no project this machine knows about) and the fix is a
 * fresh key rather than re-registering the old one. Returns false when
 * the file has no RESTLESS_KEY line to replace.
 */
export function replaceRestlessKey(envPath, newKey) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    if (!/^(?:export\s+)?RESTLESS_KEY\s*=/m.test(content)) return false;
    const updated = content.replace(/^((?:export\s+)?RESTLESS_KEY\s*=\s*).*$/m, `$1${newKey}`);
    safeWriteFileSync(envPath, updated);
    return true;
  } catch {
    return false;
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

  // Look for an existing .env / .env.local from the API dir up to the repo
  // root (a monorepo usually keeps its .env at the root, not in
  // packages/<api>). Reuse it if found; otherwise create one next to the API
  // code. Bounded at rootDir so we never touch env files outside the repo.
  const existingEnvFile = findExistingEnvFile(apiDir, rootDir);
  let envFile = existingEnvFile || path.join(apiDir, '.env');
  let envRelative = path.relative(packageDir, envFile);

  // Idempotency: if a pre-existing .env already has a RESTLESS_KEY, reuse it -
  // `ensureProject` then keeps this repo on the project that key is already
  // registered against rather than minting another one.
  const existingKey = existingEnvFile ? existingRestlessKey(envFile) : null;
  const apiKey = existingKey || generateWriteKey();

  update({ status: 'active', sub: { 0: 'done' }, activeSub: 1, message: [
    `  Generating a key for this project and registering it with Restless.`,
    dim('  The key goes in .env; we only send its hash to our server.'),
  ]});

  let projectId, setupKey, reusedProject;
  setSpinner({ phase: 'Registering project', detail: `POST ${SITE_URL}/api/projects/init` });
  try {
    // Shared with `npx restless key`, so guided and agent-driven runs resolve the
    // project identically - including reusing this repo's existing project
    // when the key hasn't changed, instead of minting a fresh one per run and
    // leaving the previous project holding all the logs.
    //
    // `agent` is the one the user picked on the setup screen - the only place
    // that choice exists, since nothing in the environment says which agent a
    // terminal run decided to hand the work to.
    ({ projectId, setupKey, reused: reusedProject } = await ensureProject({
      rootDir,
      apiRootDir,
      apiKey,
      agent: ctx.agent,
    }));
  } catch (err) {
    setSpinner('');
    fatalError(`Couldn't register this project with ${SITE_URL}.`, [
      err?.message || String(err),
      `Endpoint: ${SITE_URL}/api/projects/init`,
    ].filter(Boolean));
  }
  debug.log('prepare-account.project', { projectId, reused: !!reusedProject });

  setSpinner('');

  // Reusing a key that's already in .env - nothing more to do.
  if (existingKey) {
    // Write back to ctx BEFORE returning. Earlier versions only set ctx
    // fields on the picker path below, which meant a re-run with an
    // existing .env left ctx.apiKey / projectId / setupKey at null and
    // every downstream step (install-sdk, test-setup, setup-account)
    // operated on a half-populated context. Easy bug to miss; very
    // visible downstream.
    ctx.apiKey = apiKey;
    ctx.projectId = projectId;
    ctx.setupKey = setupKey;
    ctx.envFile = envFile;
    ctx.envRelative = envRelative;
    ctx.keyDelivery = 'env';
    ctx.createdEnvFile = false;
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${green('✓')} Using the ${bold('RESTLESS_KEY')} already in ${bold(envRelative)}.`,
    ]});
    return { apiKey, projectId, setupKey, envFile, envRelative, keyDelivery: 'env' };
  }

  const appendLine = `RESTLESS_KEY=${apiKey}`;
  let keyDelivery; // 'env' | 'manual' | 'inline'

  // Build the option list. The first option differs based on whether we'd
  // be appending to an existing .env or creating a new one. The inline
  // option is offered as an explicit testing-only escape hatch - EXCEPT on
  // the Next.js plugin wiring (withRestless + restless.config), which has
  // no SDK init line in user code to inline a key into; the SDK reads
  // RESTLESS_KEY from the environment there. Offering inline would let the
  // user pick a delivery mode where the key ends up nowhere.
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
  const optionValues = ['env', 'inline', 'manual'];
  if (ctx.nextStyle === 'plugin') {
    options.splice(1, 1);
    optionValues.splice(1, 1);
  }

  // Full key on its own line. Truncating it to `rstlss_7...46f2` protected
  // nothing - it's the user's own screen, and their next decision is where
  // to put this value, which they can't do with an abbreviation.
  update({ status: 'active', sub: { 0: 'done' }, activeSub: 1, message: [
    `  We've generated your ${bold('RESTLESS_KEY')}:`,
    '',
    `  ${cyan(apiKey)}`,
    '',
    `  ${dim("Copy it somewhere safe - we won't show it again.")}`,
  ]});
  const choice = await singleSelect(options, {
    message: 'Where do you want it to be stored?',
    defaultIndex: 0,
  });

  let createdEnvFile = false;
  keyDelivery = optionValues[choice] || 'env';
  if (keyDelivery === 'env') {
    if (existingEnvFile) {
      safeAppendFileSync(envFile, `\n${appendLine}\n`);
    } else {
      safeWriteFileSync(envFile, `${appendLine}\n`);
      createdEnvFile = true;
    }
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      existingEnvFile
        ? `  ${green('✓')} Added ${bold('RESTLESS_KEY')} to ${bold(envRelative)}.`
        : `  ${green('✓')} Created ${bold(envRelative)} with ${bold('RESTLESS_KEY')}.`,
      ...(existingEnvFile ? [] : [dim(`  Make sure ${bold('.env')} is in your ${bold('.gitignore')} before committing.`)]),
      dim(`  If your server uses a file watcher (nodemon, tsx --watch, node --watch),`),
      dim(`  it'll restart automatically after we wire the middleware in.`),
    ]});
  } else if (keyDelivery === 'inline') {
    update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: [
      `  ${yellow('⚠')} Inline mode: we'll embed the key directly in the SDK init line during the next sub-step.`,
      dim(`  Suitable for quick local testing only - don't commit this code.`),
    ]});
  } else {
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
