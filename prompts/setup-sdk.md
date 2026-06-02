You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## What to do

0. **First, check if the SDK is already wired in WITH THE CURRENT API.** Grep for `require('@restlessai/sdk')` or `from '@restlessai/sdk'` in the user's source files (NOT in `node_modules/`). A file counts as correctly wired only if it has:
   - A **factory call**: `const sdk = require('@restlessai/sdk')(<arg>)` (CJS) or `const sdk = restless(<arg>)` after `import restless from '@restlessai/sdk'` (ESM). The binding `sdk` (or whatever name) holds the *result* of calling the factory.
   - A **`sdk.setup(cb)` call with EXACTLY ONE argument** (the callback), registered as middleware: `app.use(sdk.setup(cb))`, `await fastify.register(sdk.setup(cb))`, etc. Inside the callback, `apiKey: sdk.mask(...)` is returned.

   If all of the above is present, **stop and do nothing**. Print one short sentence confirming what you found, then end the run without any Edit/Write calls.

   **OLD-API trap.** If you find `restless.setup(app, cb)` or any other `.setup(<framework instance>, <callback>)` shape with TWO arguments, OR you find `import restless from '@restlessai/sdk'` followed by `restless.setup(...)` or `restless.mask(...)` with NO intervening factory call (`const sdk = restless(...)`), the file is on the OLD SDK API. **That is NOT correctly wired** even though the import is there - it will crash at runtime with `_sdk.default.setup is not a function`. Rewrite the call site:
   - Add a factory call right after the import: `const sdk = restless(process.env.RESTLESS_KEY);` (CJS: `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);`).
   - Drop the framework-instance argument from `.setup(...)`. The new `.setup(cb)` takes only the callback and returns middleware.
   - Wrap the returned middleware in `app.use(...)` (Express / Koa / Hono / Connect) or `fastify.register(...)` (Fastify).
   - Rename `restless.X(...)` to `sdk.X(...)` everywhere in the file (`restless.mask` → `sdk.mask`, etc.). `restless` is the factory; `sdk` is the client.

   If you find a partial reference (an import with no setup at all, a stale comment, a callback missing `apiKey:`), treat the file as not wired and proceed with the normal wiring flow.

1. **Find the server entry point.** Open the file where the framework is initialized (`express()`, `fastify()`, `new Hono()`, `createServer()`, etc.) and where routes are registered. That's where the SDK goes.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

3. **API key handling.** Always write `process.env.RESTLESS_KEY` as the argument in the SDK init line - the CLI replaces it with the canonical form (literal key, env-ref, or no-arg) after you finish, based on what the user picked. Don't reason about env loaders, don't install dotenv, don't modify package.json.

4. **Wire up the end-user `apiKey`.** Look at how this API authenticates its callers (Authorization header, JWT, API key header, query param, etc.) and extract the credential inside the setup callback. The returned object MUST include `apiKey: restless.mask(<credential>)` at the top level. Without it, every log shows up as "anonymous".

