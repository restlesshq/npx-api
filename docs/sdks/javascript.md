# JavaScript SDK Installation

Full reference: the `install.md` file at the root of the `@restlessai/sdk` package. Consult that if anything below is ambiguous.

## Install

```bash
npm install @restlessai/sdk --save
```

## Setup

The single entry point `@restlessai/sdk` auto-detects the framework at runtime (Express, Fastify, Koa, Hono, Next, bare http) from the call signature. Use it for every framework. Do NOT import a framework-specific subpath like `@restlessai/sdk/fastify`. The same `require('@restlessai/sdk')(process.env.RESTLESS_KEY)` line works everywhere; only the registration pattern differs per framework.

## Setup — Express

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

**If the credential is missing, return `undefined`** — do NOT substitute a string like `'anonymous'`. `restless.mask()` handles `undefined` gracefully; substituting a placeholder would cause its last 4 characters to leak as the mask's tail.

### Project details (inline)

If the tenant/org info is cheap to read from the request itself (a header, a JWT claim), set it inline under `project`:

```js
app.use(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
  project: {
    id:    req.headers['x-tenant-id'],   // stable identifier — also the enrich cache key
    label: req.headers['x-tenant-name'], // display name on the dashboard
    email: req.headers['x-tenant-email'],// string OR string[]
  },
})));
```

### Project details (lazy `enrich`)

If resolving the project requires a DB hit or external call, put that lookup inside `project.enrich`. The SDK caches by `project.id` — `enrich` only runs on the first request from each id, then its result is reused.

```js
app.use(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
  project: {
    id: extractTenantId(req),
    enrich: async (id) => {
      const org = await db.orgs.findById(id);
      return {
        label: org.name,
        email: org.contactEmail,  // string OR string[]
        // any extra fields are preserved on the log
      };
    },
  },
})));
```

**Shape rules for the LLM installer:**
- `enrich` lives **inside `project`**, never at the top level of the setup result.
- `enrich` returns the project fields **flat** (`{ label, email, ... }`), not nested under another `project` key.
- `enrich` requires `project.id` to be set — that's the cache key. Without an id, the SDK skips `enrich` entirely and only uses the inline fields.
- If there's no tenant concept at all (every request is just a per-user API key), skip `enrich` and set `project.label` / `project.email` inline, or omit `project` entirely.

## Setup — Fastify

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

await fastify.register(restless.setup((req) => ({
  apiKey: restless.mask(extractApiKey(req)),
})));
```

## Setup — Koa

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(restless.setup((ctx) => ({
  apiKey: restless.mask(extractApiKey(ctx.request)),
})));
```

## Rules (hard constraints for LLM installers)

- **Placement:** the middleware/plugin MUST be registered BEFORE the route definitions.
- **Never modify `package.json` — not the scripts, not the dependencies, nothing.** Adding `--env-file=.env` to the `start` script is a no. The user handles env loading their own way.
- **Never modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI, etc.). Your changes go in the server source file only.
- **Never install or suggest installing extra packages.** No `dotenv`, no adapters, nothing. `process.env.RESTLESS_KEY` is assumed to be available at runtime.
- **Never read `.env`, `.env.local`, or any credentials file.** This is non-negotiable.
- **Never read files inside `node_modules/`.** The SDK is a black box.
- **`restless.mask()` gotcha:** always pass the raw value. If it's missing, `mask()` returns `undefined` — that's fine. **Do NOT write `restless.mask(value || 'anonymous')`** — the string `'anonymous'` would get hashed and its last 4 characters (`mous`) would appear as the tail of every anonymous log's mask, defeating the purpose.
- **`.api/settings.json` is read automatically by the SDK at startup.** You do NOT need to read it yourself — the SDK walks up from cwd to find it.
- **`setupMode`, `apiId`, `email` (top-level), `project: { id, name }`, and `hooks.getUser` are OBSOLETE.** The old SDK used them. The new SDK uses `restless.setup(cb)` with `apiKey` / `projectId` / `enrich` — do NOT pass any of the old fields.

## Verify

1. `@restlessai/sdk` appears in `package.json` dependencies.
2. The middleware/plugin is registered in the server code with a `setup(cb)` callback.
3. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
