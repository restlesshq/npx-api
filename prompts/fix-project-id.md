The Restless SDK is already wired into this {{language}} project that uses {{framework}}, but the `project.id` field inside the setup callback is missing (or is set to something insecure like a raw API key or auth header). Without a stable `project.id`, every log rolls up as "anonymous" on the dashboard.

**Your only job** is to pick a stable identity expression and patch the existing managed SDK block. Do NOT re-install anything, do NOT touch other files.

**IMPORTANT: NEVER read .env, .env.local, .env.*, or any environment/secret files. NEVER read files inside node_modules/.**

## What to do

1. **Find the file containing the SDK setup code.** Run `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l` from the project root. There will be one server file with `restless()` / `require('@restlessai/sdk')()` plus an `sdk.setup((req) => ({ ... }))` registration. That's the only file you should edit.

2. **Look harder at the codebase for a stable identity field.** Walk this decision tree:

   a. **Tenant / workspace / org concept** (a `workspaces`, `orgs`, `teams`, or `accounts` table; a `companyId` JWT claim; an `X-Workspace-Id` header). Use that table's stable internal id. Multiple users on the same key all roll up under one project.

   b. **Per-user API** (one key per developer or end-user, no tenant): use the user's stable internal id (UUID / integer PK / slug, whichever the user table uses). Do NOT use the email itself for `id` (emails change); pass `email` through `enrich` if it's needed.

   c. **Last resort only** - if you genuinely cannot find any stable identity field, use the masked API key and leave a TODO so the user knows to fix it later:
   ```js
   // TODO: replace with a stable internal id (workspace, user, etc.).
   //       Using the key hash means rotating the key fragments log history.
   project: { id: restless.mask(extractApiKey(req)) }
   ```

   **HARD RULE: never put a raw API key, password, token, or any other secret into `project.id`.** The id leaves the user's machine and is sent to Restless on every request. Secrets must not. If a previous run set `project.id` to something like `req.headers.authorization`, REPLACE it - don't leave it.

3. **Patch the setup callback.** Add (or replace) the `project: { id: <expr> },` line inside the setup callback's return object. The shape is:

   ```js
   sdk.setup((req) => ({
     apiKey: sdk.mask(<credential>),
     project: { id: <your expression> },
   }))
   ```

   Do NOT change the `apiKey:` line. Do NOT change the SDK init line above. Do NOT touch anything else in the file.

## Rules

- Only edit the file containing the SDK block. Do not modify package.json, .gitignore, tsconfig, Dockerfiles, or CI config.
- Do not install packages.
- Do not read .env or any file in node_modules.
- Keep your change minimal - just add or replace the `project.id` line.
