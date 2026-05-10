Install and set up the SDK package for this {{language}} project.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## Step 1: Install the package

Figure out the right location:
- Look for a monorepo structure (workspaces, lerna, turborepo, nx). If this is a monorepo, install in the correct package - the one that contains the API routes, not the root.
- Check for a `packages/` or `apps/` directory structure.
- Look at where existing dependencies are installed (which `package.json`, `requirements.txt`, `Gemfile`, `go.mod`, etc. is closest to the API code).
- Run the install command from that directory, not necessarily the project root.

## Step 2: Wire up the SDK in the code

After installing, set up the SDK in the actual server code:

1. **Find where the server is created and routes are registered.** Don't assume it's in any particular file - search the codebase for where the framework is initialized and where routes are added. That's where the middleware goes.
2. Add the import for the SDK (use the right adapter for the framework - Express, Fastify, etc.)
3. Add the middleware/plugin registration BEFORE route definitions
4. The API key is read automatically by the SDK from `process.env.RESTLESS_KEY` (or the language equivalent). Do NOT pass it explicitly.
5. Do NOT read `.restless/settings.json` manually - the SDK reads it automatically at startup.
