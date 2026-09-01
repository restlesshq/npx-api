/**
 * Span timing on top of the always-on debug log.
 *
 * `init` is slow enough to be worth measuring but not slow in one obvious
 * place: a run is a mix of AI turns, package installs, tree greps, HTTP
 * round trips, deliberate typing animations, and long stretches of simply
 * waiting for the user to press a key. Wall clock alone can't tell those
 * apart, and "the CLI feels slow" is unactionable until it can.
 *
 * Every span is emitted as a `timing` entry into the same `debug.log`
 * stream the rest of the CLI writes to, which means:
 *
 *   - recording is always on (debug.js writes a local JSON copy of every
 *     run), so a run that turned out to be slow can be profiled after the
 *     fact instead of reproduced under a flag;
 *   - `lib/timings-report.js` renders from a debug log, so the live
 *     `--timings` report and `restless timings <file>` share one renderer.
 *
 * Cost is a `Date.now()` pair and one array push per span. Nothing here
 * is allowed to throw into the caller: a profiler that can break `init`
 * is worse than no profiler.
 */
import * as debug from './debug.js';

// Kinds exist so the report can answer "where did the time go" in terms a
// human can act on, rather than listing 200 labels. Keep this list short -
// a kind that never changes a decision isn't worth a row in the summary.
export const KINDS = {
  AI: 'ai',           // a model turn (the usual suspect)
  EXEC: 'exec',       // a child process: npm/pip/gem install, grep, git
  NET: 'net',         // an HTTP round trip to the app
  SCAN: 'scan',       // in-process filesystem work (tree walks, endpoint parse)
  WAIT: 'wait',       // blocked on the user - not our slowness
  ANIM: 'anim',       // deliberate animation delay - our slowness, on purpose
  STEP: 'step',       // container: a plan step
  SUBSTEP: 'substep', // container: a plan sub-item
};

const CONTAINER_KINDS = new Set([KINDS.STEP, KINDS.SUBSTEP]);

export function isContainerKind(kind) {
  return CONTAINER_KINDS.has(kind);
}

const state = {
  seq: 0,
  // Open spans, innermost last. Used only to pick a parent at open time.
  open: [],
};

/**
 * Open a span. Returns the function that closes it.
 *
 * Parenting is resolved when the span opens, not when it closes, and
 * closing removes the span by identity rather than popping the stack.
 * That matters because a few spans genuinely overlap - `pollForLandedLog`
 * runs while the UI is blocked in `waitForKey` - and a strict stack would
 * mis-parent or corrupt on the first interleave.
 *
 * `background: true` marks a span that was started to run ALONGSIDE the
 * caller rather than inside it. Such a span still gets a parent of its own,
 * but it never becomes the parent of anything started later.
 *
 * Without that distinction, "innermost open span" degenerates into "most
 * recently opened span", which is wrong the moment two things overlap. It
 * produced a genuinely impossible tree in a measured run: the wiring review
 * was kicked off in the background, stayed open, and so adopted the 15s
 * owner.id pass as a child of a 5.5s parent. Node's `AsyncLocalStorage`
 * would resolve this properly, but it needs a callback scope to run inside,
 * and the plan's step spans deliberately open in one call and close in
 * another - so the flag is the honest fit for this shape.
 *
 * The returned closer is idempotent, so a `finally` that also runs on the
 * error path can't double-count.
 */
export function start(label, { kind = KINDS.SCAN, background = false, ...meta } = {}) {
  // Innermost span that is eligible to be a parent, skipping background ones.
  let parentId = null;
  for (let i = state.open.length - 1; i >= 0; i--) {
    if (!state.open[i].background) { parentId = state.open[i].id; break; }
  }

  const span = {
    id: ++state.seq,
    parentId,
    label: String(label || 'anonymous'),
    kind,
    background,
    startedAt: Date.now(),
  };
  state.open.push(span);

  let closed = false;
  return function end(extra) {
    if (closed) return 0;
    closed = true;
    const i = state.open.indexOf(span);
    if (i !== -1) state.open.splice(i, 1);
    const durationMs = Date.now() - span.startedAt;
    debug.log('timing', {
      span: span.id,
      parent: span.parentId,
      label: span.label,
      kind: span.kind,
      durationMs,
      ...meta,
      ...(extra && typeof extra === 'object' ? extra : {}),
    });
    return durationMs;
  };
}

/**
 * Time an async function. The span closes on both the resolve and the
 * throw path, and the rejection is re-thrown untouched - measuring a call
 * must never change whether it fails.
 */
export async function measure(label, fn, opts) {
  const end = start(label, opts);
  try {
    return await fn();
  } finally {
    end();
  }
}

/** The synchronous twin, for `execSync` / tree-walk call sites. */
export function measureSync(label, fn, opts) {
  const end = start(label, opts);
  try {
    return fn();
  } finally {
    end();
  }
}

/**
 * Time a stretch of blocking-on-the-user. Separate from `measure` only so
 * call sites read as what they are: this time is not a performance problem
 * and the report has to be able to say so.
 */
export function measureWait(label, fn) {
  return measure(label, fn, { kind: KINDS.WAIT });
}

/**
 * Close every still-open span. Called from the exit path so a run that
 * ended mid-span (a fatal error, a ctrl-c) still reports what it was in
 * rather than dropping the longest span on the floor.
 */
export function closeOpenSpans(reason = 'interrupted') {
  // Copy first: each close mutates `state.open`.
  for (const span of [...state.open]) {
    const i = state.open.indexOf(span);
    if (i !== -1) state.open.splice(i, 1);
    debug.log('timing', {
      span: span.id,
      parent: span.parentId,
      label: span.label,
      kind: span.kind,
      durationMs: Date.now() - span.startedAt,
      incomplete: reason,
    });
  }
}

/** Test seam: forget all span state between cases. */
export function reset() {
  state.seq = 0;
  state.open = [];
}

// Flush open spans on every exit path, including the ones that don't run
// through `flushAndExit` (uncaughtException, beforeExit). Registered here
// rather than called from debug.js so the dependency stays one-way.
debug.addFinalizeHook(() => closeOpenSpans('run-ended'));
