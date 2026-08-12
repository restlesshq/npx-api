/**
 * The language-independent half of the SDK setup surface.
 *
 * `spec/CONTRACT.md` in the Node SDK repo draws a deliberate line, and this
 * module is the CLI's copy of the "same everywhere" side of it:
 *
 *   §15 - the setup result. "Field *names* here are wire- and docs-facing and
 *   SHOULD be preserved across languages, adapted to local casing conventions
 *   (`api_key` in Python is fine; renaming the concept is not)."
 *
 *   §14 - everything else about a language's surface (method naming,
 *   construction, registration, adapters, .env handling, build-time
 *   integration) is explicitly non-normative and expected to differ.
 *
 * So: the *concepts* and the CLI policy built on them live here, and every
 * writer spells them its own way via its `descriptor`. A writer picks
 * spellings; it never invents concepts. Anything that needs a different word
 * per language belongs in the descriptor, not in this file.
 */

/**
 * The setup-result concepts a writer must be able to name (CONTRACT §15).
 * `descriptor.fields` supplies one spelling per entry.
 */
export const SETUP_CONCEPTS = Object.freeze(['apiKey', 'owner', 'ownerId', 'enrich']);

/**
 * What an installer writes for `owner.id` when it cannot find a stable
 * identifier, plus the marker comment that goes with it. SETUP-002 makes
 * owner.id permanent and immutable, so shipping a placeholder collapses every
 * customer into one fake owner - which is why the CLI blocks on it rather
 * than warning. The token is policy; how it gets quoted is per-language.
 */
export const OWNER_ID_PLACEHOLDER = 'NEEDS_CONFIGURATION';
export const OWNER_ID_TODO_MARKER = 'RESTLESS_OWNER_ID_TODO';

/**
 * Left by the verify-owner-id pass when it kept the AI's pick but wants the
 * user to confirm it. Written as a comment, so the leader is per-language
 * (`descriptor.commentPrefix`) while the marker itself is not.
 */
export const OWNER_ID_CONFIRM_MARKER = 'RESTLESS_OWNER_ID_CONFIRM';

/** Comment text accompanying an inline (literal) key in source. */
export const INLINE_KEY_TODO_TEXT = 'TODO: move this out of the codebase before committing';

/**
 * String-literal delimiters we may find an expression wrapped in. Longest
 * first so Python's triple quotes are stripped before its single ones.
 * Backticks cover JS template literals and Go raw strings.
 */
const QUOTE_DELIMITERS = ['"""', "'''", '"', "'", '`'];

/** Escape a literal string for embedding in a RegExp. */
export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a descriptor's path list as backtick-quoted prose, e.g.
 * ``​`node_modules/`, `.venv/` or `site-packages/`​``.
 *
 * Exists because two callers need the identical string - the `{{neverRead}}`
 * substitution in `lib/ai.js` and the playbook's `neverRead` line in
 * `lib/agent-plan.js` - and when they each built it themselves they
 * disagreed: the prompt path said `node_modules/` for Ruby and Go, so the
 * "never read the vendored dependency tree" instruction named a directory
 * those projects do not have.
 */
export function formatPathList(paths, conjunction = 'or') {
  const quoted = (paths || []).map((p) => `\`${p}\``);
  if (quoted.length === 0) return '';
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} ${conjunction} ${quoted[quoted.length - 1]}`;
}

/**
 * Strip one layer of matching string-literal quotes, in any language's style.
 * Returns the input trimmed but otherwise unchanged when it is not a simple
 * quoted literal (an identifier, a call, a member expression).
 */
export function unquoteLiteral(expr) {
  if (typeof expr !== 'string') return '';
  const trimmed = expr.trim();
  for (const q of QUOTE_DELIMITERS) {
    if (
      trimmed.length >= q.length * 2 &&
      trimmed.startsWith(q) &&
      trimmed.endsWith(q)
    ) {
      return trimmed.slice(q.length, -q.length);
    }
  }
  return trimmed;
}

/**
 * Is this owner.id expression the installer's "I couldn't find one"
 * placeholder? Quote-style agnostic, so a Python `"NEEDS_CONFIGURATION"`,
 * a Go backtick literal and a JS single-quoted one all read the same.
 */
export function isOwnerIdPlaceholder(expr) {
  return unquoteLiteral(expr) === OWNER_ID_PLACEHOLDER;
}

/**
 * Literal owner.id values that mean "I didn't have a real id, so I picked
 * something." Using one fake-groups every unauthenticated request under a
 * single tenant on the dashboard, hiding that they are actually anonymous.
 * The right signal for "no owner" is omitting the owner block; the SDK has
 * its own anonymous bucket on the wire-format side.
 *
 * Policy about what owner.id MEANS (SETUP-002), so it is identical in every
 * language.
 */
export const PLACEHOLDER_OWNER_IDS = new Set([
  'anonymous', 'none', 'unknown', 'guest', 'default', 'placeholder',
  'nobody', 'null', 'undefined', 'test', 'todo',
]);

/**
 * Field-name tails that indicate a MUTABLE identifier. SETUP-002 requires
 * owner.id to be permanent: an email or username that a user can change
 * silently splits their history into two owners.
 */
export const MUTABLE_TAIL_FIELDS = new Set([
  'email', 'username', 'name', 'displayname', 'display_name',
  'handle', 'slug', 'nickname', 'alias', 'login',
]);

/**
 * Tokens suggesting an owner.id expression is reading a CREDENTIAL rather
 * than an identity. SETUP-002 rules out API keys explicitly (they rotate).
 */
export const RISKY_CREDENTIAL_TOKENS = [
  'authorization', 'apikey', 'api_key', 'api-key', 'x-api-key',
  'x-auth', 'secret', 'token', 'password', 'bearer',
];
