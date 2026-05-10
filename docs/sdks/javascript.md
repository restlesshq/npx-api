# JavaScript SDK Installation

Full reference: the `install.md` file at the root of the `@restlessai/sdk` package. Consult that if anything below is ambiguous.

## Install

```bash
npm install @restlessai/sdk --save
```

## Setup

The single entry point `@restlessai/sdk` auto-detects the framework at runtime (Express, Fastify, Koa, Hono, Next, bare http) from the call signature. Use it for every framework. Do NOT import a framework-specific subpath like `@restlessai/sdk/fastify`. The same `require('@restlessai/sdk')(process.env.RESTLESS_KEY)` line works everywhere; only the registration pattern differs per framework.

## Setup - Express

Register BEFORE any route definitions:

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(restless.setup((req) => ({
  // `apiKey` identifies the individual end-user. Extract the API key from
  // the Authorization header (or wherever this API puts it), then run it
  // through restless.mask() so it can be logged safely.
  apiKey: restless.mask(extractApiKey(req)),

  // Optional but recommended: `projectId` is a stable identifier for the
  // customer/org/tenant this user belongs to. It becomes the grouping
  // dimension on the dashboard. Only include it if the API actually has
  // this concept (multi-tenant SaaS, workspaces, etc.).
  // projectId: req.headers['x-tenant-id'],
})));
```

`extractApiKey(req)` is something you write based on how this API authenticates. Examples:

```js
// Bearer token
const auth = req.headers.authorization || '';
return auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

// Custom header
return req.headers['x-api-key'];

// Query param
return new URL(req.url, 'http://x').searchParams.get('api_key');
```

**If the credential is missing, return `undefined`** - do NOT substitute a string like `'anonymous'`. `restless.mask()` handles `undefined` gracefully; substituting a placeholder would cause its last 4 characters to leak as the mask's tail.

### `project.id` — pick this carefully, it's permanent

`project.id` is the **stable, immutable identifier the dashboard uses to group every log this customer / tenant / user ever produces**. Once it's set, don't change it: the value gets sent to Restless on every request and is what the dashboard uses to pin a project's history. Treat it like a primary key — different shape per API, but the contract is "this never changes for this customer."

**HARD RULE: never put a raw API key (or anything secret) into `project.id`.** If the user rotates their API key, you'd lose the log thread. The id leaves your machine; secrets shouldn't.

To pick the right id, look at the API's identity model:

1. **Tenant / org / workspace concept** (most B2B SaaS): one customer has one workspace, multiple users on the same key. Use the workspace's stable internal id.
   ```js
   project: { id: workspace.id, enrich: async (id) => ({ label: workspace.name, email: workspace.adminEmails }) }
   ```
2. **Per-user API** (one key per developer/end-user, no tenant concept): use the user's stable internal id (UUID, integer PK, slug — whichever your DB uses). Do NOT use the email itself for `id` (it changes); pass it through `enrich.email` instead so the dashboard can grant access by confirmed email.
   ```js
   project: { id: user.id, enrich: async () => ({ label: user.label, email: user.email }) }
   ```
3. **Multiple keys per project** (e.g. one tenant with many test/prod keys): same as #1 — group by tenant id, the multiple keys all roll up.
4. **No identity model at all** (you can't find anything stable): fall back to the API key's hash and **emit a TODO comment** so a human comes back and fixes it. The hash is one-way safe to send, but it couples the project 1:1 to a single key, so rotating the key fragments the log history.
   ```js
   // TODO: replace with a stable internal id (workspace, user, etc.).
   //       Using the key hash means rotating the key fragments log history.
   project: { id: restless.mask(extractApiKey(req)) }
   ```

`enrich` lives **inside `project`** and runs once per id (cached). Return the project fields flat (`{ label, email, ... }`), never nested under another `project` key. `email` can be a string or string[]; that's how access grants work — confirming any of those emails on the Restless dashboard pins the project to that user.

If there's truly no tenant or user concept and every request is anonymous, skip `project` entirely.

## Setup - Fastify

**Register BEFORE any `fastify.addHook('onRequest', ...)` you have for auth, rate limiting, or anything else.** Fastify hooks run in registration order; if an auth hook throws first, the SDK's `onRequest` never fires and no log lands. The SDK plugin is marked `skip-override` so it attaches its hooks to the parent context - register-order is what matters.

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

// FIRST: register the SDK plugin.
await fastify.register(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
})));

// THEN: any addHook('onRequest', ...) calls (auth, rate limiting, etc.).
fastify.addHook('onRequest', authCheck);
```

## Setup - Koa

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(restless.setup((ctx) => ({
  apiKey: restless.mask(extractApiKey(ctx.request)),
})));
```

## Rules (hard constraints for LLM installers)

- **Placement:** the middleware/plugin MUST be registered BEFORE the route definitions.
- **Never modify `package.json` - not the scripts, not the dependencies, nothing.** Adding `--env-file=.env` to the `start` script is a no. The user handles env loading their own way.
- **Never modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI, etc.). Your changes go in the server source file only.
- **Never install or suggest installing extra packages.** No `dotenv`, no adapters, nothing. `process.env.RESTLESS_KEY` is assumed to be available at runtime.
- **Never read `.env`, `.env.local`, or any credentials file.** This is non-negotiable.
- **Never read files inside `node_modules/`.** The SDK is a black box.
- **`restless.mask()` gotcha:** always pass the raw value. If it's missing, `mask()` returns `undefined` - that's fine. **Do NOT write `restless.mask(value || 'anonymous')`** - the string `'anonymous'` would get hashed and its last 4 characters (`mous`) would appear as the tail of every anonymous log's mask, defeating the purpose.
- **`.restless/settings.json` is read automatically by the SDK at startup.** You do NOT need to read it yourself - the SDK walks up from cwd to find it.
- **`setupMode`, `apiId`, `email` (top-level), `project: { id, name }`, and `hooks.getUser` are OBSOLETE.** The old SDK used them. The new SDK uses `restless.setup(cb)` with `apiKey` / `projectId` / `enrich` - do NOT pass any of the old fields.

## Verify

1. `@restlessai/sdk` appears in `package.json` dependencies.
2. The middleware/plugin is registered in the server code with a `setup(cb)` callback.
3. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