5. **Pick `owner.id` carefully. It is the permanent, immutable identifier the dashboard pins this customer's entire log history to.** Once a customer has produced any logs under one id, changing it fragments their history. This is the single most important thing to get right.

   **Decision procedure (follow in order, do NOT skip steps):**

   a. **Look at the auth flow first.** Read the file that handles authentication. Identify the entity that gets attached to the request (`req.user`, `req.workspace`, `ctx.state.user`, etc.). Find that entity's source of truth in this codebase: a database model, a TypeScript interface, a JSON fixture file, an in-memory `Map`, a JWT payload shape, an external auth provider's user shape, whatever this project uses. Some codebases have a formal schema; some don't. Both are fine.

   b. **Verify the candidate is immutable.** Any one of these is enough evidence:
      - The field is named like an id: `id`, `_id`, `uuid`, `<entity>Id`, `pk`, or `sub` (JWT subject).
      - A schema / model declares it as a primary key (Mongoose `new Schema`, Prisma `@id`, Drizzle, Sequelize, etc.).
      - The runtime value is a UUID, ObjectId-style hex string, integer pk, or deterministic slug used as a record key. Look at sample data in fixtures, mocks, or JSON files.
      - The value is an object KEY: `Object.entries(records)[0][0]`, the keys of an in-memory `Map`, the keys of a JSON file. Object keys are stable identifiers by construction.

      Reject the candidate ONLY when the field is on the mutable list (`email`, `username`, `name`, `display_name`, `displayName`, `slug` when used as a renameable handle, `handle`, `nickname`, `tenant_name`, `login`), or when the schema marks the column as updatable, or when code paths mutate it.

      If the entity has both an id and a mutable field (e.g. `user.id` and `user.email`): always pick `id`. Pass `email` to `enrich` instead.

      Lack of a formal Mongoose / Prisma model is NOT grounds to reject a candidate. A JSON-key id, a Map key, or a UUID literal are all valid.

   c. **Match the right entity to the API shape:**
      - **Multi-tenant SaaS** (workspaces / orgs / teams / accounts table; a `companyId` JWT claim; an `X-Workspace-Id` header): use the tenant's stable internal id. Multiple users on the same key all roll up under one owner.
      - **Per-user API** (one key per developer or end-user, no tenant): use the user record's stable internal id.
      - **Multiple keys per tenant** (test/prod/CI keys): use the tenant id. The keys roll up under one owner.

   d. **If you genuinely cannot find a stable internal id**, do NOT invent one and do NOT fall back to the API key, the masked API key, an email, or a username. Wire the SDK with this exact placeholder and marker comment so the CLI can interactively prompt the user:

   ```js
   owner: {
     // RESTLESS_OWNER_ID_TODO: I could not find a stable, immutable identifier
     // in this codebase's auth flow. The CLI will prompt the user to fill this in.
     id: 'NEEDS_CONFIGURATION',
   },
   ```

   The exact strings `RESTLESS_OWNER_ID_TODO` and `'NEEDS_CONFIGURATION'` are both required. The CLI greps for them after your run.

   **HARD RULE: never put a raw API key, masked API key, password, token, or any other secret into `owner.id`.** The id leaves the user's machine on every request.

   **HARD RULE: never use a placeholder literal like `'anonymous'`, `'none'`, `'unknown'`, `'guest'`, or `'default'` for `owner.id`.** Doing so groups every unauthenticated / unknown request under one fake tenant on the dashboard, masking the fact that those requests are actually anonymous. When there's no real owner for a request (no authenticated user, an `/auth/login` endpoint, a public health-check, etc.), return `owner: undefined`, or omit the `owner` key entirely:

   ```js
   // Correct: anonymous requests use undefined; the SDK groups them
   // properly on the dashboard's anonymous bucket.
   return {
     apiKey: restless.mask(extractApiKey(req)),
     owner: req.user ? { id: req.user.workspaceId } : undefined,
   };
   ```

6. **Owner shape.** The returned object is `{ apiKey, owner: { id, enrich?, label?, email? } }`. `owner` is nested. There is no top-level `projectId`; there is no top-level `project`; there is no top-level `enrich`. If you write any of those at the top level, the SDK will ignore them.

