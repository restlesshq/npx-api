The Restless SDK is already wired into this {{language}} project that uses {{framework}}, but the `owner.id` field inside the setup callback is missing, set to the `'NEEDS_CONFIGURATION'` placeholder, or set to something insecure like a raw API key or auth header. Without a stable `owner.id`, every log rolls up as "anonymous" on the dashboard.

**Your only job** is to pick a stable, immutable identity expression and patch the existing managed SDK block. Do NOT re-install anything, do NOT touch other files.

**IMPORTANT: NEVER read .env, .env.local, .env.*, or any environment/secret files. NEVER read or scan {{neverRead}}.**

## What to do

1. **Find the file containing the SDK setup code.** Run `grep -rE "{{sdkPackage}}" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l` from the project root. The setup callback lives in one of two shapes:
   - Classic: a server file with `restless()` / `require('{{sdkPackage}}')()` plus an `sdk.setup((req) => ({ ... }))` registration.
   - Next.js single-config: a `restless.config.*` at the project root containing `defineConfig({ setup: async (req) => ({ ... }) })` (ignore `next.config.*` - it only wraps the build config and holds no owner).

   That's the only file you should edit.

2. **Look harder at the codebase for a stable, immutable identity field.** `owner.id` is the **permanent identifier the dashboard pins this customer's entire log history to**. Once a customer has produced any logs under one id, changing it fragments their history.

   **Decision procedure:**

   a. **Read the auth flow.** Find where the request gets a user / workspace / tenant attached (`req.user`, `req.workspace`, `ctx.state.user`, a JWT verification step, etc.). What entity is attached? Find its source of truth in this codebase: a database model, a TypeScript interface, a JSON fixture file, an in-memory `Map`, a JWT payload shape, whatever this project uses.

   b. **Pick the immutable id field on that entity.** Any one of these qualifies:
      - The field is named like an id: `id`, `_id`, `uuid`, `<entity>Id`, `pk`, or `sub` (JWT subject).
      - A schema declares it as a primary key.
      - The runtime value is a UUID, ObjectId-style hex string, integer pk, or stable slug. Check fixtures, mocks, JSON sample data.
      - The value is an object KEY (e.g. `Object.entries(records)[0][0]`, the keys of a JSON file, the keys of an in-memory `Map`). Object keys are stable by construction.

      Reject the candidate ONLY when the field is on the mutable list (`email`, `username`, `name`, `display_name`, `displayName`, `slug` used as a renameable handle, `handle`, `nickname`, `login`), or when the schema marks it updatable, or when code paths mutate it.

      If the entity has both `user.id` and `user.email`: always pick `id`. The email can be passed to `enrich` later. Lack of a formal Mongoose / Prisma model is NOT grounds to reject a candidate.

   c. **Match the API shape:**
      - **Tenant / workspace / org concept** (a `workspaces`, `orgs`, `teams`, or `accounts` table; a `companyId` JWT claim; an `X-Workspace-Id` header). Use that table's stable internal id. Multiple users on the same key all roll up under one owner.
      - **Per-user API** (one key per developer or end-user, no tenant): use the user record's stable internal id.

3. **HARD RULES:**
   - **Never put a raw API key, masked API key, password, token, or any other secret into `owner.id`.** The id leaves the user's machine on every request.
   - **Never use an email, username, or any user-editable field.** If it can change for the same customer, it is wrong.
   - **Never use a placeholder literal like `'anonymous'`, `'none'`, `'unknown'`, `'guest'`, or `'default'`.** These fake-group every unauth / unknown request under one tenant. When there's no real owner, return `undefined` (or omit `owner` for that request): `owner: req.user ? { id: req.user.workspaceId } : undefined,`
   - **If a previous run set `owner.id` (or legacy `project.id`) to something risky** (`req.headers.authorization`, `apiKey`, `'anonymous'`, `'NEEDS_CONFIGURATION'`, etc.), REPLACE it. Don't leave it.

4. **Patch the setup callback.** Add (or replace) the `owner: { id: <expr> },` line inside the setup callback's return object. The shape is:

   ```js
   sdk.setup((req) => ({
     apiKey: sdk.mask(<credential>),
     owner: { id: <your expression> },
   }))
   ```

   (Next.js single-config shape: the same return object inside `defineConfig({ setup: async (req) => ({ ... }) })`, with `apiKey: mask(<credential>)` - `mask` is a named import there.)

   If the file currently uses the legacy `project: { id: ... }` shape, rewrite the property name to `owner` while you're patching the expression.

   Do NOT change the `apiKey:` line. Do NOT change the SDK init line above (if there is one). Do NOT touch anything else in the file.

## Rules

- Only edit the file containing the SDK block. Do not modify {{manifest}}, .gitignore, tsconfig, Dockerfiles, or CI config.
- Do not install packages.
- Do not read .env or any file in node_modules.
- Keep your change minimal: just add or replace the `owner.id` line.
