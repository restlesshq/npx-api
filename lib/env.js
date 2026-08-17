// Central detection for how the CLI is being driven: a human at a real
// terminal, or unattended inside a coding agent / CI / a pipe. Everything
// interactive (raw-mode prompts, animations, full-screen redraws) keys off
// `isInteractive()` so we never block waiting for a keypress that will
// never come.

let cachedAgent;

/**
 * A well-formed agent name. Mirrors the server's check in
 * `app/src/lib/setupProvenance.ts` (`AGENT_SLUG`) so we never report a
 * name the dashboard will throw away - if you widen one, widen both.
 */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Spellings that would otherwise fragment the data. Someone setting
 * RESTLESS_AGENT by hand writes "Claude Code" as often as "claude", and two
 * slugs for one agent makes every count wrong.
 */
const AGENT_ALIASES = {
  'claude-code': 'claude',
  'claudecode': 'claude',
  'anthropic': 'claude',
  'codex-cli': 'codex',
  'openai-codex': 'codex',
  'openai': 'codex',
};

/** Normalize a self-reported name, or null if it isn't one. */
function normalizeAgentName(raw) {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!AGENT_NAME.test(slug)) return null;
  return AGENT_ALIASES[slug] || slug;
}

/** `--agent <name>` / `--agent=<name>`, wherever it sits in argv. */
function agentFlag() {
  const argv = process.argv;
  const i = argv.indexOf('--agent');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--agent='));
  return eq ? eq.slice('--agent='.length) : null;
}

/**
 * Which coding agent, BY NAME, is driving this run.
 *
 *   'claude'  - Claude Code, which exports CLAUDECODE=1 to child processes.
 *   'codex'   - the OpenAI Codex CLI, which runs shell commands inside a
 *               sandbox that exports CODEX_SANDBOX / CODEX_SANDBOX_NETWORK_DISABLED.
 *   <slug>    - whatever an agent called itself via RESTLESS_AGENT=<name>
 *               or `--agent <name>`.
 *   null      - no agent named itself and none of our markers matched. That
 *               is NOT the same as "no agent" (see isAgent): an agent we
 *               can't identify still gets treated as one, it just has no
 *               name to report.
 *
 * A self-reported name WINS over the env markers. Both are explicit, but
 * this one was set for us on purpose, and it's the only way out when the
 * inference is wrong (an agent shelling out from inside another agent's
 * session inherits that session's markers).
 *
 * Cached on first read - the environment doesn't change mid-run.
 */
export function detectAgent() {
  if (cachedAgent !== undefined) return cachedAgent;
  const env = process.env;
  const named = normalizeAgentName(env.RESTLESS_AGENT) || normalizeAgentName(agentFlag());
  if (named) cachedAgent = named;
  else if (env.CLAUDECODE === '1' || env.CLAUDE_CODE === '1') cachedAgent = 'claude';
  else if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) cachedAgent = 'codex';
  else cachedAgent = null;
  return cachedAgent;
}

/**
 * True when both of our streams are pipes: something is capturing our
 * output and feeding us no input. That is what an agent's shell tool looks
 * like, and a human never runs setup that way - `| tee log.txt` keeps stdin
 * on the terminal, `< /dev/null` keeps stdout on it. Requiring BOTH is what
 * keeps those two out.
 *
 * CI is excluded deliberately: it is automation, but nobody's agent invoked
 * it, and calling a pipeline run "agent-driven" would poison the numbers.
 * RESTLESS_INTERACTIVE is the manual override, same as everywhere else.
 *
 * Read at call time (not cached), matching isInteractive.
 */
function isPipedRun() {
  const env = process.env;
  if (env.RESTLESS_INTERACTIVE === '1') return false;
  if (env.CI) return false;
  return !process.stdout.isTTY && !process.stdin.isTTY;
}

/**
 * True when something other than a human at a terminal is driving this run.
 *
 * Wider than `detectAgent() !== null` on purpose. Only two agents export a
 * marker we know, and new ones ship constantly - so an unrecognized agent
 * used to fall through to the human path, where the CLI would spawn its OWN
 * model to edit the caller's repo from inside a child process. That is
 * exactly the black box `lib/agent-plan.js` exists to avoid, and it happened
 * silently. A piped run gets the playbook instead.
 */
export function isAgent() {
  return detectAgent() !== null || isPipedRun();
}

/**
 * How this run was started, as reported to the server when a project is
 * registered:
 *
 *   'agent' - a coding agent spawned the CLI ("set this up with npx restless init").
 *   'cli'   - a human ran it themselves in their own terminal.
 *
 * Keyed off `isAgent()` rather than `isInteractive()`: CI is non-interactive
 * but nobody's agent invoked it, and `init --self-drive` inside an agent is
 * still an agent-invoked run even though the CLI drives the setup from there.
 *
 * Note this is independent of `detectAgent()`. An agent-invoked run with no
 * identifiable agent reports 'agent' with no name, which is the honest
 * answer - not 'cli'.
 */
export function invocationSource() {
  return isAgent() ? 'agent' : 'cli';
}

/**
 * How to address the agent driving this run, in prose. Falls back to "your
 * agent" rather than guessing a vendor: the playbook is addressed to whoever
 * is reading it, and naming the wrong tool reads as a bug.
 */
export function agentLabel(agent = detectAgent()) {
  if (!agent) return 'your agent';
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return agent
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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
