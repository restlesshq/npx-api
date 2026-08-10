import { execSync } from 'child_process';
import { OWNER_ID_PLACEHOLDER, OWNER_ID_TODO_MARKER } from './sdk-writers/contract.js';

/**
 * Recursive grep for `@restlessai/sdk` references inside an install dir,
 * tuned to NOT scan heavyweight directories. The execSync call blocks
 * the event loop while it runs - if we let it recurse into a populated
 * `node_modules/` (hundreds of MB on a typical Fastify / Next project),
 * the CLI sits frozen for tens of seconds with no spinner update, no
 * cursor, no message. Past incident: users reported the Configure SDK
 * step "got stuck" on first install; root cause was this grep walking
 * node_modules synchronously between prepareAccount returning and the
 * "Wiring SDK..." update firing.
 *
 * Adding `--exclude-dir` at the grep level (not as a post-filter) is the
 * difference between "instant" and "wait, why is this frozen." A
 * post-grep `.filter((f) => !f.includes('node_modules'))` is correctness
 * theater - the cost was already paid by the time we filter.
 *
 * Also drops noisy build artifact dirs (`dist`, `build`, `.next`,
 * `coverage`) and the `.restless/` working dir. Returns relative paths
 * sorted in grep's natural order; an empty array when nothing matches
 * or grep itself fails.
 */
const EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.restless',
];

const INCLUDE_GLOBS = ['*.js', '*.ts', '*.mjs', '*.cjs'];

/**
 * Single-quote a string for the shell, the only quoting that is safe for an
 * arbitrary regex.
 *
 * The patterns are per-language now, and Ruby's has to match `require
 * "restless"` - so it contains a double quote, which silently terminated the
 * double-quoted shell string and turned the whole grep into nonsense. It
 * failed by finding nothing, which reads exactly like "the SDK isn't wired".
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Shared runner so every grep here keeps the same exclude tuning. */
function grepFilesMatching(pattern, dir, globs = INCLUDE_GLOBS) {
  const includes = globs.map((g) => `--include=${shellQuote(g)}`).join(' ');
  const excludes = EXCLUDED_DIRS.map((d) => `--exclude-dir=${d}`).join(' ');
  try {
    const out = execSync(
      `grep -rE ${shellQuote(pattern)} ${includes} ${excludes} -l . 2>/dev/null || true`,
      { cwd: dir, encoding: 'utf8' },
    );
    return out.trim().split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

/**
 * Files mentioning the SDK package.
 *
 * `pattern` and `globs` are parameters because both are per-language: the
 * import specifier differs (`@restlessai/sdk`, `restless`,
 * `github.com/restlesshq/go`) and so do the source extensions. Defaults
 * reproduce the JavaScript behaviour exactly, so callers that pass nothing
 * are unaffected.
 */
export function findSdkReferences(installDir, { pattern = '@restlessai/sdk', globs } = {}) {
  return grepFilesMatching(pattern, installDir, globs);
}

/**
 * Files still carrying the owner-id placeholder the SDK guide tells
 * installers to leave when no stable id exists (`'NEEDS_CONFIGURATION'` +
 * the `RESTLESS_OWNER_ID_TODO` marker comment). The guide promises "the
 * CLI greps for them and asks the user" - the guided flow keeps that
 * promise in final-checks, and `api verify` keeps it for the agent flow
 * with this. Same include/exclude tuning as above, for the same
 * frozen-grep reasons.
 */
export function findOwnerIdPlaceholders(dir, { globs } = {}) {
  // Both tokens are language-independent policy from `sdk-writers/contract.js`;
  // only which files to look in varies, hence `globs`.
  return grepFilesMatching(
    `${OWNER_ID_PLACEHOLDER}|${OWNER_ID_TODO_MARKER}`,
    dir,
    globs,
  );
}
