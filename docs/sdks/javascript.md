# JavaScript SDK Installation

Full reference: the `install.md` file at the root of the `@restlessai/sdk` package. Consult that if anything below is ambiguous.

## Install

```bash
npm install @restlessai/sdk --save
```

## Setup

The single entry point `@restlessai/sdk` auto-detects the framework at runtime (Express, Fastify, Koa, Hono, Next, bare http) from the call signature. Use it for every framework. Do NOT import a framework-specific subpath like `@restlessai/sdk/fastify`. The same factory call works everywhere; only the registration pattern differs per framework.

Name the client `sdk`. The factory is what you import; calling it returns the client, and `.setup` / `.mask` live on that client. Use this exact form so the binding is predictable:

```js
// CommonJS (no "type": "module" in package.json):
const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

// ESM ("type": "module", or a .mjs / TypeScript project):
import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);
```

In ESM the import binding (`restless`) is the *factory*, so the client needs its own name - always `const sdk = restless(...)`. Do not call `restless.setup(...)` / `restless.mask(...)` directly; those exist on `sdk`, not the factory. Use `sdk` as the client name in CJS too, for consistency.

The setup callback returns one shape:

```js
{
  apiKey: sdk.mask(<end-user credential>),
  owner:  { id: <stable internal id>, enrich: async (id) => ({ label, email }) }
}
```

`apiKey` identifies the individual caller. `owner.id` identifies who they belong to. Both go on every log; the dashboard groups by `owner.id`.

### What the "owner" is

The owner is the entity that **owns the API key** in your data model - whoever the traffic is attributed to. That is **not necessarily a user**: depending on the app it's a workspace, project, team, organization, account, tenant, service, or user. Determine it from what the key belongs to (the foreign key on the keys/tokens table, the JWT `sub`, the record a key row points at), and represent your real model - if keys belong to a project, the owner is the project, not the user who created it.

### `owner.id` is permanent and required

`owner.id` is the **immutable identifier the dashboard pins a customer's entire log history to**. Once a customer has started producing logs under one id, changing it fragments their history. Pick something that cannot change for the same owner.

**Valid ids:** database primary keys, workspace UUIDs, tenant ids, user record ids: anything the application treats as a permanent internal handle.

**Never use any of these:** the API key (rotatable and a secret), an email address (changeable), a username, a JWT, a session id, any value that can be edited by the user, or a placeholder literal (`'anonymous'`, `'none'`, `'unknown'`, `'guest'`, `'default'`). If it can change for the same person, or it's a dummy string, it is wrong.

**For requests with no real owner** (no authenticated user, public endpoints, health checks): return `owner: undefined` for that request, or omit the `owner` key entirely. The SDK has its own anonymous bucket on the wire-format side. Never use a placeholder string:

```js
return {
  apiKey: sdk.mask(extractApiKey(req)),
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

`owner.enrich` is **required** and is the **only** channel for owner display info (`label`, `email`, any extras) - there are no inline `label` / `email` fields on `owner` anymore. A bare `owner.id` is an opaque identifier on the dashboard, so always wire `enrich`, resolving the metadata from the same owner entity you used for `id`. It runs once per id (the SDK caches by id), receives the id as its argument, and can also read the request via closure. Return fields flat.

Resolve `label` and `email` independently - they are per-field, not all-or-nothing. "Available" does not mean "already on the request": a field counts as available if it is on the request **or reachable with one more lookup** (following a reference like `project.owner` -> a User that holds the email, populating a relation, or a second query). That extra call is exactly what `enrich` being async and cached is for - it runs once per id. So if `label` is on the request but `email` lives on a referenced record, read `label` off the request and do the lookup for `email` - return both.

**Needs a lookup?** Reuse the project's own data-access pattern - read how the codebase queries that entity and mirror it, rather than inventing an ORM it doesn't use:

```js
owner: {
  id: workspace.id,
  enrich: async (id) => {
    const ws = await db.workspaces.findById(id);
    return { label: ws.name, email: ws.adminEmails };  // email: string or string[]
  },
}
```

**Already on the request?** Read it off the request inside `enrich` via the closure - there's no inline shortcut:

```js
owner: {
  id: req.user.workspaceId,
  enrich: async () => ({ label: req.user.workspaceName, email: req.user.email }),
}
```

**Mixed - some on the request, some not?** Read what's there and look up the rest. A common shape is a `label` on the request while the `email` hangs off a referenced record; resolve both rather than dropping the one that needs a call:

```js
owner: {
  id: String(project._id),
  enrich: async () => {
    const user = await User.findById(project.owner);  // one more call for the email
    return { label: project.name, email: user?.email };
  },
}
```

`enrich` failures are swallowed by the SDK and never break the request, so a best-effort real lookup is safe.

**No source for the metadata anywhere?** Still include `enrich`, but have it `return {}` - don't drop it, and don't invent a lookup against a store that doesn't exist.

`email` is what powers dashboard access grants. Confirming any of those emails on Restless pins this owner to that human.

### `extractApiKey`

Whatever the API uses for auth, extract the raw credential and pass it to `sdk.mask()`. Examples:

```js
// Bearer token
const auth = req.headers.authorization || '';
return auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

