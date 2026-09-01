You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

**The project's own source files are reproduced in this prompt (see below). Do not re-read them with the Read tool, and do not `ls` or `grep` to find them - you already have them. Reach for a tool only for a file that genuinely is not in this prompt. Every tool call costs the user several seconds of waiting.**

## What to do

0. **First, check if the SDK is already wired in WITH THE CURRENT API.** Grep for `require('@restlessai/sdk')` or `from '@restlessai/sdk'` in the user's source files (NOT in `node_modules/`). A file counts as correctly wired only if it has:
   - A **factory call**: `const sdk = require('@restlessai/sdk')(<arg>)` (CJS) or `const sdk = restless(<arg>)` after `import restless from '@restlessai/sdk'` (ESM). The binding `sdk` (or whatever name) holds the *result* of calling the factory.
   - A **`sdk.setup(cb)` call with EXACTLY ONE argument** (the callback), registered as middleware: `app.use(sdk.setup(cb))`, `await fastify.register(sdk.setup(cb))`, etc. Inside the callback, `apiKey: sdk.mask(...)` is returned.

   **Next.js has two additional "already wired" shapes**, either of which also counts as correctly wired:
   - The **single-config plugin wiring**: `withRestless` (imported from `@restlessai/sdk/next`) wrapping the exported config in `next.config.*`, AND a `restless.config.*` at the project root calling `defineConfig({ setup })` with `apiKey: mask(...)` in the callback.
   - The **manual per-route wiring**: a shared module calling the `@restlessai/sdk/next` factory plus route handlers wrapped with the resulting `wrap(...)`. If a project has this complete and working, leave it alone even if the guide below recommends the plugin style for new installs - it still works, and migrating it is not your job.

   If a complete wiring is present, **stop and do nothing**. Print one short sentence confirming what you found, then end the run without any Edit/Write calls.

   **OLD-API trap.** If you find `restless.setup(app, cb)` or any other `.setup(<framework instance>, <callback>)` shape with TWO arguments, OR you find `import restless from '@restlessai/sdk'` followed by `restless.setup(...)` or `restless.mask(...)` with NO intervening factory call (`const sdk = restless(...)`), the file is on the OLD SDK API. **That is NOT correctly wired** even though the import is there - it will crash at runtime with `_sdk.default.setup is not a function`. Rewrite the call site:
   - Add a factory call right after the import: `const sdk = restless(process.env.RESTLESS_KEY);` (CJS: `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);`).
   - Drop the framework-instance argument from `.setup(...)`. The new `.setup(cb)` takes only the callback and returns middleware.
   - Wrap the returned middleware in `app.use(...)` (Express / Koa / Hono / Connect) or `fastify.register(...)` (Fastify).
   - Rename `restless.X(...)` to `sdk.X(...)` everywhere in the file (`restless.mask` → `sdk.mask`, etc.). `restless` is the factory; `sdk` is the client.

   If you find a partial reference (an import with no setup at all, a stale comment, a callback missing `apiKey:`), treat the file as not wired and proceed with the normal wiring flow.

1. **Find the integration point - it depends on the framework.**

   **Next.js (App Router or Pages Router): do NOT look for a server entry point and do NOT register middleware.** Next has no `app.use(...)`. The integration style depends on the router:
   - **App Router (the default for modern Next):** use the **single-config integration** - wrap the exported config in `next.config.*` with `withRestless` (imported from `@restlessai/sdk/next`) and create `restless.config.*` at the project root with `defineConfig({ setup })`. Route files are NOT touched; a build-time loader wraps every `app/**/route.*` handler automatically. Follow the "Setup - Next.js (App Router)" section of the guide below exactly, including the lazy-import warning for `restless.config`.
   - **Pages Router (`pages/api/**`), or an App Router on a Next version the guide's support matrix excludes:** wrap route handlers manually with the `@restlessai/sdk/next` adapter - `client.setup(cb)` returns a handler-wrapper `(handler) => handler`. Put the client + wrapper in one shared module (e.g. `lib/restless.ts`), then wrap every exported handler (`export const GET = wrap(existingGetHandler);` on App Router, `export default wrap(handler);` on Pages Router).
   - **HARD RULE: never edit `middleware.ts` or `proxy.ts`** (Next 16 renamed `middleware` to `proxy`). Wiring the request-capturing SDK there crashes at runtime with `PageSignatureError` (E394) because Next middleware runs on the Edge runtime. If you find the SDK already (mis)wired into one of those files, REMOVE it and apply the correct integration instead.
   - Distinguish the routers: App Router uses `app/**/route.ts` with Web `Request`/`Response` on the Node runtime; Pages Router uses `pages/api/**` with `NextApiRequest`/`NextApiResponse`. `middleware.ts`/`proxy.ts` is neither - it is true Edge middleware and is off-limits.
   - If there are genuinely no route handlers, STOP - do not emit middleware as a fallback. Say so plainly and end the run.

   **Everything else (Express, Fastify, Koa, Hono, bare http):** open the file where the framework is initialized (`express()`, `fastify()`, `new Hono()`, `createServer()`, etc.) and where routes are registered. That's where the SDK middleware goes.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{sourceFiles}}

