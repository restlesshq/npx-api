Install and set up the SDK for this {{language}} project. Follow this installation guide:

{{guide}}

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## Step 1: Install the package

Before installing, figure out the right location:
- Look for a monorepo structure (workspaces, lerna, turborepo, nx). If this is a monorepo, install in the correct package — the one that contains the API routes, not the root.
- Check for a `packages/` or `apps/` directory structure.
- Look at where existing dependencies are installed (which `package.json`, `requirements.txt`, `Gemfile`, `go.mod`, etc. is closest to the API code).
- Run the install command from that directory, not necessarily the project root.

## Step 2: Wire up the SDK in the code

After installing, you MUST also set up the SDK in the actual server code:

1. **Find where the server is created and routes are registered.** Don't assume it's in any particular file — search the codebase for where the framework is initialized (e.g. `fastify()`, `express()`, `createServer()`, `new Hono()`, etc.) and where routes are added. That's where the middleware goes.
2. Add the import for the SDK. Always use the unified entry `@restlessai/sdk`; it auto-detects the framework at runtime. Do NOT use framework-specific subpaths like `@restlessai/sdk/express` or `@restlessai/sdk/fastify`.
3. Add the middleware/plugin registration using the setup code from the guide above.
4. The API key is read automatically by the SDK from `process.env.RESTLESS_KEY`. You do NOT need to pass it explicitly — the factory takes it as an argument and falls back to the env var.
5. Look at how this API authenticates its users (Authorization header, JWT, X-API-Key header, query param, etc.) and extract that credential inside the setup callback. Run it through `restless.mask(...)` before logging.

Make sure to:
- Place the middleware BEFORE route definitions so it captures all requests.
- Don't break existing imports or code structure.
- **Do NOT pass `apiId`, `setupMode`, `hooks.getUser`, or `hooks.beforeSend`** — those are from the OLD SDK API. The new SDK will ignore them.
- **Do NOT read `.api/settings.json` manually.** The SDK reads it automatically at startup.
- **Do NOT substitute `|| 'anonymous'` inside `restless.mask(...)`.** If the value is missing, `mask()` returns `undefined` and the SDK handles it. Writing `restless.mask(key || 'anonymous')` would leak the fallback string's last 4 characters as the mask's tail.
