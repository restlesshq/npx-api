import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Override for local dev with `RESTLESS_SITE_URL=http://localhost:4099 npx api init`.
export const SITE_URL = process.env.RESTLESS_SITE_URL || 'https://app.restless.ai';
export const CALENDLY_URL = 'https://calendly.com/restlessai/30min';

// How the user invoked us (e.g. "api", "api-beta"), derived from argv[1] so output
// matches whatever bin name shipped - no hardcoding the package name in user-facing strings.
export const CLI_NAME = path.basename(process.argv[1] || '', '.js') || 'api';

// The CLI's own install root, resolved from this file (not cwd) so it reflects
// where the running CLI actually lives, wherever the user invoked it from.
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * True when the CLI is running from a local checkout or an `npm link`ed copy
 * rather than a published, installed package.
 *
 * Published installs - an `npx` cache, a global `npm i -g`, or a project
 * dependency - all live under a `node_modules` directory. A checkout run
 * directly (`node bin/api.js`) or symlinked in via `npm link` does not, and
 * ships the repo's `.git` alongside it (which `npm link`'s symlink target
 * still exposes even under `--preserve-symlinks`). Either signal marks a
 * local, linked run.
 *
 * `RESTLESS_LINKED=1|0` forces the answer, for tests and manual overrides.
 */
function detectLinkedInstall() {
  const forced = process.env.RESTLESS_LINKED;
  if (forced === '1') return true;
  if (forced === '0') return false;
  const underNodeModules = /[\\/]node_modules[\\/]/.test(PKG_ROOT);
  let hasGit = false;
  try {
    hasGit = fs.existsSync(path.join(PKG_ROOT, '.git'));
  } catch {}
  return !underNodeModules || hasGit;
}

export const IS_LINKED_INSTALL = detectLinkedInstall();
