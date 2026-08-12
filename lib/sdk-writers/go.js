import fs from 'fs';
import path from 'path';
import { getSdkLineSpec } from '../sdk-line-spec.js';
import { probe } from '../sdk-probe.js';
import { balancedArg, createEngine, grepWiringFiles, literalInitArg } from './engine.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { firstDeclaredDep, noEnvLoader, readManifests } from '../env-detect.js';
import { portFromGoSource, goFrameworkDefaultPort } from '../test-diagnosis.js';

export { scanGoCodebase as scanCodebase } from '../find-endpoints-go.js';

/**
 * Owns the SDK setup code in Go source files.
 *
 * The shape this has to recognize:
 *
 *     import restless "github.com/restlesshq/go"
 *
 *     client := restless.MustNew(
 *         os.Getenv("RESTLESS_KEY"),
 *         restless.WithBaseURL(...),
 *     )
 *
 *     client.Setup(func(r *restless.RequestInfo) restless.SetupResult {
 *         result := restless.SetupResult{
 *             APIKey: restless.Mask(r.Header("Authorization")),
 *         }
 *         if workspaceID != "" {
 *             result.Owner = &restless.Owner{ID: workspaceID, Enrich: loadWorkspace}
 *         }
 *         return result
 *     })
 *
 *     handler := client.Middleware()(mux)
 *
 * What differs from the other three dialects:
 *
 *   1. **Struct fields, not map keys.** `APIKey:` is exported-PascalCase and
 *      unquoted - a third spelling of the §15 vocabulary after camelCase and
 *      snake_case, which is exactly the variation CONTRACT.md §15 sanctions.
 *   2. **Owner is a POINTER to a struct literal**, `&restless.Owner{...}`, so
 *      every owner match has to allow the `&` and an optional package
 *      qualifier that depends on the user's import alias.
 *   3. **The import name is not the last path element.** The module is
 *      `github.com/restlesshq/go` but the package is `restless`, so an
 *      unaliased import still binds `restless`. Both forms appear in real
 *      code and both must resolve.
 *   4. **Mask has two forms**, `restless.Mask(...)` and `client.Mask(...)`.
 *      The README shows only the package one; the source has both.
 */

export const descriptor = Object.freeze({
  language: 'go',
  extensions: ['.go'],
  searchGlobs: ['*.go'],
  packageSpecifier: 'github.com/restlesshq/go',
  importName: 'restless',
  manifests: ['go.mod'],
  installCommand: 'go get github.com/restlesshq/go',
  neverRead: Object.freeze(['vendor/', 'node_modules/']),
  // The module path is distinctive enough to grep for directly. Escaped
  // because it contains dots that would otherwise match anything.
  searchPattern: 'github\\.com/restlesshq/go',
  commentPrefix: '//',
  // §15 concepts as exported Go struct fields.
  fields: Object.freeze({
    apiKey: 'APIKey',
    owner: 'Owner',
    ownerId: 'ID',
    enrich: 'Enrich',
  }),
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'Mask', styles: ['method', 'package'] }),
  // See javascript.js: no safe universal uninstall, so `api reset` names the
  // manifest and the line and lets the user do it.
  autoUninstall: false,
  phrasing: Object.freeze({
    startHints: '`go run .`, `go run ./cmd/server`, the command in the README',
    dontTouch: '`go.mod` beyond the dependency, `Dockerfile`, or CI config',
    envNote: "The SDK reads `RESTLESS_KEY` from the process environment - Go has no `.env` convention, so export it in the shell you start the server in.",
  }),
});

const F = descriptor.fields;

/** A struct field key: `APIKey:`, unquoted and PascalCase. */
function key(name) {
  return `\\b${escapeRegex(name)}\\s*:`;
}

/**
 * Where the owner attaches, as one alternation:
 *
 *   Owner: &restless.Owner{...}         inside the struct literal
 *   result.Owner = &restless.Owner{...} assigned after, usually conditionally
 *
 * The second is what the real pet-store fixture writes, and it is the Go
 * equivalent of the conditional forms Python and Ruby needed: a struct
 * literal cannot omit a field based on a runtime check.
 */
