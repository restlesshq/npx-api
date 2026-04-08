You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## What to do

1. **Find where the server is created and routes are registered.** Don't assume any particular file — search the codebase for where {{framework}} is initialized (look for things like `fastify()`, `express()`, `createServer()`, `new Hono()`, etc.) and where routes are defined. That's where the middleware needs to go.

2. **Add the SDK setup code BEFORE any route definitions.** Here's the pattern to follow:

{{guide}}

3. **Read the API UUID from `.api/settings.json`** — the `apis[0].id` field. Use `fs.readFileSync` (or equivalent) to read it at startup.

4. **The API key comes from the environment** — `process.env.README_API_KEY`. The SDK reads this automatically, so you don't need to pass it explicitly.

5a. **Add `setupMode`** — pass `setupMode: process.env.README_SETUP_MODE === '1'` in the config. This makes the SDK flush logs immediately during setup instead of batching them.

5. **Wire up user identification.** The SDK accepts a `hooks.getUser` function that resolves the API consumer from the incoming request. Look at how this API currently authenticates its consumers (API keys, JWTs, session tokens, etc.) and write a `getUser` hook that extracts the user identity from the request. The hook should return an object with fields like `apiKey`, `email`, `label`, or `company` — whatever is available. If the API already has auth middleware or a user lookup, reuse that. The guide above shows the general pattern.

## Rules
- **NEVER read, open, or access .env, .env.local, .env.*, or any file containing secrets/credentials. This is a hard requirement — not a suggestion. Do not read these files for any reason, including "to check what's there."**
- **NEVER read files inside node_modules/. The guide above already tells you everything you need to know about the SDK. Do not explore the SDK source code.**
- Place the middleware/plugin registration BEFORE route definitions so it captures all requests
- Don't break existing imports, code structure, or formatting
- Use `require()` style imports if the project uses CommonJS (no `"type": "module"` in package.json)
- Use `import` style if the project uses ESM
- Keep the changes minimal — just add the SDK setup, don't refactor anything else
