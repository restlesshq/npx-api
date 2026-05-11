You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## What to do

1. **Find the server entry point.** Open the file where the framework is initialized (`express()`, `fastify()`, `new Hono()`, `createServer()`, etc.) and where routes are registered. That's where the SDK goes.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

3. **API key handling.** Always write `process.env.RESTLESS_KEY` as the argument in the SDK init line - the CLI replaces it with the canonical form (literal key, env-ref, or no-arg) after you finish, based on what the user picked. Don't reason about env loaders, don't install dotenv, don't modify package.json.

4. **Wire up user identification via `setup(cb)`.** Look at how this API authenticates its users (Authorization header, JWT, API key header, query param, etc.) and extract the credential inside the setup callback. The returned object MUST include `apiKey: restless.mask(<credential>)` at the top level - that's what identifies the user on the dashboard. Without it, every log shows up as "anonymous".

5. **Pick `project.id` carefully — it's the immutable, permanent identifier the dashboard uses to group every log this customer ever produces.** Walk this decision tree:

   a. Look for an existing tenant / workspace / org concept (e.g. `workspaces`, `orgs`, `teams`, `accounts` table; a `companyId` JWT claim; an `X-Workspace-Id` header). Use that table's stable internal id. Multiple users on the same key all roll up under one project.

   b. If the API is per-user (one key per developer or end-user, no tenant), use the **user's stable internal id** (UUID / integer PK / slug — whichever the user table uses). Do **not** use the email itself for `id` (emails change); pass `email` through `enrich` instead so the dashboard can grant access by confirmed email.

   c. **Last resort only** — if you genuinely cannot find any stable identity field, use the masked API key and emit a TODO comment so the user knows to fix it later:
   ```js
   // TODO: replace with a stable internal id (workspace, user, etc.).
   //       Using the key hash means rotating the key fragments log history.
   project: { id: restless.mask(extractApiKey(req)) }
   ```

   **HARD RULE: never put a raw API key, password, token, or any other secret into `project.id`.** The id leaves the user's machine and gets sent to Restless on every request. Secrets must not.

6. **Lazy enrichment (optional).** If resolving the customer/tenant info (email, label, company) requires a DB lookup or external call, put `enrich` **inside `project`**, never at the top level. The shape is `{ apiKey, project: { id, enrich: async (id) => ({ label, email, ... }) } }`. The SDK calls `enrich` only on the first request from each id, then caches by id. If the lookup is cheap (in-memory map, header read), skip `enrich` and just set `project.label` / `project.email` inline.

## Rules

- **NEVER read, open, or access .env, .env.local, .env.*, or any file containing secrets.** This is a hard requirement. The SDK loads `.env` itself at runtime - your wiring code does not need to.
- **NEVER read files inside node_modules/.** The guide above tells you everything you need to know.
- **DO NOT modify package.json.** This includes the `scripts` block (no adding `--env-file`, no changing `start` or `dev`), `dependencies`, `engines`, or anything else. The package is already installed. Do not touch this file.
- **DO NOT modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI configs, etc.). Your only edits should be to the server source file where the SDK middleware gets registered.
- **DO NOT install or suggest installing extra packages** (e.g. `dotenv`). The SDK already handles loading `RESTLESS_KEY` from `.env` at runtime.
- Register the middleware/plugin **BEFORE route definitions** so it captures all requests.
- Don't break existing imports, code structure, or formatting.
- Use `require()` style imports if the project uses CommonJS (no `"type": "module"` in package.json). Use `import` style if the project uses ESM.
- **Do NOT pass `apiId`, `setupMode`, `hooks.getUser`, or `hooks.beforeSend`** - these are from the OLD SDK API. The new SDK will ignore them.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it automatically at startup.
- **Do NOT substitute `|| 'anonymous'` inside `restless.mask()`.** If the value is missing, `mask()` returns `undefined` and the SDK handles it gracefully. Writing `restless.mask(key || 'anonymous')` would leak the fallback string's last 4 characters as the mask's tail.
- Keep changes minimal - just add the SDK setup, don't refactor anything else.