function ownerAnchor() {
  const n = escapeRegex(F.owner);
  return `\\b${n}\\s*(?::|=)\\s*&\\s*(?:[A-Za-z_]\\w*\\.)?${n}\\s*`;
}

/**
 * Looser: the owner field is set to SOMETHING. Used only to decide whether
 * to bail, which is a different question from whether we can patch it - an
 * owner built by a helper (`result.Owner = ownerFor(r)`) matches this and
 * not `ownerAnchor`, and inserting a second one would not compile.
 */
function ownerPresent() {
  return `\\b${escapeRegex(F.owner)}\\s*(?::|=)`;
}

// `restless "github.com/restlesshq/go"`, `rl "github.com/..."`, or unaliased
// (which still binds `restless`, because the package name is not the last
// path element).
const IMPORT_RE = /(?:^|\s)(?:([A-Za-z_]\w*)\s+)?["']github\.com\/restlesshq\/go["']/m;

/** Every local name the SDK package could be bound to in this file. */
function packageBindings(content) {
  const bindings = new Set();
  const re = new RegExp(IMPORT_RE.source, 'gm');
  let m;
  while ((m = re.exec(content)) !== null) {
    // `_` is a blank import (side effects only) and binds nothing usable.
    if (m[1] && m[1] !== '_') bindings.add(m[1]);
    else bindings.add(descriptor.importName);
  }
  return [...bindings];
}

const CONSTRUCTORS = ['MustNew', 'New'];

export function hasSdkReference(content) {
  if (!content) return false;
  return IMPORT_RE.test(content);
}

/**
 * Is a client actually constructed here? Requires an import AND a call
 * through the binding it created, so a file importing the package only for
 * its types (`*restless.RequestInfo` in a helper signature) is not mistaken
 * for the wiring.
 */
export function hasInit(content) {
  if (!content) return false;
  return packageBindings(content).some((b) =>
    CONSTRUCTORS.some((c) => new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`).test(content)));
}

export const candidateWiringFiles = grepWiringFiles(descriptor);

function findConstructorCall(content) {
  for (const b of packageBindings(content)) {
    for (const c of CONSTRUCTORS) {
      const m = content.match(new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`));
      if (!m) continue;
      const argsStart = m.index + m[0].length;
      const args = balancedArg(content, argsStart);
      if (args === null) continue;
      return { index: m.index, argsStart, args };
    }
  }
  return null;
}


/**
 * Is the module required by THIS module?
 *
 * `go list -m` answers from the module graph, so a `replace` directive pointing
 * at a sibling checkout - the Go equivalent of an editable install, and how the
 * test-apis fixtures consume the SDK before it is published - counts exactly
 * like a published requirement. Reading go.mod by hand would see the `require`
 * line but miss whether it actually resolves.
 *
 * Falls back to a go.mod grep when the toolchain is unavailable or out of
 * budget, so a machine without Go reports "not installed" rather than crashing.
 */
export function resolveInstalled(packageDir, { budget } = {}) {
  const module = descriptor.packageSpecifier;
  const out = probe('go', ['list', '-m', module], { cwd: packageDir, budget });
  // `go list` reports its own errors on stdout in some versions.
  if (out && !/^go: /.test(out)) return out;
  try {
    const gomod = fs.readFileSync(path.join(packageDir, 'go.mod'), 'utf8');
    if (new RegExp(`^\\s*(?:require\\s+)?${escapeRegex(module)}\\s+v`, 'm').test(gomod)) {
      return path.join(packageDir, 'go.mod');
    }
  } catch {
    // No go.mod, or unreadable. Not installed.
  }
  return null;
}

export function describeMissing(packageDir) {
  return [
    `\`go list -m ${descriptor.packageSpecifier}\` in ${packageDir} does not resolve it.`,
    `Run \`go mod tidy\` after adding it, or check you are inside the module.`,
  ];
}

