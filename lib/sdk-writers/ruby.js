import fs from 'fs';
import path from 'path';
import { getSdkLineSpec } from '../sdk-line-spec.js';
import { probe } from '../sdk-probe.js';
import { balancedArg, createEngine, literalInitArg } from './engine.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { findSdkReferences } from '../grep-sdk.js';
import { anyFileExists, firstDeclaredDep, noEnvLoader, readManifests } from '../env-detect.js';
import { portFromRubySource, rubyFrameworkDefaultPort } from '../test-diagnosis.js';

export { scanRubyCodebase as scanCodebase } from '../find-endpoints-ruby.js';

/**
 * Owns the SDK setup code in Ruby source files.
 *
 * The shape this has to recognize:
 *
 *     require "restless"
 *
 *     CLIENT = Restless.new(ENV["RESTLESS_KEY"])
 *
 *     CLIENT.setup do |request|
 *       result = { api_key: CLIENT.mask(request.header("Authorization")) }
 *       result[:owner] = { id: workspace_id, enrich: method(:load_workspace) }
 *       result
 *     end
 *
 *     use CLIENT.rack                                    # config.ru
 *     config.middleware.insert_before 0, CLIENT.rack     # Rails
 *
 * What differs from the other two dialects:
 *
 *   1. **The wiring is not in the file with the routes.** Rack mounts in
 *      `config.ru` or `config/application.rb` while the routes live in
 *      `config/routes.rb` or a Sinatra app class. `candidateWiringFiles` is
 *      the seam that exists for exactly this, and Ruby is the language it was
 *      designed for - the JavaScript assumption "the wiring is in a file that
 *      imports the package" is simply false here.
 *   2. **A Rails wiring may not `require` anything.** Bundler auto-requires
 *      gems, so `config/application.rb` can reference `Restless` with no
 *      require line anywhere. Every "is this file wired" check therefore has
 *      to accept a bare constructor reference, not just an import.
 *   3. **Hash keys have two spellings**, `api_key:` and `:api_key =>`. Both
 *      are current Ruby; a writer that knew only one would silently miss
 *      half of real code.
 *
 * Like the other writers this patches by regex, so it only touches what it
 * recognizes and leaves anything else for the user.
 */

export const descriptor = Object.freeze({
  language: 'ruby',
  extensions: ['.rb', '.ru'],
  searchGlobs: ['*.rb', '*.ru'],
  packageSpecifier: 'restless-sdk',
  importName: 'restless',
  manifests: ['Gemfile', 'gems.rb', '*.gemspec'],
  installCommand: 'gem install restless-sdk',
  // `config/master.key` and the encrypted credentials file are Rails' secret
  // store, so they belong here for the same reason `.env` does.
  neverRead: Object.freeze(['vendor/bundle/', 'config/master.key', 'config/credentials.yml.enc']),
  // Matches a require OR a bare constructor reference, because a Rails
  // wiring legitimately has neither a require nor the gem name in the file.
  searchPattern: '(require[[:space:]]+["\']restless["\']|Restless\\.new|Restless::Client)',
  commentPrefix: '#',
  // §15 concepts as Ruby symbol keys.
  fields: Object.freeze({
    apiKey: 'api_key',
    owner: 'owner',
    ownerId: 'id',
    enrich: 'enrich',
  }),
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'mask', styles: ['method', 'module'] }),
  // See javascript.js: no safe universal uninstall, so `api reset` names the
  // manifest and the line and lets the user do it.
  autoUninstall: false,
  phrasing: Object.freeze({
    startHints: '`bin/rails server`, `bundle exec rackup`, `bundle exec puma`, the command in the README',
    dontTouch: 'the `Gemfile`, `Dockerfile`, or CI config',
    envNote: "The SDK reads `RESTLESS_KEY` from the process environment. Rails with dotenv-rails picks it up from `.env` already; otherwise export it in the shell you start the server in.",
  }),
});

const F = descriptor.fields;

/**
 * A hash key in either spelling: `api_key:` (modern) or `:api_key =>`
 * (hashrocket). Both are idiomatic and both appear in real code.
 */
function key(name) {
  const n = escapeRegex(name);
  return `(?:${n}\\s*:|:${n}\\s*=>)`;
}

