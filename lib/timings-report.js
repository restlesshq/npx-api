/**
 * Render a timing report from a debug log.
 *
 * Input is the `{ meta, entries }` shape debug.js writes to disk and
 * returns from `snapshot()`, so the live `--timings` report and
 * `restless timings <file>` are the same code reading the same events.
 *
 * The report answers three questions, in the order you actually ask them:
 *
 *   1. Where did the wall clock go, by category? Waiting on the user is
 *      broken out because it dominates an interactive run and is not a
 *      performance problem - a summary that lumps it in with AI time
 *      points you at the wrong thing.
 *   2. Which plan step was slow?
 *   3. Which individual operations were slow, and how often did they run?
 *
 * Self time (a span's duration minus its direct children's) is what the
 * category rollup sums, which is why nesting can't double-count and why
 * "Unaccounted" is meaningful rather than an artifact.
 */
import { dim, bold, cyan, white, brand, green, yellow, muted } from './ui.js';
import { KINDS, isContainerKind } from './timings.js';

// Ordered for the summary table: the categories most likely to be the
// answer come first, and the two "not really our latency" rows sit at the
// bottom next to Unaccounted.
const KIND_LABELS = [
  [KINDS.AI, 'AI turns'],
  [KINDS.EXEC, 'Subprocesses'],
  [KINDS.NET, 'Network'],
  [KINDS.SCAN, 'File scans'],
  [KINDS.ANIM, 'Animation'],
  [KINDS.WAIT, 'Waiting on you'],
];

