/**
 * Merging independently-generated OpenAPI fragments into one spec.
 *
 * Spec generation is output-token-bound: after the exploration turns were
 * removed, a profiled `generate-oas` spent 104 of its 124 seconds inside a
 * single `Write` emitting the whole document at ~93 tokens/sec. Splitting the
 * API into groups and generating them concurrently is the only lever left on
 * that, because it is the only one that buys parallelism rather than fewer
 * tokens.
 *
 * The cost of that is this file. Each worker writes a self-contained fragment
 * and they have to be reconciled without the model's help.
 *
 * Conflict policy is deliberately simple - **first fragment wins, by name**:
 *
 *   - `paths`: unioned. Two fragments touching the same path have their
 *     methods merged; the same method twice keeps the first.
 *   - `components.*` (schemas, responses, parameters, securitySchemes, ...):
 *     unioned per section, by name, first wins.
 *   - `tags`: unioned by name.
 *
 * The alternative was rewriting `$ref`s to de-duplicate divergent
 * definitions of the same name, which is a lot of machinery for a document
 * that a model just invented. Groups are cut along resource lines, so their
 * own schemas (`Project`, `Task`) are naturally disjoint; what genuinely
 * collides is cross-cutting (`Error`, `Pagination`), where two near-identical
 * definitions make "keep the first" a small and reportable fidelity loss.
 *
 * Every collision is returned in `conflicts` so the caller can log them and
 * we can find out whether the assumption above actually holds in practice.
 */

/** Sections of `components` we merge by name. */
const COMPONENT_SECTIONS = [
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'securitySchemes',
  'links',
  'callbacks',
];

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Cheap structural comparison, for deciding whether a name collision is
 * benign (two fragments describing the same thing) or a real divergence
 * worth reporting. Key order is normalized so formatting differences don't
 * read as disagreement.
 */
function sameShape(a, b) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (isObject(v)) {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = norm(v[k]); return acc; }, {});
    }
    return v;
  };
  try {
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  } catch {
    return false;
  }
}

/**
 * Merge fragments onto a shell.
 *
 * `shell` supplies the document-level fields (`openapi`, `info`, `servers`)
 * that Node knows without asking a model. `fragments` is a list of
 * `{ key, spec }` - `key` names the group, for conflict reporting.
 *
 * Returns `{ spec, conflicts, stats }`. Never throws on a malformed
 * fragment: a fragment that isn't an object is recorded as skipped, because
 * losing one group's paths must be reported, not fatal.
 */
export function mergeSpecs(shell, fragments) {
  const spec = {
    ...shell,
    tags: Array.isArray(shell?.tags) ? [...shell.tags] : [],
    components: isObject(shell?.components) ? JSON.parse(JSON.stringify(shell.components)) : {},
    paths: isObject(shell?.paths) ? JSON.parse(JSON.stringify(shell.paths)) : {},
  };

  const conflicts = [];
  const skipped = [];
  // Which group first defined each name, so a conflict can name both sides.
  const owner = { paths: new Map(), components: new Map(), tags: new Map() };

  for (const { key, spec: part } of fragments) {
    if (!isObject(part)) {
      skipped.push({ key, reason: 'not an object' });
      continue;
    }

    // ── paths ──────────────────────────────────────────────────────────
    if (isObject(part.paths)) {
      for (const [p, item] of Object.entries(part.paths)) {
        if (!isObject(item)) continue;
        if (!spec.paths[p]) {
          spec.paths[p] = item;
          owner.paths.set(p, key);
          continue;
        }
        // Path already present: merge at the method level, which is the
        // normal case when two route files serve the same prefix.
        for (const [method, op] of Object.entries(item)) {
          const lower = method.toLowerCase();
          if (spec.paths[p][method] === undefined) {
            spec.paths[p][method] = op;
            continue;
          }
          if (HTTP_METHODS.has(lower) && !sameShape(spec.paths[p][method], op)) {
            conflicts.push({
              kind: 'operation',
              name: `${method.toUpperCase()} ${p}`,
              keptFrom: owner.paths.get(p) || 'shell',
              droppedFrom: key,
            });
          }
        }
      }
    }

    // ── components ─────────────────────────────────────────────────────
    if (isObject(part.components)) {
      for (const section of COMPONENT_SECTIONS) {
        const incoming = part.components[section];
        if (!isObject(incoming)) continue;
        spec.components[section] ??= {};
        for (const [name, def] of Object.entries(incoming)) {
          const id = `${section}.${name}`;
          if (spec.components[section][name] === undefined) {
            spec.components[section][name] = def;
            owner.components.set(id, key);
            continue;
          }
          if (!sameShape(spec.components[section][name], def)) {
            conflicts.push({
              kind: 'component',
              name: id,
              keptFrom: owner.components.get(id) || 'shell',
              droppedFrom: key,
            });
          }
        }
      }
    }

    // ── tags ───────────────────────────────────────────────────────────
    if (Array.isArray(part.tags)) {
      for (const tag of part.tags) {
        const name = isObject(tag) ? tag.name : tag;
        if (!name || owner.tags.has(name) || spec.tags.some((t) => (isObject(t) ? t.name : t) === name)) {
          continue;
        }
        spec.tags.push(tag);
        owner.tags.set(name, key);
      }
    }

    // ── security ───────────────────────────────────────────────────────
    // Document-level `security` is a shell concern, but if the shell didn't
    // set one and a fragment did, take it rather than lose the requirement.
    if (!spec.security && Array.isArray(part.security)) spec.security = part.security;
  }

  // An empty `tags` array is noise in the committed file.
  if (!spec.tags.length) delete spec.tags;

  return {
    spec,
    conflicts,
    stats: {
      fragments: fragments.length,
      skipped,
      paths: Object.keys(spec.paths).length,
      operations: countOperations(spec),
    },
  };
}