/**
 * Where the owner hash attaches, as one alternation:
 *
 *   owner: { ... }            inside the hash literal
 *   result[:owner] = { ... }  assigned after, usually conditionally
 *
 * The second is what the real pet-store fixture writes, for the same reason
 * it appears in Python: a literal cannot conditionally omit a key.
 */
function ownerAnchor() {
  const n = escapeRegex(F.owner);
  return `(?:${n}\\s*:|:${n}\\s*=>|\\[\\s*:${n}\\s*\\]\\s*=)\\s*`;
}

const REQUIRE_RE = /^[ \t]*require(?:_relative)?[ \t]+["']restless["'][ \t]*(?:#.*)?$/m;
// `Restless.new`, `Restless::Client.new`, and an alias assigned from either.
const CONSTRUCTOR_RE = /\bRestless(?:::Client)?\.new\s*\(/;
const CONSTRUCTOR_NO_PARENS_RE = /\bRestless(?:::Client)?\.new\b/;

/** Does this file reference the SDK at all? The loose check. */
export function hasSdkReference(content) {
  if (!content) return false;
  return REQUIRE_RE.test(content) || CONSTRUCTOR_NO_PARENS_RE.test(content)
    || /\bRestless::Client\b/.test(content);
}

/**
 * Is a client actually constructed here? The strict check.
 *
 * Deliberately does NOT require a `require` line: under Bundler the gem is
 * already loaded, so a Rails `config/application.rb` wires the SDK without
 * one. Requiring an import would report every Rails install as unwired.
 */
export function hasInit(content) {
  if (!content) return false;
  return CONSTRUCTOR_RE.test(content);
}

/**
 * Known Rack mount points, ahead of the grep.
 *
 * Rails mounts middleware in `config/application.rb` (or an initializer) and
 * a rackup app in `config.ru`, while the routes sit in `config/routes.rb`.
 * None of those necessarily mention the gem, so the grep alone can miss the
 * file the CLI has to patch.
 */
const MOUNT_FILES = [
  'config.ru',
  path.join('config', 'application.rb'),
  path.join('config', 'environment.rb'),
  path.join('config', 'initializers', 'restless.rb'),
];

export function candidateWiringFiles(installDir) {
  const found = findSdkReferences(installDir, {
    pattern: descriptor.searchPattern,
    globs: descriptor.searchGlobs,
  });
  const known = MOUNT_FILES.filter((rel) => {
    try {
      return fs.existsSync(path.join(installDir, rel));
    } catch {
      return false;
    }
  });
  // Known mount points first, then whatever the grep turned up, deduped.
  return [...new Set([...known, ...found])];
}

function findConstructorCall(content) {
  const m = content.match(CONSTRUCTOR_RE);
  if (!m) return null;
  const argsStart = m.index + m[0].length;
  const args = balancedArg(content, argsStart);
  if (args === null) return null;
  return { index: m.index, argsStart, args };
}


/**
 * Is the gem available to THIS project?
 *
 * `bundle list` first, because a Ruby app runs under Bundler and the answer
 * that matters is what the project's Gemfile resolves - a globally installed
 * gem that Bundler does not load is not usable, and a `path:` or `git:` gem
 * that is not globally installed is. That mirrors why the Python check asks an
 * interpreter rather than looking for a directory.
 *
 * Cheapest first, and it stops as soon as the budget is gone: `bundle` on a
 * cold Rails app is the slowest probe of any language, and three of them in
 * series is what froze the terminal.
 */
export function resolveInstalled(packageDir, { budget } = {}) {
  const gem = descriptor.packageSpecifier;
  for (const [command, args] of [
    ['bundle', ['list', gem]],
    ['bundle', ['show', gem]],
    ['gem', ['list', '-i', gem]],
  ]) {
    const out = probe(command, args, { cwd: packageDir, budget });
    // `gem list -i` prints "false" and exits 1 when absent; belt and braces.
    if (out && !/^false$/i.test(out)) return out.split('\n')[0];
    if (budget?.spent()) break;
  }
  return null;
}

export function describeMissing(packageDir) {
  return [
    `Asked bundler and rubygems for \`${descriptor.packageSpecifier}\` in ${packageDir} -`,
    `neither has it. If the gem is in your Gemfile, run \`bundle install\` first.`,
  ];
}

/**
 * Rails loads `config/credentials.yml.enc` and (via dotenv-rails, if present)
 * `.env` before the app boots, so an env var referenced at boot is reliable
 * there. A bare Rack app has no such convention, which is the same situation
 * Python is in.
 */
export function detectEnvLoader(installDir) {
  // Gemfile.lock too: dotenv-rails often arrives as a transitive dependency
  // that the Gemfile itself never names.
  const declared = readManifests(installDir, ['Gemfile', 'gems.rb', 'Gemfile.lock']);
  const dep = firstDeclaredDep(declared, [
    ['dotenv-rails', 'dotenv-rails is in the Gemfile'],
    ['dotenv', 'dotenv is in the Gemfile'],
    ['figaro', 'figaro is in the Gemfile'],
  ]);
  if (dep) return dep;

  if (anyFileExists(installDir, ['config/credentials.yml.enc', 'config/application.rb'])) {
    return { mode: 'auto', evidence: 'Rails loads its own configuration before boot' };
  }
  return noEnvLoader();
}

export const portFiles = Object.freeze([
  'Procfile', 'config/puma.rb', 'config.ru', 'Rakefile', 'docker-compose.yml',
]);

export const parsePort = portFromRubySource;

export function defaultLocalPort(searchDir, framework = '') {
  const port = rubyFrameworkDefaultPort(declaredDeps(searchDir), framework);
  if (port) return { port, source: 'the framework default' };
  // rackup's default, not Node's 3000.
  return { port: '9292', source: null };
}

/** Gem names from the Gemfile and its lockfile, lowercased. */
function declaredDeps(searchDir) {
  const names = new Set();
  const text = readManifests(searchDir, ['Gemfile', 'gems.rb', 'Gemfile.lock']);
  for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) names.add(m[1].toLowerCase());
  for (const m of text.matchAll(/^\s{4}([a-z][\w-]*)\s/gm)) names.add(m[1].toLowerCase());
  return [...names];
}

/**
 * Render the constructor argument.
 *
 * `ENV["X"]` rather than a fetch: unlike Python's dict subscript, Ruby's
 * `ENV[...]` returns nil for a missing key instead of raising, so the
 * idiomatic form is also the safe one and the SDK falls back to its own
 * lookup.
 */
function buildInitArg(ctx) {
  const literal = literalInitArg(ctx);
  if (literal !== null) return literal;
  const spec = getSdkLineSpec(ctx);
  if (spec.form === 'env-ref') return `ENV[${JSON.stringify(spec.value)}]`;
  return '';
}

/**
 * The Ruby dialect, and the five shared methods built from it.
 *
 * Note `receiver`: Ruby's admits `::`, so `Restless::Client.mask(...)` resolves
 * where the default `[A-Za-z_]\w*\.` would not.
 */
const engine = createEngine({
  descriptor,
  confirmMarker: OWNER_ID_CONFIRM_MARKER,
  inlineKeyTodoText: INLINE_KEY_TODO_TEXT,
  hasSdkReference,
  findConstructorCall,
  initLine: (line) => CONSTRUCTOR_NO_PARENS_RE.test(line),
  // `key()` already carries the separator for both spellings (`id:` and
  // `:id =>`), so it is the field-key fragment as-is.
  fieldKey: key,
  ownerAnchor,
  receiver: '(?:[A-Za-z_][\\w:]*\\.)?',
  confirmPrefix: '(?:result)?',
  // Ruby routinely opens the hash on the same line as the assignment
  // (`result = { api_key: ... }`), so the key is not at the line start.
  apiKeyLinePrefix: '.*?',
  renderOwnerLine: (indent, expr) => `${indent}${F.owner}: { ${F.ownerId}: ${expr} },`,
  buildInitArg,
  // `ENV["X"]`, `ENV.fetch("X", nil)`, and the `|| "fallback"` form the
  // fixtures use for local runs.
  envRef: (arg) => {
    const m = arg.match(/ENV(?:\.fetch)?\s*[[(]\s*["']([A-Za-z_]\w*)["']/);
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
