// Central detection for how the CLI is being driven: a human at a real
// terminal, or unattended inside a coding agent / CI / a pipe. Everything
// interactive (raw-mode prompts, animations, full-screen redraws) keys off
// `isInteractive()` so we never block waiting for a keypress that will
// never come.

let cachedAgent;

/**
 * Which coding agent, if any, is driving this run.
 *
 *   'claude' - Claude Code, which exports CLAUDECODE=1 to child processes.
 *   'codex'  - the OpenAI Codex CLI, which runs shell commands inside a
 *              sandbox that exports CODEX_SANDBOX / CODEX_SANDBOX_NETWORK_DISABLED.
 *   null     - not an agent we recognize.
 *
 * Cached on first read - the environment doesn't change mid-run.
 */
export function detectAgent() {
  if (cachedAgent !== undefined) return cachedAgent;
  const env = process.env;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE === '1') cachedAgent = 'claude';
  else if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) cachedAgent = 'codex';
  else cachedAgent = null;
  return cachedAgent;
}

/** True when a coding agent (Claude Code / Codex) is driving this run. */
export function isAgent() {
  return detectAgent() !== null;
}

/**
 * True only when we can safely run raw-mode TTY prompts, animations, and
 * full-screen redraws. A coding agent, a CI job, or a piped stdin/stdout
 * all force the non-interactive path. Two escape hatches:
 *
 *   RESTLESS_INTERACTIVE=1     force interactive (local testing).
 *   RESTLESS_NONINTERACTIVE=1  force non-interactive.
 *
 * Read at call time (not cached) so a mid-run TTY change is honored.
 */
export function isInteractive() {
  const env = process.env;
  if (env.RESTLESS_INTERACTIVE === '1') return true;
  if (env.RESTLESS_NONINTERACTIVE === '1') return false;
  if (isAgent()) return false;
  if (env.CI) return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