7. **Enrich the owner with display info. Do this - do not skip it.** A bare `owner.id` shows up on the dashboard as an opaque identifier. Adding a human-readable `label` (and `email` where available) is what makes logs legible and powers dashboard access grants. You have full read access to this codebase - use it. You already found the owner entity and its source of truth in step 5 (the model, the `req.user` / `req.workspace` shape, the JWT payload, the data store); resolve `label` and `email` from that same source. Follow in order:

   a. **If the fields are already on the request object**, set them inline on `owner` - do NOT use `enrich` for data you already hold; that would just be a slower way to read it:
   ```js
   owner: { id: req.user.workspaceId, label: req.user.workspaceName, email: req.user.email },
   ```

   b. **If resolving them needs a lookup** (the id is on the request but the name / email live in a DB, ORM, or external service), implement `enrich` with a REAL lookup, reusing the exact data-access pattern this project already uses elsewhere. Read how the codebase queries that entity (Prisma `prisma.workspace.findUnique`, Mongoose `Workspace.findById`, a knex query, an in-memory `Map`, a JSON fixture) and mirror it - do not invent an ORM the project doesn't use:
   ```js
   owner: {
     id: workspace.id,
     enrich: async (id) => {
       const ws = await prisma.workspace.findUnique({ where: { id } });
       return { label: ws.name, email: ws.adminEmails };  // flat fields; email: string or string[]
     },
   },
   ```
   `enrich` runs only on the first request per id, then caches - so the lookup cost is amortized, not per-request. If it throws, the SDK swallows the error and never breaks the request, so a best-effort real lookup is safe; you do not need defensive guards beyond what the surrounding code normally uses.

   c. **Only if you genuinely cannot find any source for owner metadata** in the codebase, leave `enrich` off (just `owner: { id }`) rather than inventing a lookup against a store that doesn't exist.

   Return **flat fields** from `enrich` (`{ label, email }`), never a nested object. Put `enrich` **inside `owner`**, never at the top level.

## Rules

- **NEVER read, open, or access .env, .env.local, .env.*, or any file containing secrets.** This is a hard requirement. The SDK loads `.env` itself at runtime - your wiring code does not need to.
- **NEVER read files inside node_modules/.** The guide above tells you everything you need to know.
- **DO NOT modify package.json.** This includes the `scripts` block (no adding `--env-file`, no changing `start` or `dev`), `dependencies`, `engines`, or anything else. The package is already installed. Do not touch this file.
- **DO NOT modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI configs, etc.). Your only edits should be to the server source file where the SDK middleware gets registered.
- **DO NOT install or suggest installing extra packages** (e.g. `dotenv`). The SDK already handles loading `RESTLESS_KEY` from `.env` at runtime.
- Register the middleware/plugin **BEFORE route definitions** so it captures all requests.
- Don't break existing imports, code structure, or formatting.
- Use `require()` style imports if the project uses CommonJS (no `"type": "module"` in package.json). Use `import` style if the project uses ESM.
- **`setup` takes EXACTLY ONE argument (the callback).** Never pass the framework instance as the first argument. `sdk.setup(app, cb)` is the OLD API and crashes at runtime. The new shape is `app.use(sdk.setup(cb))` / `fastify.register(sdk.setup(cb))` - the framework instance only appears in `app.use(...)` / `fastify.register(...)`, never inside `setup(...)`. This is true regardless of how surrounding code in the same file looks (e.g. `passport.use(app, ...)`, `sentryUtils.init(app)`); those are different libraries, do not mimic their shape.
- **`restless` is the factory, not the client.** After `import restless from '@restlessai/sdk'` you MUST call the factory to get a client: `const sdk = restless(process.env.RESTLESS_KEY);`. The methods `.setup` and `.mask` exist on the client (`sdk`), NOT on the factory (`restless`). Writing `restless.setup(...)` or `restless.mask(...)` directly is the OLD API and will fail with `_sdk.default.setup is not a function`.
- **Do NOT pass `apiId`, `setupMode`, `hooks.getUser`, `hooks.beforeSend`, top-level `projectId`, top-level `project`, or top-level `enrich`** - these are from the OLD SDK API. The new SDK will ignore them. Only `{ apiKey, owner: { id, enrich? } }` is valid.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it automatically at startup.
- **Do NOT substitute `|| 'anonymous'` inside `restless.mask()`.** If the value is missing, `mask()` returns `undefined` and the SDK handles it gracefully. Writing `restless.mask(key || 'anonymous')` would leak the fallback string's last 4 characters as the mask's tail.
- Keep changes minimal - just add the SDK setup, don't refactor anything else.
