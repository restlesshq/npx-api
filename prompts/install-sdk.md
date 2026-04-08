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
2. Add the import for the SDK
3. Add the middleware/plugin registration using the setup code from the guide above
4. The API key should be read from `process.env.README_API_KEY` (or equivalent for the language)
5. For the `apiId`, read it from `.api/settings.json` — look at the `apis[0].id` field

Make sure to:
- Place the middleware BEFORE route definitions so it captures all requests
- Don't break existing imports or code structure
- Use the right adapter for the framework (Express, Fastify, etc.)
