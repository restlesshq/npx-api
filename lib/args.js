/**
 * Reading flags off argv.
 *
 * One implementation because a flag that means one thing to `register` and
 * another to `update` is a bug waiting to happen: both used to carry their own
 * copy of the same "is the next token a value or the next flag" logic.
 */

/**
 * Look up `--flag <value>`.
 *
 * Returns `{ present, value }` so a caller can tell the two failure modes
 * apart. `--base-url` with nothing after it is `{ present: true, value: null }`
 * - which is a mistake worth reporting, not the same thing as not passing the
 * flag at all. A flag is never allowed to swallow the next flag as its value.
 */
export function readFlag(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return { present: false, value: null };
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) return { present: true, value: null };
  return { present: true, value: next };
}

/**
 * The lenient form: the value, or null whether the flag was absent or empty.
 * Fine where a missing value can only mean "fall back to the default", which
 * is how the `register` / `verify` / `debug` flags read it.
 */
export function flagValue(argv, flag) {
  return readFlag(argv, flag).value;
}

/**
 * The first positional argument after the command, if it isn't a flag.
 *
 * `update --base-url https://x` must not read "--base-url" as a project id and
 * fail with "no API with that projectId".
 */
export function positionalArg(argv, index) {
  const val = argv[index];
  if (!val || val.startsWith('-')) return null;
  return val;
}
