import { bold, dim, green, red, yellow, cyan, watchSpinner } from './ui.js';

/**
 * Pure presentation + parsing helpers for the "Test your setup" step.
 * Kept free of any AI / provider imports so they can be unit-tested
 * without pulling the agent SDK into the test process.
 */

/**
 * Parse the final HTTP status code out of a raw `curl -i` dump. There may
 * be several `HTTP/x NNN` lines (redirects, `100 Continue`); the last one
 * is the real response. Returns a number or `null`.
 */
export function parseStatus(raw) {
  if (!raw) return null;
  const lines = String(raw).match(/HTTP\/[\d.]+\s+(\d{3})/g);
  if (!lines) return null;
  const m = lines[lines.length - 1].match(/\d{3}/);
  return m ? Number(m[0]) : null;
}

/**
 * Validate a user-typed port. Accepts `3000`, `:3000`, or a full
 * `http://localhost:3000` and returns the port number, or `null` if it
 * can't find a sane one (1-65535).
 */
export function validatePort(input) {
  if (input == null) return null;
  const m = String(input).match(/(\d{2,5})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Parse a port out of a single shell command (one package.json script).
 * Handles `-p 4000`, `-p4000`, `--port 4000`, `--port=4000`, and a
 * `PORT=4000` / `cross-env PORT=4000` prefix. A `-p`/`--port` flag only
 * counts when a number directly follows, so e.g. concurrently's `-p "{name}"`
 * prefix flag (a quoted string) is ignored. Returns a string port or null.
 */
export function portFromCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const m =
    cmd.match(/(?:^|\s)(?:-p|--port)\s*=?\s*(\d{2,5})\b/) ||
    cmd.match(/\bPORT\s*=\s*(\d{2,5})\b/);
  return m ? m[1] : null;
}

/**
 * Pull an explicitly-configured dev-server port out of a parsed package.json:
 * the scripts (port flags / inline `PORT=`) first, then the npm `config.port`
 * field (referenced in scripts as `$npm_package_config_port`). Conventional
 * dev scripts are checked before the rest so `dev`'s port wins over an
 * unrelated script that happens to name one. Returns a string port or null.
 */
export function portFromPackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const scripts = pkg.scripts || {};
  const ordered = [
    ...['dev', 'start:dev', 'develop', 'serve', 'start'].map((k) => scripts[k]),
    ...Object.values(scripts),
  ].filter((s) => typeof s === 'string');
  for (const cmd of ordered) {
    const p = portFromCommand(cmd);
    if (p) return p;
  }
  const cfgPort = pkg.config && pkg.config.port;
  if (cfgPort != null && /^\d{2,5}$/.test(String(cfgPort))) return String(cfgPort);
  return null;
}

/**
 * Parse a port out of a source or config file's text. Recognizes the common
 * shapes, most-specific first:
 *   - a literal `.listen(4000)`
 *   - the ubiquitous Node fallback idiom `const PORT = process.env.PORT || 4000`
 *     (and `?? 4000`), where the literal sits *after* the env lookup - this is
 *     what a bare Express/Fastify app almost always uses
 *   - a direct `PORT = 4000` / `PORT: 4000`
 *   - a `port: 4000` field in a config object (vite.config, etc)
 * The fallback-idiom and direct patterns are constrained to a single
 * statement (no `\n`/`;` crossing) so we don't stitch an unrelated literal
 * onto a `PORT` mention. Returns a string port or null.
 */
