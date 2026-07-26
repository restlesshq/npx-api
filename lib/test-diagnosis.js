import { bold, dim, green, red, yellow, cyan } from './ui.js';

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
export function describeDiagnosis(state, { status, localBase = 'your server', aiTool = 'the AI', attempt = 0 } = {}) {
  switch (state) {
    case 'ok':
      return {
        icon: green('✓'),
        canFix: false,
        lines: [`The SDK is picking up your requests.${statusNote(status)}`],
      };

    case 'unreachable': {
      const lines = [
        `Waiting for your server on ${bold(localBase)}…`,
        dim(`Start it in another terminal - we'll detect it automatically, nothing to run here.`),
      ];
      // After a few misses, nudge toward the wrong-port escape hatch - a
      // running server we can't reach is almost always a port mismatch.
      if (attempt >= 3) {
        lines.push(dim(`Already running? It may be on a different port - press ${bold('p')} to change it.`));
      }
      return { icon: dim('⟳'), canFix: false, lines };
    }

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
  actions.push({ key: 'port', label: 'Change the port', afterthought: true });
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
      `into the request path at all, or wrapped around something requests don't pass through. The single ` +
      `most common cause is middleware ORDER: the SDK is registered AFTER a middleware that short-circuits ` +
      `the request - an auth guard, API-key check, or rate limiter that responds (often a 401/403/429) ` +
      `without calling next() - so the SDK never runs for that request.`,
    guidance:
      `Open the server's entry file and check the ORDER of the middleware registrations. The SDK's setup ` +
      `middleware must be registered BEFORE any middleware that can reject or short-circuit a request ` +
      `(auth guards, API-key checks, rate limiters, CORS blockers) - ideally immediately after body parsing ` +
      `(express.json() or equivalent) and before everything else. If it currently sits after an auth guard ` +
      `that returns 401/403 without calling next(), move it up above that guard: a rejected request is ` +
      `exactly the kind of traffic Restless needs to see. "Before the routes" is not enough on its own. ` +
      `When you move it above the auth guard, the setup callback now runs before that guard, so req.user / ` +
      `req.account won't be populated yet - resolve the owner from the credential itself inside the callback ` +
      `(the same lookup the auth middleware does) rather than reading req.user, or authenticated requests will ` +
      `log without an owner. If the ordering is already correct, confirm the middleware is registered on the ` +
      `same app/router that serves these routes, and that the server was restarted to pick up the change.`,
  };
}