export function formatMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function pct(part, whole) {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

function bar(part, whole, width = 22) {
  if (!whole || part <= 0) return '';
  const filled = Math.max(1, Math.round((part / whole) * width));
  return '█'.repeat(Math.min(filled, width));
}

/**
 * Merge a list of `[start, end]` pairs into a sorted, non-overlapping set.
 *
 * Everything about attributing time correctly comes down to this: two spans
 * that overlap occupy less wall clock than their durations add up to.
 */
export function unionIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `a` minus `b`, both given as interval lists. */
export function subtractIntervals(a, b) {
  const holes = unionIntervals(b);
  let out = unionIntervals(a);
  for (const [hs, he] of holes) {
    const next = [];
    for (const [s, e] of out) {
      if (he <= s || hs >= e) { next.push([s, e]); continue; } // no overlap
      if (hs > s) next.push([s, hs]);                          // piece before
      if (he < e) next.push([he, e]);                          // piece after
    }
    out = next;
  }
  return out;
}

export function intervalLength(intervals) {
  return intervals.reduce((n, [a, b]) => n + (b - a), 0);
}

/**
 * Collect `timing` entries into spans and attach each to its parent.
 *
 * A span whose recorded parent isn't in the log is treated as a root
 * rather than dropped. That happens for real: an interrupted run flushes
 * its open spans in whatever order they were opened, and a truncated or
 * hand-edited log can be missing anything.
 */
export function buildSpans(entries) {
  const spans = [];
  for (const e of entries) {
    if (e.type !== 'timing' || typeof e.durationMs !== 'number') continue;
    spans.push({
      id: e.span,
      parentId: e.parent ?? null,
      label: e.label || 'anonymous',
      kind: e.kind || KINDS.SCAN,
      durationMs: e.durationMs,
      incomplete: e.incomplete || null,
      endedAt: e.at,
      startedAt: e.at - e.durationMs,
      children: [],
    });
  }

  const byId = new Map(spans.map((s) => [s.id, s]));
  const roots = [];
  for (const s of spans) {
    const parent = s.parentId != null ? byId.get(s.parentId) : null;
    if (parent && parent !== s) parent.children.push(s);
    else roots.push(s);
  }

  // Self time, as INTERVALS rather than a subtraction.
  //
  // `duration - sum(children)` was wrong the moment anything ran
  // concurrently: `startWiringReview` deliberately overlaps the wiring
  // review with the owner.id pass, so their durations add up to more wall
  // clock than the parent actually occupied, and the parent's self time went
  // phantom (a measured run grew 9.4s of "Uninstrumented (in steps)" that
  // was never real). Subtracting the UNION of the children's intervals is
  // correct whether they overlap or not.
  for (const s of spans) {
    s.selfIntervals = subtractIntervals(
      [[s.startedAt, s.endedAt]],
      s.children.map((c) => [c.startedAt, c.endedAt]),
    );
    s.selfMs = intervalLength(s.selfIntervals);
  }

  return { spans, roots, byId };
}

/**
 * Total wall clock for the run. Prefers the event timeline (first to last
 * entry) over `meta.startedAt`, since the timeline is what the spans are
 * measured against and can't disagree with them.
 */
function totalWallMs({ meta, entries }) {
  const stamps = entries.map((e) => e.at).filter((n) => typeof n === 'number');
  if (stamps.length >= 2) return Math.max(...stamps) - Math.min(...stamps);
  const start = Date.parse(meta?.startedAt || '');
  const end = Date.parse(meta?.finishedAt || '');
  if (Number.isFinite(start) && Number.isFinite(end)) return end - start;
  return 0;
}

/**
 * Reduce a log to the numbers the report prints. Exported separately from
 * the rendering so `--timings=json` and the tests can consume it without
 * parsing ANSI out of a formatted table.
 */
export function summarize(log) {
  const { meta = {}, entries = [] } = log || {};
  const { spans, roots } = buildSpans(entries);
  const totalMs = totalWallMs({ meta, entries });

  // By category, on self time, rolled up as a UNION of intervals.
  //
  // Union rather than sum because two spans of the same kind can overlap
  // (the wiring review runs under the owner.id pass, and both are `ai`), and
  // charging a category twice for one millisecond of wall clock would let a
  // category exceed the run it happened in.
  //
  // Container kinds (step / substep) hold the time inside them that no span
  // claimed, which is exactly the "something in here isn't instrumented yet"
  // signal - so it's reported under its own name instead of being folded
  // into a real category.
  const intervalsByKind = new Map();
  const containerIntervals = [];
  for (const s of spans) {
    if (isContainerKind(s.kind)) {
      containerIntervals.push(...s.selfIntervals);
      continue;
    }
    if (!intervalsByKind.has(s.kind)) intervalsByKind.set(s.kind, []);
    intervalsByKind.get(s.kind).push(...s.selfIntervals);
  }

  const byKind = new Map(
    [...intervalsByKind.entries()].map(([kind, ivs]) => [kind, intervalLength(unionIntervals(ivs))]),
  );
  const containerSelfMs = intervalLength(unionIntervals(containerIntervals));

  // Every self interval, unioned. Self intervals are disjoint from their own
  // children by construction, so this is the wall clock some span actually
  // accounted for - which is what makes "unaccounted" meaningful and keeps
  // it from going negative.
  const accountedMs = intervalLength(unionIntervals([
    ...[...intervalsByKind.values()].flat(),
    ...containerIntervals,
  ]));

  // By label, so a cheap call made 40 times shows up next to one
  // expensive call. `totalMs` here is inclusive (what the caller waited
  // for), `selfMs` excludes nested spans.
  const byLabel = new Map();
  for (const s of spans) {
    if (isContainerKind(s.kind)) continue;
    const key = `${s.kind}:${s.label}`;
    const row = byLabel.get(key) || { kind: s.kind, label: s.label, count: 0, totalMs: 0, selfMs: 0 };
    row.count += 1;
    row.totalMs += s.durationMs;
    row.selfMs += s.selfMs;
    byLabel.set(key, row);
  }

  // The step tree comes from the span tree, not from the older
  // `step.start` / `step.done` events: same durations, but as spans they
  // already carry their children and their self time.
  const stepSpans = roots.filter((s) => s.kind === KINDS.STEP);

  return {
    command: meta.command || '',
    startedAt: meta.startedAt || null,
    totalMs,
    accountedMs,
    unaccountedMs: Math.max(0, totalMs - accountedMs),
    containerSelfMs,
    kinds: KIND_LABELS
      .map(([kind, label]) => ({ kind, label, ms: byKind.get(kind) || 0 }))
      .filter((k) => k.ms > 0),
    // Everything the run spent NOT waiting on a human and NOT animating.
    // This is the number to watch across runs; total wall clock moves with
    // how fast the user reads.
    //
    // Unioned for the same reason the per-kind totals are: summing would
    // double-charge any millisecond where two working spans overlapped.
    workingMs: intervalLength(unionIntervals([
      ...[...intervalsByKind.entries()]
        .filter(([kind]) => kind !== KINDS.WAIT && kind !== KINDS.ANIM)
        .flatMap(([, ivs]) => ivs),
      ...containerIntervals,
    ])),
    steps: stepSpans,
    operations: [...byLabel.values()].sort((a, b) => b.totalMs - a.totalMs),
    spanCount: spans.length,
  };
}

const KIND_COLOR = {
  [KINDS.AI]: brand,
  [KINDS.EXEC]: cyan,
  [KINDS.NET]: cyan,
  [KINDS.SCAN]: white,
  [KINDS.ANIM]: yellow,
  [KINDS.WAIT]: muted,
};

/**
 * Format the report as lines. Returns an array so the caller decides
 * where it goes - stderr for the live `--timings` run (stdout may be
 * mid-pipe), stdout for the standalone command.
 */
export function renderReport(log, { limit = 12, width = 80 } = {}) {
  const s = summarize(log);
  const out = [];
  const pad = (str, n) => String(str).padStart(n);

  out.push('');
  out.push(`  ${bold('Timings')} ${dim(`- ${s.command || 'run'}`)}`);
  out.push('');

  if (!s.spanCount) {
    out.push(`  ${dim('No timing spans in this log.')}`);
    out.push(`  ${dim('Only runs from a build with timing instrumentation record them.')}`);
    out.push('');
    return out;
  }

  out.push(`  ${dim('Wall clock')}   ${bold(formatMs(s.totalMs))}`);
  out.push(`  ${dim('Working')}      ${bold(formatMs(s.workingMs))}  ${dim(`${pct(s.workingMs, s.totalMs)} - excludes waiting on you and animation`)}`);
  out.push('');

  // ── Where the time went ────────────────────────────────────────────
  const rows = [
    ...s.kinds.map((k) => ({ label: k.label, ms: k.ms, color: KIND_COLOR[k.kind] || white })),
  ];
  if (s.containerSelfMs > 0) {
    rows.push({ label: 'Uninstrumented (in steps)', ms: s.containerSelfMs, color: dim });
  }
  if (s.unaccountedMs > 0) {
    rows.push({ label: 'Unaccounted (outside steps)', ms: s.unaccountedMs, color: dim });
  }
  rows.sort((a, b) => b.ms - a.ms);

  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  out.push(`  ${bold('Where the time went')}`);
  for (const r of rows) {
    out.push(
      `    ${r.color(r.label.padEnd(labelWidth))}  ${pad(formatMs(r.ms), 7)}  ${pad(pct(r.ms, s.totalMs), 4)}  ${dim(bar(r.ms, s.totalMs))}`,
    );
  }
  out.push('');

  // ── Per step ───────────────────────────────────────────────────────
  if (s.steps.length) {
    out.push(`  ${bold('Steps')}`);
    for (const step of s.steps) {
      out.push(`    ${white(step.label.padEnd(34))} ${pad(formatMs(step.durationMs), 7)}`);
      for (const sub of step.children) {
        // Only sub-items get a row here; an operation that ran directly
        // under a step (no substep around it) is already in the
        // operations table and would just make this list noisy.
        if (sub.kind !== KINDS.SUBSTEP) continue;
        out.push(`      ${dim('·')} ${dim(sub.label.padEnd(30))} ${pad(formatMs(sub.durationMs), 7)}`);
      }
    }
    out.push('');
  }

  // ── Slowest operations ─────────────────────────────────────────────
  const ops = s.operations.slice(0, limit);
  if (ops.length) {
    out.push(`  ${bold('Slowest operations')} ${dim('(total time, self time, times run)')}`);
    const opWidth = Math.min(
      Math.max(...ops.map((o) => o.label.length)),
      Math.max(24, width - 40),
    );
    for (const o of ops) {
      const color = KIND_COLOR[o.kind] || white;
      const label = o.label.length > opWidth ? `${o.label.slice(0, opWidth - 1)}…` : o.label;
      const self = o.selfMs === o.totalMs ? '' : ` ${dim(`self ${formatMs(o.selfMs)}`)}`;
      const runs = o.count > 1 ? ` ${dim(`× ${o.count}`)}` : '';
      out.push(`    ${pad(formatMs(o.totalMs), 7)}  ${color(label.padEnd(opWidth))}${runs}${self}`);
    }
    if (s.operations.length > ops.length) {
      out.push(`    ${dim(`… and ${s.operations.length - ops.length} more`)}`);
    }
    out.push('');
  }

  return out;
}

/** The machine-readable form, for diffing two runs. */
export function renderJson(log) {
  const s = summarize(log);
  return JSON.stringify(
    {
      command: s.command,
      startedAt: s.startedAt,
      totalMs: s.totalMs,
      workingMs: s.workingMs,
      unaccountedMs: s.unaccountedMs,
      containerSelfMs: s.containerSelfMs,
      kinds: s.kinds,
      steps: s.steps.map((step) => ({
        label: step.label,
        durationMs: step.durationMs,
        selfMs: step.selfMs,
        children: step.children.map((c) => ({
          label: c.label,
          kind: c.kind,
          durationMs: c.durationMs,
          selfMs: c.selfMs,
        })),
      })),
      operations: s.operations,
    },
    null,
    2,
  );
}