// Custom header
return req.headers['x-api-key'];

// Query param
return new URL(req.url, 'http://x').searchParams.get('api_key');
```

If the credential is missing, return `undefined`. Do NOT substitute a placeholder string: `sdk.mask()` handles `undefined`, but `sdk.mask('anonymous')` leaks `'mous'` as the mask tail.

## Setup - Express

Register BEFORE route definitions, but AFTER any middleware that attaches `req.user` / `req.session` / similar:

```js
const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(authMiddleware);  // sets req.user; must run first
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(extractApiKey(req)),
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
const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

await fastify.register(sdk.setup((req) => ({
  apiKey: sdk.mask(extractApiKey(req)),
  // req.user was populated by whatever onRequest auth hook ran first.
  owner: req.user ? {
    id: req.user.workspaceId,
    enrich: async (id) => {
      const ws = await db.workspaces.findById(id);
      return { label: ws.name, email: ws.adminEmails };
    },
  } : undefined,
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
const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(authMiddleware);  // attaches ctx.state.user
app.use(sdk.setup((ctx) => ({
  apiKey: sdk.mask(extractApiKey(ctx.request)),
  owner: ctx.state.user ? {
    id: ctx.state.user.workspaceId,
    enrich: async (id) => {
      const ws = await db.workspaces.findById(id);
      return { label: ws.name, email: ws.adminEmails };
    },
  } : undefined,
})));
```

## Rules (hard constraints for LLM installers)

- **Placement:** the middleware/plugin MUST be registered BEFORE the route definitions.
- **Shape:** the setup callback returns `{ apiKey, owner: { id, enrich } }`. `owner` is nested and holds only `id` plus the required `enrich`. There are no inline `label` / `email` fields on `owner`, no top-level `projectId`, no top-level `project`, and no top-level `enrich`. Anything else is wrong.
- **`owner.id` must be immutable.** Read the schema or model for the field you pick. If it could be edited by the user (email, username, display name), it is invalid.
- **Never use the API key, the masked API key, or any secret as `owner.id`.** If you cannot find a stable internal id, use the `'NEEDS_CONFIGURATION'` placeholder + `RESTLESS_OWNER_ID_TODO` marker comment shown above. The CLI handles it.
- **Never modify `package.json`, not the scripts, not the dependencies, nothing.** Adding `--env-file=.env` to the `start` script is a no. The user handles env loading their own way.
- **Never modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI, etc.). Your changes go in the server source file only.
- **Never install or suggest installing extra packages.** No `dotenv`, no adapters, nothing. `process.env.RESTLESS_KEY` is assumed to be available at runtime.
- **Never read `.env`, `.env.local`, or any credentials file.** This is non-negotiable.
- **Never read files inside `node_modules/`.** The SDK is a black box.
- **`sdk.mask()` gotcha:** always pass the raw value. If it's missing, `mask()` returns `undefined` and that is fine. Do NOT write `sdk.mask(value || 'anonymous')`: the string `'anonymous'` would get hashed and its last 4 characters (`mous`) would appear as the tail of every anonymous log's mask, defeating the purpose.
- **`.restless/settings.json` is read automatically by the SDK at startup.** You do NOT need to read it yourself, the SDK walks up from cwd to find it.
- **Obsolete fields:** `setupMode`, `apiId`, `email` (top-level), `project: { id, name }`, top-level `projectId`, top-level `enrich`, inline `owner.label` / `owner.email`, and `hooks.getUser` are all ignored. Use only the `{ apiKey, owner: { id, enrich } }` shape - all owner display info comes from `enrich`.

## Verify

1. `@restlessai/sdk` appears in `package.json` dependencies.
2. The middleware/plugin is registered in the server code with a `setup(cb)` callback.
3. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
