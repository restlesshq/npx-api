import { execSync } from 'child_process';

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

export function findSdkReferences(installDir) {
  const includes = INCLUDE_GLOBS.map((g) => `--include="${g}"`).join(' ');
  const excludes = EXCLUDED_DIRS.map((d) => `--exclude-dir=${d}`).join(' ');
  try {
    const out = execSync(
      `grep -rE "@restlessai/sdk" ${includes} ${excludes} -l . 2>/dev/null || true`,
      { cwd: installDir, encoding: 'utf8' },
    );
    return out.trim().split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
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
export function findOwnerIdPlaceholders(dir) {
  const includes = INCLUDE_GLOBS.map((g) => `--include="${g}"`).join(' ');
  const excludes = EXCLUDED_DIRS.map((d) => `--exclude-dir=${d}`).join(' ');
  try {
    const out = execSync(
      `grep -rE "NEEDS_CONFIGURATION|RESTLESS_OWNER_ID_TODO" ${includes} ${excludes} -l . 2>/dev/null || true`,
      { cwd: dir, encoding: 'utf8' },
    );
    return out.trim().split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}
