You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## What to do

1. **Find the server entry point.** Open the file where the framework is initialized (`express()`, `fastify()`, `new Hono()`, `createServer()`, etc.) and where routes are registered. That's where the SDK goes.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

3. **The API key comes from the environment.** The SDK auto-reads `process.env.RESTLESS_KEY` — you do NOT need to pass it explicitly.

4. **Wire up user identification via `setup(cb)`.** Look at how this API authenticates its users (Authorization header, JWT, API key header, query param, etc.) and extract the credential inside the setup callback. Run it through `restless.mask()` before logging — that's what identifies the user on the dashboard without exposing the plaintext secret.

5. **Lazy enrichment (optional).** If resolving the user's full info (email, label, company) requires a DB lookup or external call, put that code inside an `enrich: async () => { ... }` function on the SetupResult. The SDK only runs `enrich` on the first request from each user; subsequent requests skip it entirely. This is way better than running a DB query on every request.

## Rules

- **NEVER read, open, or access .env, .env.local, .env.*, or any file containing secrets.** This is a hard requirement.
- **NEVER read files inside node_modules/.** The guide above tells you everything you need to know.
- **DO NOT modify package.json.** This includes the `scripts` block (no adding `--env-file`, no changing `start` or `dev`), `dependencies`, `engines`, or anything else. The package is already installed. Do not touch this file.
- **DO NOT modify any other config file** (`tsconfig.json`, `.gitignore`, `Dockerfile`, CI configs, etc.). Your only edits should be to the server source file where the SDK middleware gets registered.
- **DO NOT install or suggest installing extra packages** (e.g. `dotenv`). The user's environment already provides `RESTLESS_KEY` by the time the server runs — assume `process.env.RESTLESS_KEY` is available.
- Register the middleware/plugin **BEFORE route definitions** so it captures all requests.
- Don't break existing imports, code structure, or formatting.
- Use `require()` style imports if the project uses CommonJS (no `"type": "module"` in package.json). Use `import` style if the project uses ESM.
- **Do NOT pass `apiId`, `setupMode`, `hooks.getUser`, or `hooks.beforeSend`** — these are from the OLD SDK API. The new SDK will ignore them.
- **Do NOT read `.api/settings.json` manually.** The SDK reads it automatically at startup.
- **Do NOT substitute `|| 'anonymous'` inside `restless.mask()`.** If the value is missing, `mask()` returns `undefined` and the SDK handles it gracefully. Writing `restless.mask(key || 'anonymous')` would leak the fallback string's last 4 characters as the mask's tail.
- Keep changes minimal — just add the SDK setup, don't refactor anything else.