export function countOperations(spec) {
  let n = 0;
  for (const item of Object.values(spec?.paths || {})) {
    if (!isObject(item)) continue;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) n++;
    }
  }
  return n;
}

/**
 * Split route files into groups to generate concurrently.
 *
 * Balanced by endpoint count rather than by file count: the profiled fixture
 * has files holding 6 endpoints and files holding 1, and the run is only as
 * fast as its slowest group. Files are packed largest-first into whichever
 * group is currently smallest, which is the standard greedy fit and good
 * enough for the handful of buckets involved here.
 *
 * Returns `[]` when splitting isn't worth it, and the caller falls back to
 * generating the whole spec in one pass. That is the case for a small API
 * (the fixed cost of an extra call is a real fraction of a small spec) and
 * for a single-file API (nothing to split).
 */
export function planSpecGroups(endpoints, { maxGroups = 4, minEndpoints = 8, minFiles = 2 } = {}) {
  const byFile = new Map();
  for (const e of endpoints || []) {
    const file = e.file || '(unknown)';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(e);
  }
  if (byFile.size < minFiles) return [];
  const total = (endpoints || []).length;
  if (total < minEndpoints) return [];

  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const count = Math.max(2, Math.min(maxGroups, byFile.size));
  const groups = Array.from({ length: count }, () => ({ files: [], endpoints: [] }));

  for (const [file, eps] of files) {
    const target = groups.reduce((min, g) => (g.endpoints.length < min.endpoints.length ? g : min), groups[0]);
    target.files.push(file);
    target.endpoints.push(...eps);
  }

  // Greedy packing can leave a group empty when there are fewer files than
  // groups; an empty group would be an AI call with nothing to do.
  let used = groups.filter((g) => g.endpoints.length > 0);
  if (used.length < 2) return [];

  // Coalesce the small groups.
  //
  // Wall clock is set by the LARGEST group, and an indivisible route file
  // bigger than the ideal average pins that floor no matter how the rest is
  // arranged - packing [6,6,1,1,1,1] into four buckets gives 6/6/2/2, where
  // the two small workers finish early and idle. Folding them together
  // yields 6/6/4: the same critical path with one fewer request, and each
  // request costs real money.
  const critical = Math.max(...used.map((g) => g.endpoints.length));
  used = used
    .sort((a, b) => b.endpoints.length - a.endpoints.length)
    .reduce((acc, g) => {
      const host = acc.find((h) => h.endpoints.length + g.endpoints.length <= critical);
      if (host) {
        host.files.push(...g.files);
        host.endpoints.push(...g.endpoints);
      } else {
        acc.push(g);
      }
      return acc;
    }, []);
  if (used.length < 2) return [];

  return used.map((g, i) => ({
    key: `group-${i + 1}`,
    files: g.files.sort(),
    endpoints: g.endpoints,
  }));
}