/**
 * Usually "there isn't one".
 *
 * Go has no `.env` convention: a binary reads os.Getenv and the environment
 * comes from the process manager. godotenv exists but is opt-in, so the honest
 * default is `none` - which for Go still means an explicit os.Getenv call,
 * because that is how a Go program reads any variable.
 */
export function detectEnvLoader(installDir) {
  const dep = firstDeclaredDep(readManifests(installDir, descriptor.manifests), [
    ['joho/godotenv', 'godotenv is required in go.mod'],
  ]);
  if (dep) return dep;
  return noEnvLoader('Go reads the process environment directly');
}

export const portFiles = Object.freeze([
  'main.go', 'Procfile', 'docker-compose.yml', 'Dockerfile',
]);

export const parsePort = portFromGoSource;

export function defaultLocalPort() {
  return { port: goFrameworkDefaultPort(), source: null };
}

/**
 * Render the constructor argument.
 *
 * `os.Getenv` rather than a map index: it returns "" for a missing key
 * rather than panicking, so the idiomatic form is also the safe one, and the
 * SDK's CONFIG-002 path degrades to "captured, not uploaded".
 */
function buildInitArg(ctx) {
  const literal = literalInitArg(ctx);
  if (literal !== null) return literal;
  const spec = getSdkLineSpec(ctx);
  // Everything else becomes an explicit os.Getenv, including the "no env
  // loader detected" case that the other languages render as a no-arg call.
  //
  // Go has no `.env` convention at all, so the environment variable is not
  // one way of supplying the key, it is THE way. `MustNew("")` does work -
  // CONFIG-001 falls back to RESTLESS_KEY on an empty string - but it reads
  // as "no key" and only a reader who knows the SDK's fallback rules can
  // tell it apart from a mistake. The explicit form says what it does.
  return `os.Getenv(${JSON.stringify(spec.value || 'RESTLESS_KEY')})`;
}

/**
 * The Go dialect, and the five shared methods built from it.
 *
 * Two things only Go needs. `quotes` includes the backtick, because a raw
 * string literal is a legal way to write the key. And `ownerPresent` is looser
 * than `ownerAnchor`: an owner built by a helper (`result.Owner = ownerFor(r)`)
 * matches the loose form only, and inserting a second field would not compile.
 */
const engine = createEngine({
  descriptor,
  confirmMarker: OWNER_ID_CONFIRM_MARKER,
  inlineKeyTodoText: INLINE_KEY_TODO_TEXT,
  hasSdkReference,
  findConstructorCall,
  initLine: (line, block) =>
    packageBindings(block).some((b) =>
      CONSTRUCTORS.some((c) => new RegExp(`\\b${escapeRegex(b)}\\.${c}\\s*\\(`).test(line))),
  fieldKey: key,
  ownerAnchor,
  ownerPresent,
  quotes: '["`]',
  // `result.Owner = &restless.Owner{...}` - the receiver sits between the
  // confirm comment and the anchor.
  confirmPrefix: '(?:[A-Za-z_]\\w*\\.)?',
  // Qualify the inserted literal with whatever this file calls the package, or
  // it will not compile.
  renderOwnerLine: (indent, expr, block) => {
    const pkg = packageBindings(block)[0] || descriptor.importName;
    return `${indent}${F.owner}: &${pkg}.${F.owner}{${F.ownerId}: ${expr}},`;
  },
  buildInitArg,
  // `os.Getenv("X")`, plus the `envOr("X", ...)` helper the fixture uses.
  envRef: (arg) => {
    const m = arg.match(/(?:os\.Getenv|envOr|LookupEnv)\s*\(\s*["`]([A-Za-z_]\w*)["`]/);
    return m ? m[1] : null;
  },
});

export const {
  parse,
  readBlockFields,
  setOwnerId,
  stripOwnerIdConfirm,
  canonicalizeInitArg,
} = engine;