{{guide}}

3. **API key handling.** Always write `process.env.RESTLESS_KEY` as the argument in the SDK init line - the CLI replaces it with the canonical form (literal key, env-ref, or no-arg) after you finish, based on what the user picked. Don't reason about env loaders, don't install dotenv, don't modify package.json. (Exception: the Next.js App Router single-config integration has NO init line at all - never write `restless(process.env.RESTLESS_KEY)` there and never put a key in `next.config.*` or `restless.config.*`; the SDK reads `RESTLESS_KEY` from the environment by itself.)

4. **Wire up the end-user `apiKey`.** Look at how this API authenticates its callers (Authorization header, JWT, API key header, query param, etc.) and extract the credential inside the setup callback. The returned object MUST include `apiKey: sdk.mask(<credential>)` at the top level (`sdk` is the client - the factory's return value; `.mask` does not exist on the factory). Without it, every log shows up as "anonymous". (In the Next.js single-config integration, `mask` is a named export of `@restlessai/sdk/next` and is called bare: `apiKey: mask(<credential>)`.)

5. **Pick `owner.id` carefully. It is the permanent, immutable identifier the dashboard pins this customer's entire log history to.** Once a customer has produced any logs under one id, changing it fragments their history. This is the single most important thing to get right.

   **First, understand what an "owner" is - it is NOT necessarily a user.** The owner is the entity that *owns the API key* in this project's data model: whoever the traffic is attributed to and grouped under on the dashboard. Sometimes that's a user, but just as often it's a **workspace, project, team, organization, account, tenant, or service** - whatever this codebase's model says a key belongs to. Do not assume "user." Determine it from the data model: what does the credential actually map back to? The foreign key on the api-keys / tokens table, the `sub` of the JWT, the record an API-key row points at. **That record is the owner**, and its immutable primary key is `owner.id`. Represent the project's real ownership model - if keys belong to projects, the owner is the project, not the user who happened to create it.

   **Decision procedure (follow in order, do NOT skip steps):**

   a. **Trace the credential to the entity that owns it.** Read the file that handles authentication and follow the key/token to the record it resolves to - not just the entity attached to the request (`req.user`, `req.workspace`, `req.account`, `ctx.state.*`, a JWT claim), but the thing that *owns the key*. If a key belongs to a project or org that a user is merely a member of, the owner is that project/org. Find that entity's source of truth in this codebase: a database model, a TypeScript interface, a JSON fixture file, an in-memory `Map`, a JWT payload shape, an external auth provider's shape, whatever this project uses. Some codebases have a formal schema; some don't. Both are fine.

      **Resolve the owner from the credential, NOT from request state a later middleware attaches (Express / Koa / bare http).** Because the SDK is registered before the auth guard (see the ordering rule below), the setup callback fires *before* that guard runs, so `req.user` / `req.account` / `ctx.state.*` are not populated yet - reading them would leave every request without an owner. Instead do the same lookup the auth middleware does, from inside the callback: take the raw credential and resolve the owning record yourself (the callback is async, so a DB/store lookup is fine). This is what lets the SDK attribute authenticated requests *and* still log the rejected ones. (Fastify is the exception: its `preHandler` runs after the `onRequest` auth hook, so `req.user` there is already populated - reading it is fine.)

   b. **Verify the candidate is immutable.** Any one of these is enough evidence:
      - The field is named like an id: `id`, `_id`, `uuid`, `<entity>Id`, `pk`, or `sub` (JWT subject).
      - A schema / model declares it as a primary key (Mongoose `new Schema`, Prisma `@id`, Drizzle, Sequelize, etc.).
      - The runtime value is a UUID, ObjectId-style hex string, integer pk, or deterministic slug used as a record key. Look at sample data in fixtures, mocks, or JSON files.
      - The value is an object KEY: `Object.entries(records)[0][0]`, the keys of an in-memory `Map`, the keys of a JSON file. Object keys are stable identifiers by construction.

      Reject the candidate ONLY when the field is on the mutable list (`email`, `username`, `name`, `display_name`, `displayName`, `slug` when used as a renameable handle, `handle`, `nickname`, `tenant_name`, `login`), or when the schema marks the column as updatable, or when code paths mutate it.

      If the entity has both an id and a mutable field (e.g. `user.id` and `user.email`): always pick `id`. Resolve `email` inside `enrich` instead.

      Lack of a formal Mongoose / Prisma model is NOT grounds to reject a candidate. A JSON-key id, a Map key, or a UUID literal are all valid.

   c. **Match the right entity to the API shape** (the owner is the entity the key belongs to, which differs by app):
      - **Multi-tenant SaaS** (workspaces / orgs / teams / accounts table; a `companyId` JWT claim; an `X-Workspace-Id` header): use the tenant's stable internal id. Multiple users on the same key all roll up under one owner.
      - **Key owned by a project / group / service** (the api-keys table has a `projectId` / `groupId` / `serviceId` foreign key; a user creates keys but they belong to the project): use the project/group/service id, NOT the user who created it.
      - **Per-user API** (one key per developer or end-user, no tenant): use the user record's stable internal id.
      - **Multiple keys per owner** (test/prod/CI keys for the same tenant or project): use the owning entity's id. The keys roll up under one owner.

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
     apiKey: sdk.mask(extractApiKey(req)),
     owner: req.user
       ? { id: req.user.workspaceId, enrich: async (id) => ({ label: req.user.workspaceName }) }
       : undefined,
   };
   ```

6. **Owner shape.** The returned object is `{ apiKey, owner: { id, enrich } }`. `owner` is nested and holds exactly two things: the immutable `id` and the required `enrich` function. There are NO inline `label` / `email` fields on `owner` anymore, and no arbitrary extra keys - all display info comes back from `enrich`. There is no top-level `projectId`, no top-level `project`, and no top-level `enrich`. If you write inline `label` / `email` on `owner`, or any of those fields at the top level, the SDK ignores them.

7. **Always wire `owner.enrich`. It is required and it is the only channel for display info - do not skip it.** A bare `owner.id` shows up on the dashboard as an opaque identifier. `enrich` resolves the human-readable `label` AND `email`, which is what makes logs legible and powers dashboard access grants. You have full read access to this codebase - use it. You already found the owner entity and its source of truth in step 5 (the model, the `req.user` / `req.workspace` shape, the JWT payload, the data store); resolve `label` and `email` from that same source. `enrich` receives the owner `id` as its argument and can also read the request via closure.

   **Resolve `label` and `email` independently - they are per-field, not all-or-nothing.** "Available" does NOT mean "already sitting on the request object." A field is available if it is on the request **OR reachable with one more lookup** from the owner entity - following a reference (e.g. `project.owner` -> a User record that holds the email), populating a relation, or a second query against a table this codebase already queries. This is exactly why `enrich` is async and cached: the extra DB call is expected, it runs once per id, and its cost is amortized. So if `label` is right there on the request but `email` requires following a reference or a second query, do BOTH - read `label` off the request and do the lookup for `email`. Do not drop `email` just because it was not on the same object as `label`, and do not delete an ORM/db import you added because one field happened to be free. Only treat a field as genuinely unavailable after you have looked for a reachable source and found none.

   Follow in order:

   a. **If resolving a field needs a lookup** (the id is on the request but the name / email live in a DB, ORM, or external service), implement `enrich` with a REAL lookup, reusing the exact data-access pattern this project already uses elsewhere. Read how the codebase queries that entity (Prisma `prisma.workspace.findUnique`, Mongoose `Workspace.findById`, a knex query, an in-memory `Map`, a JSON fixture) and mirror it - do not invent an ORM the project doesn't use:
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

   b. **If the display fields are already on the request object**, you still return them from `enrich` (it is the only channel now) - read them off the request via the callback closure rather than a lookup:
   ```js
   owner: {
     id: req.user.workspaceId,
     enrich: async () => ({ label: req.user.workspaceName, email: req.user.email }),
   },
   ```
   Note `enrich` is cached per id, so it captures the first request's values - fine for stable display info like a name or contact email.

   **Mixed case (common): some fields are on the request, others are not.** Read the ones that are off the request, and do a lookup for the rest - do not silently drop them. The frequent shape is a `label` that lives on the request (or owner entity) while the `email` hangs off a referenced record (`project.owner` -> User, an `account.billingContactId`, a members table). Resolve both:
   ```js
   owner: {
     id: String(project._id),
     enrich: async () => {
       const user = await User.findById(project.owner);   // one more call for the email
       return { label: project.name, email: user?.email };
     },
   },
   ```

   c. **Only if you genuinely cannot find ANY source for owner metadata** in the codebase, still include `enrich` but have it `return {}` - do NOT invent a lookup against a store that doesn't exist, and do NOT drop `enrich` entirely.

   Return **flat fields** from `enrich` (`{ label, email }`), never a nested object. Put `enrich` **inside `owner`**, never at the top level.

## Rules

- **NEVER read, open, or access .env, .env.local, .env.*, or any file containing secrets.** This is a hard requirement. The SDK loads `.env` itself at runtime - your wiring code does not need to.
- **NEVER read files inside node_modules/.** The guide above tells you everything you need to know.
- **DO NOT modify package.json.** This includes the `scripts` block (no adding `--env-file`, no changing `start` or `dev`), `dependencies`, `engines`, or anything else. The package is already installed. Do not touch this file.
- **DO NOT modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI configs, etc.). Your only edits should be to the server source file where the SDK middleware gets registered. The ONE exception: the Next.js App Router single-config integration requires editing `next.config.*` (wrapping its export with `withRestless`) and creating `restless.config.*` - those two files, nothing else.
- **DO NOT install or suggest installing extra packages** (e.g. `dotenv`). The SDK already handles loading `RESTLESS_KEY` from `.env` at runtime.
- **Register the SDK middleware as early as possible - before ANY middleware that can reject or short-circuit a request, not just before the route definitions.** The SDK must observe *every* request, including ones that never reach a route handler. Auth guards, API-key checks, rate limiters, and CORS blockers all respond (`res.status(...).json(...)`, `throw`, etc.) and `return` **without calling `next()`**, so anything registered after them never runs for a rejected request - and a rejected request (a `401`/`403`/`429`) is exactly the kind of failure Restless exists to surface. Concretely: put `app.use(sdk.setup(cb))` immediately after body parsing (`express.json()` / equivalent) and **above** the auth / rate-limit middleware and the routes. A common and silent mistake is to drop it in "before the routes" but *after* an auth guard - that guard swallows every unauthenticated request's 401 before the SDK can see it. If the file already has an auth/guard `app.use(...)` before where you'd add the SDK, move the SDK above it. (Next.js is the exception - there is no middleware registration; use `withRestless` + `restless.config` on the App Router, wrap route handlers with `@restlessai/sdk/next` on the Pages Router, and never touch `middleware.ts` / `proxy.ts`.)
- Don't break existing imports, code structure, or formatting.
- Use `require()` style imports if the project uses CommonJS (no `"type": "module"` in package.json). Use `import` style if the project uses ESM.
- **`setup` takes EXACTLY ONE argument (the callback).** Never pass the framework instance as the first argument. `sdk.setup(app, cb)` is the OLD API and crashes at runtime. The new shape is `app.use(sdk.setup(cb))` / `fastify.register(sdk.setup(cb))` - the framework instance only appears in `app.use(...)` / `fastify.register(...)`, never inside `setup(...)`. This is true regardless of how surrounding code in the same file looks (e.g. `passport.use(app, ...)`, `sentryUtils.init(app)`); those are different libraries, do not mimic their shape.
- **`restless` is the factory, not the client.** After `import restless from '@restlessai/sdk'` you MUST call the factory to get a client: `const sdk = restless(process.env.RESTLESS_KEY);`. The methods `.setup` and `.mask` exist on the client (`sdk`), NOT on the factory (`restless`). Writing `restless.setup(...)` or `restless.mask(...)` directly is the OLD API and will fail with `_sdk.default.setup is not a function`.
- **Do NOT pass `apiId`, `setupMode`, `hooks.getUser`, `hooks.beforeSend`, top-level `projectId`, top-level `project`, or top-level `enrich`** - these are from the OLD SDK API. The new SDK will ignore them. **Do NOT put inline `label` / `email` (or any extra keys) on `owner`** - those are gone too; resolve them inside `enrich`. Only `{ apiKey, owner: { id, enrich } }` is valid.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it automatically at startup.
- **`.restless/` is source and belongs in the repo.** It holds the API spec and the settings the SDK reads at startup, so a teammate or CI without it gets a differently-configured SDK. Never add it to `.gitignore` or otherwise exclude it, and if you commit work for the user, include `.restless/` in that commit. It contains no secrets - the key lives in `.env`, which stays out of git.
- **Do NOT substitute `|| 'anonymous'` inside `sdk.mask()`.** If the value is missing, `mask()` returns `undefined` and the SDK handles it gracefully. Writing `sdk.mask(key || 'anonymous')` would leak the fallback string's last 4 characters as the mask's tail.
- Keep changes minimal - just add the SDK setup, don't refactor anything else.
- **Apply the wiring in ONE Edit call per file, and write no prose.** Nobody reads your explanation: the CLI verifies the result by re-reading the file itself, and then runs its own review pass. Every sentence you write and every extra Edit round trip is time the user spends watching a spinner. When you're done, stop - no summary, no recap of what you changed, no bullet list. (The one exception is step 0's "already wired" case, which wants a single short sentence and no edits.)
