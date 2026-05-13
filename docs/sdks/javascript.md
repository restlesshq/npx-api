# JavaScript SDK Installation

Full reference: the `install.md` file at the root of the `@restlessai/sdk` package. Consult that if anything below is ambiguous.

## Install

```bash
npm install @restlessai/sdk --save
```

## Setup

The single entry point `@restlessai/sdk` auto-detects the framework at runtime (Express, Fastify, Koa, Hono, Next, bare http) from the call signature. Use it for every framework. Do NOT import a framework-specific subpath like `@restlessai/sdk/fastify`. The same `require('@restlessai/sdk')(process.env.RESTLESS_KEY)` line works everywhere; only the registration pattern differs per framework.

The setup callback returns one shape:

```js
{
  apiKey: restless.mask(<end-user credential>),
  owner:  { id: <stable internal id>, enrich: async (id) => ({ label, email }) }
}
```

`apiKey` identifies the individual caller. `owner.id` identifies who they belong to (workspace / tenant / user record). Both go on every log; the dashboard groups by `owner.id`.

### `owner.id` is permanent and required

`owner.id` is the **immutable identifier the dashboard pins a customer's entire log history to**. Once a customer has started producing logs under one id, changing it fragments their history. Pick something that cannot change for the same customer.

**Valid ids:** database primary keys, workspace UUIDs, tenant ids, user record ids: anything the application treats as a permanent internal handle.

**Never use any of these:** the API key (rotatable and a secret), an email address (changeable), a username, a JWT, a session id, any value that can be edited by the user, or a placeholder literal (`'anonymous'`, `'none'`, `'unknown'`, `'guest'`, `'default'`). If it can change for the same person, or it's a dummy string, it is wrong.

**For requests with no real owner** (no authenticated user, public endpoints, health checks): return `owner: undefined` for that request, or omit the `owner` key entirely. The SDK has its own anonymous bucket on the wire-format side. Never use a placeholder string:

```js
return {
  apiKey: restless.mask(extractApiKey(req)),
  owner: req.user ? { id: req.user.workspaceId } : undefined,
};
```

You MUST verify the id you pick is immutable before wiring it in. Read the model / schema for the field you're using. If the field looks user-editable (an email column, a `username` column, a `name` column), it is NOT a valid `owner.id`.

If you genuinely cannot find a stable internal id after looking at the auth flow and the data model, **do not invent one and do not fall back to the API key.** Wire the SDK with a placeholder and a marker comment so the CLI can prompt the human:

```js
owner: {
  // RESTLESS_OWNER_ID_TODO: I could not find a stable, immutable identifier in
  // this codebase's auth flow. The CLI will prompt the user to fill this in.
  id: 'NEEDS_CONFIGURATION',
},
```

The exact comment marker `RESTLESS_OWNER_ID_TODO` and the literal placeholder `'NEEDS_CONFIGURATION'` are both required. The CLI greps for them and asks the user what to use.

### Picking `owner.id`

| API shape                                       | Use as `owner.id`                                     |
|-------------------------------------------------|-------------------------------------------------------|
| Multi-tenant SaaS (workspaces, orgs, teams)     | The tenant's stable internal id (uuid / pk)           |
| Per-user API (one key per developer/end-user)   | The user's stable internal id (uuid / pk)             |
| Multiple keys per tenant (test/prod/CI keys)    | The tenant's id; keys roll up under one owner         |
| Cannot find a stable internal id                | `'NEEDS_CONFIGURATION'` with marker comment above     |

### `owner.enrich`

`enrich` lives **inside `owner`** and runs once per id (the SDK caches by id). It receives the id as its only argument. Use it for any lookup expensive enough to skip on every request (DB query, JWT verification, external HTTP). Return fields flat:

```js
owner: {
  id: workspace.id,
  enrich: async (id) => {
    const ws = await db.workspaces.findById(id);
    return { label: ws.name, email: ws.adminEmails };  // email: string or string[]
  },
}
```

If the lookup is cheap (in-memory map, header read, already on `req`), skip `enrich` and put the values inline:

```js
owner: { id: req.user.workspaceId, label: req.user.workspaceName, email: req.user.email }
```

`email` is what powers dashboard access grants. Confirming any of those emails on Restless pins this owner to that human.

### `extractApiKey`

Whatever the API uses for auth, extract the raw credential and pass it to `restless.mask()`. Examples:

```js
// Bearer token
const auth = req.headers.authorization || '';
return auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

// Custom header
return req.headers['x-api-key'];

// Query param
return new URL(req.url, 'http://x').searchParams.get('api_key');
```