export function portFromSource(content) {
  if (typeof content !== 'string') return null;
  const m =
    content.match(/\.listen\(\s*(\d{2,5})\s*[,)]/) ||
    content.match(/\bPORT\b[^\n;]*?(?:\|\||\?\?)\s*(\d{2,5})\b/) ||
    content.match(/\bPORT\s*(?:=|:)\s*(\d{2,5})\b/) ||
    content.match(/\bport\s*[:=]\s*["']?(\d{2,5})["']?/i);
  return m ? m[1] : null;
}

// Well-known non-HTTP-server ports we never want to mistake for the dev
// server - a `localhost:5432` in a README is a database, not the API.
const NON_SERVER_PORTS = new Set([
  5432, 3306, 6379, 27017, 5672, 15672, 9200, 9300, 11211, 1433, 1521,
  25, 465, 587, 993, 995, 22, 21, 2375, 2376,
]);

/**
 * Pull a dev-server port out of a `localhost:NNNN` / `127.0.0.1:NNNN` URL in
 * arbitrary text - README curl examples, docs, "Server listens on
 * http://localhost:4000", etc. This is a softer signal than an actual port
 * declaration, so it's used as a fallback. Skips well-known DB/mail/service
 * ports so a `localhost:5432` Postgres URL isn't misread as the API. Returns
 * the first plausible HTTP port as a string, or null.
 */
export function portFromUrl(content) {
  if (typeof content !== 'string') return null;
  const re = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g;
  let m;
  while ((m = re.exec(content))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 65535 && !NON_SERVER_PORTS.has(n)) return m[1];
  }
  return null;
}

/**
 * Pull a published dev-server port out of Docker config text. Handles a
 * docker-compose `ports:` list and a Dockerfile `EXPOSE`:
 *   - `- "3002:3000"` / `- 3002:3000` → the HOST side (3002), since that's
 *     what `localhost:<port>` actually reaches
 *   - `- "127.0.0.1:3002:3000"` → still the host port (3002)
 *   - `- "3002"` → a lone published port
 *   - `EXPOSE 3002` → the container port, a decent hint when there's no
 *     explicit mapping
 * Skips well-known DB/service ports (a `5432:5432` Postgres mapping is not the
 * API). Returns a string port or null.
 */
export function portFromDocker(content) {
  if (typeof content !== 'string') return null;
  const ok = (v) => {
    const n = Number(v);
    return n >= 1 && n <= 65535 && !NON_SERVER_PORTS.has(n) ? String(n) : null;
  };
  // A compose `ports:` entry: optional `ip:`, then the host port, then an
  // optional `:container` and `/proto`. We capture the host port.
  const portLine = /^\s*-\s*["']?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d{2,5})(?::\d{2,5})?(?:\/(?:tcp|udp))?["']?\s*$/gm;
  let m;
  while ((m = portLine.exec(content))) {
    const p = ok(m[1]);
    if (p) return p;
  }
  const expose = content.match(/^\s*EXPOSE\s+(\d{2,5})/im);
  if (expose) {
    const p = ok(expose[1]);
    if (p) return p;
  }
  return null;
}

/**
 * The conventional default port for the framework a package.json uses, when
 * no port is set explicitly. Keyed off the declared dependencies, with a few
 * script-signature fallbacks for CLIs that aren't always direct deps. Checked
 * most-specific-first (a SvelteKit app also has `vite`, but should resolve as
 * Vite's 5173; Next ships its own default). Returns a string port or null.
 */
export function frameworkDefaultPort(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const scripts = Object.values(pkg.scripts || {}).filter((s) => typeof s === 'string').join(' ');
  if (has('@angular/core') || /\bng\s+serve\b/.test(scripts)) return '4200';
  if (has('gatsby')) return '8000';
  if (has('astro')) return '4321';
  if (has('@vue/cli-service') || /vue-cli-service\s+serve/.test(scripts)) return '8080';
  if (has('next')) return '3000';
  if (has('nuxt') || has('nuxt3')) return '3000';
  if (has('react-scripts')) return '3000';
  if (has('@remix-run/dev') || has('@remix-run/serve')) return '3000';
  if (has('@sveltejs/kit') || has('vite')) return '5173';
  return null;
}

/**
 * Normalize whatever the user typed into a clean local base URL. Accepts a
 * bare port (`3002`, `:3002`), a host[:port] (`localhost:3002`), or a full
 * URL, with or without a path (`http://localhost:3002/api`). Adds a scheme
 * when missing and trims a trailing slash. Returns the base URL string, or
 * null if it can't make sense of the input.
 */
export function normalizeBaseUrl(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  // A bare port / `:port` → localhost.
  if (/^:?\d{2,5}$/.test(s)) {
    const port = validatePort(s);
    return port ? `http://localhost:${port}` : null;
  }
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    const p = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${p === '' || p === '/' ? '' : p}`;
  } catch {
    return null;
  }
}

/**
 * Extract a base path from an OAS `servers[0].url`, so an API mounted under a
 * prefix (e.g. servers `http://localhost:3000/api`, paths `/employees`) still
 * gets probed at `/api/employees`. Returns the path (e.g. `/api`) with no
 * trailing slash, or '' when the server is host-only / the prefix already
 * lives in the path keys. Handles both absolute URLs and bare `/api` values.
 */
export function basePathFromServers(oas) {
  const url = oas?.servers?.[0]?.url;
  if (!url || typeof url !== 'string') return '';
  let p;
  try { p = new URL(url).pathname; }
  catch { p = url.startsWith('/') ? url : ''; }
  p = (p || '').replace(/\/+$/, '');
  return p === '/' ? '' : p;
}

/**
 * A short parenthetical that reassures the user a non-2xx status is fine.
 * The whole point of the step is the SDK header, not a successful call, so
 * a 401/404 should read as "expected", not "broken".
 */
export function statusNote(status) {
  if (!status || (status >= 200 && status < 300)) return '';
  return ` ${dim(`(got a ${status} - that's expected, we only needed the SDK to see the request.)`)}`;
}

/**
 * Turn a diagnostic state into the panel we show the user. Pure: returns
 * `{ icon, lines, canFix }` where `lines` are ready-to-render ANSI strings
 * and `canFix` says whether the AI "fix it" action makes sense.
 *
 * States (see diagnoseFromHeaders in test-setup.js):
 *   - 'unreachable' → curl couldn't connect (server down / wrong port)
 *   - 'no-sdk'      → server answered but no SDK header (not intercepting)
 *   - 'no-key'      → SDK ran but RESTLESS_KEY missing in the process
 *   - 'stale-key'   → SDK ran with a key, but no log reached the dashboard
 *   - 'ok'          → SDK captured the request
 */
export function describeDiagnosis(state, { status, localBase = 'your server', aiTool = 'the AI', attempt = 0, frame = 0 } = {}) {
  switch (state) {
    case 'ok':
      return {
        icon: green('✓'),
        canFix: false,
        lines: [`The SDK is picking up your requests.${statusNote(status)}`],
      };

    case 'unreachable':
      // Deliberately terse: a bold CTA, then just the URL we're watching. The
      // "change the URL / skip" hint is appended by the caller's footer.
      return {
        icon: watchSpinner(frame),
        canFix: false,
        lines: [
          bold('Start your server'),
          dim(`Watching for ${localBase}`),
        ],
      };

    case 'no-sdk':
      return {
        icon: red('✗'),
        canFix: true,
        lines: [
          `Your server answered, but the request didn't go through the Restless SDK.${statusNote(status)}`,
          dim(`The middleware isn't intercepting requests - it may be wired in the wrong place, or your server needs a restart to pick up the change.`),
        ],
      };

    case 'no-key':
      return {
        icon: red('✗'),
        canFix: true,
        lines: [
          `The SDK ran, but ${bold('RESTLESS_KEY')} isn't set in the running server.`,
          dim(`It needs the key in its environment to send logs. This usually means ${bold('.env')} is missing the key, or the server was started before it was added.`),
        ],
      };

    case 'stale-key':
      // Not AI-fixable: the correct key only exists in the user's dashboard,
      // so we point them at .env rather than pretend to fix it.
      return {
        icon: yellow('⚠'),
        canFix: false,
        lines: [
          `The SDK ran, but no log reached your dashboard.${statusNote(status)}`,
          dim(`Your ${bold('RESTLESS_KEY')} is most likely stale - update it in ${bold('.env')} from your dashboard and restart.`),
        ],
      };

    default:
      return { icon: dim('·'), canFix: false, lines: [`Test request sent.`] };
  }
}

/**
 * The action menu for a failing diagnosis. Fixable states lead with the
 * AI "fix it" action; everything offers re-check / change-port / skip.
 * Returned as `actionPicker` action descriptors.
 */
export function fixActions(state, { aiTool = 'the AI' } = {}) {
  const canFix = describeDiagnosis(state).canFix;
  const actions = [];
  if (canFix) {
    actions.push({
      key: 'fix',
      label: 'Fix it automatically',
      primary: true,
      hint: `${aiTool} reads your code, applies a fix, then we re-check`,
    });
    actions.push({ key: 'recheck', label: "I'll fix it myself - re-check" });
  } else {
    actions.push({ key: 'recheck', label: 'Re-check now' });
  }
  actions.push({ key: 'port', label: 'Change the URL', afterthought: true });
  actions.push({ key: 'skip', label: 'Skip for now', afterthought: true });
  return actions;
}

/**
 * Build the runtime evidence + guidance handed to the fix-sdk AI prompt.
 * Separated so the exact wording is testable and consistent.
 */
export function fixContext(state, { localBase } = {}) {
  if (state === 'no-key') {
    return {
      evidence:
        `A live request to ${localBase} reached the Restless SDK, but the SDK reported that ` +
        `RESTLESS_KEY is not set in the running server process (it returned the response header ` +
        `"x-restless-id: missing-key"). The server is running, but it either has no RESTLESS_KEY ` +
        `in its environment or isn't loading it.`,
      guidance:
        `Make sure RESTLESS_KEY is present in the project's .env file, and that the server actually ` +
        `loads .env at startup (e.g. the framework auto-loads it, or dotenv is configured). If the key ` +
        `line is missing from .env, add it as RESTLESS_KEY= (leave the value empty for the user to fill ` +
        `if you don't have it - never invent or hardcode a key). Fix the loading so process.env.RESTLESS_KEY ` +
        `is populated when the server runs.`,
    };
  }
  // Default: no-sdk (request didn't carry the SDK header at all).
  return {
    evidence:
      `A live request was just sent to the running server at ${localBase}, and the response came back ` +
      `WITHOUT the Restless SDK's "x-restless-id" response header. That means the SDK is installed but ` +
      `is not actually intercepting HTTP requests at runtime - it's wired into the wrong place, not wired ` +
      `into the request path at all, or wrapped around something requests don't pass through.`,
    guidance:
      `Find the server's entry file and/or route handlers and fix why requests aren't flowing through the ` +
      `SDK. Confirm the SDK middleware/wrapper actually sits in front of the routes that handle requests.`,
  };
}