If the credential is missing, return `undefined`. Do NOT substitute a placeholder string: `restless.mask()` handles `undefined`, but `restless.mask('anonymous')` leaks `'mous'` as the mask tail.

## Setup - Express

Register BEFORE route definitions, but AFTER any middleware that attaches `req.user` / `req.session` / similar:

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(authMiddleware);  // sets req.user; must run first
app.use(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
  owner: req.user ? {
    id: req.user.workspaceId,
    enrich: async (id) => {
      const ws = await db.workspaces.findById(id);
      return { label: ws.name, email: ws.adminEmails };
    },
  } : undefined,
})));
app.use('/api', routes);
```

Express middleware runs in registration order and the setup callback fires at middleware-entry, so anything attached by middleware registered AFTER the SDK won't be visible. The trade-off: requests that auth rejects before the SDK middleware runs won't be logged. If you need to capture those too, register the SDK first and accept that authenticated requests will log without owner data.

## Setup - Fastify

The SDK plugin uses two hooks: `onRequest` (mints the request ID and sets response headers) and `preHandler` (calls the setup callback, runs blocking). Splitting across both phases means **the setup callback runs after every `onRequest` hook has had a chance to attach state** like `req.user`, so plugin registration order does NOT affect whether auth-attached fields are visible.

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

await fastify.register(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
  // req.user was populated by whatever onRequest auth hook ran first.
  owner: req.user ? { id: req.user.workspaceId } : undefined,
})));

fastify.addHook('onRequest', authCheck);  // sets req.user
```

Two edge cases to know about:

- **Auth hook short-circuits (throws or replies in `onRequest`).** The SDK's `preHandler` never runs, so the setup callback doesn't fire. The log is still recorded by `onSend` with no owner data, which is correct: an auth-rejected request has no owner.
- **Auth lives in `preHandler` instead of `onRequest`.** Then registration order matters again: register your auth `preHandler` BEFORE the SDK plugin so it runs first.

The SDK plugin is marked `skip-override` so its hooks attach to the parent context and see every route.

## Setup - Koa

Same rule as Express: register AFTER any middleware that attaches `ctx.state`. The setup callback fires before `await next()`, so it only sees state attached by earlier middleware.

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(authMiddleware);  // attaches ctx.state.user
app.use(restless.setup((ctx) => ({
  apiKey: restless.mask(extractApiKey(ctx.request)),
  owner: ctx.state.user ? { id: ctx.state.user.workspaceId } : undefined,
})));
```

## Rules (hard constraints for LLM installers)

- **Placement:** the middleware/plugin MUST be registered BEFORE the route definitions.
- **Shape:** the setup callback returns `{ apiKey, owner: { id, enrich? } }`. `owner` is nested. There is no top-level `projectId`; there is no top-level `project`; there is no top-level `enrich`. Anything else is wrong.
- **`owner.id` must be immutable.** Read the schema or model for the field you pick. If it could be edited by the user (email, username, display name), it is invalid.
- **Never use the API key, the masked API key, or any secret as `owner.id`.** If you cannot find a stable internal id, use the `'NEEDS_CONFIGURATION'` placeholder + `RESTLESS_OWNER_ID_TODO` marker comment shown above. The CLI handles it.
- **Never modify `package.json`, not the scripts, not the dependencies, nothing.** Adding `--env-file=.env` to the `start` script is a no. The user handles env loading their own way.
- **Never modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI, etc.). Your changes go in the server source file only.
- **Never install or suggest installing extra packages.** No `dotenv`, no adapters, nothing. `process.env.RESTLESS_KEY` is assumed to be available at runtime.
- **Never read `.env`, `.env.local`, or any credentials file.** This is non-negotiable.
- **Never read files inside `node_modules/`.** The SDK is a black box.
- **`restless.mask()` gotcha:** always pass the raw value. If it's missing, `mask()` returns `undefined` and that is fine. Do NOT write `restless.mask(value || 'anonymous')`: the string `'anonymous'` would get hashed and its last 4 characters (`mous`) would appear as the tail of every anonymous log's mask, defeating the purpose.
- **`.restless/settings.json` is read automatically by the SDK at startup.** You do NOT need to read it yourself, the SDK walks up from cwd to find it.
- **Obsolete fields:** `setupMode`, `apiId`, `email` (top-level), `project: { id, name }`, top-level `projectId`, top-level `enrich`, and `hooks.getUser` are all from the old SDK and will be ignored. Use only the `{ apiKey, owner: { id, enrich? } }` shape.

## Verify

1. `@restlessai/sdk` appears in `package.json` dependencies.
2. The middleware/plugin is registered in the server code with a `setup(cb)` callback.
3. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
