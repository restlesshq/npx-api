A previous install pass left this {{language}} project ({{framework}}) wired against the **OLD** Restless SDK API. The new SDK API is different in shape, and the current call site will crash at runtime with `TypeError: _sdk.default.setup is not a function`.

**Your only job** is to rewrite the call site to the new factory pattern. Do NOT re-install anything, do NOT touch other files, do NOT modify the setup callback's logic (apiKey, owner, mask, etc. stay the same).

**IMPORTANT: NEVER read .env, .env.local, .env.*, or any environment/secret files. NEVER read files inside node_modules/.**

## What the old API looks like (the bug)

```js
import restless from '@restlessai/sdk';
// ...
restless.setup(app, (req) => ({
  apiKey: restless.mask(req.headers.authorization),
  owner: { id: req.user.workspaceId },
}));
```

Two telltale signs:
- `restless.setup(<framework instance>, <callback>)` takes **two** arguments. New API takes ONE.
- There's no factory call. `restless` is used directly as if it were a client. New API requires `const sdk = restless(KEY)` first.

## What to rewrite it to (the fix)

```js
import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);
// ...
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers.authorization),
  owner: { id: req.user.workspaceId },
})));
```

Three changes:
1. **Add a factory call** right after the import: `const sdk = restless(process.env.RESTLESS_KEY);`. (CommonJS equivalent: `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);`.) Always write `process.env.RESTLESS_KEY` as the argument; the CLI replaces it with the canonical form afterwards.
2. **Drop the framework-instance argument** from `setup(...)`. The new `setup(cb)` takes only the callback and **returns middleware**. Wrap that return value in `app.use(...)` (Express / Koa / Hono / Connect) or `fastify.register(...)` (Fastify).
3. **Replace `restless.X(...)` with `sdk.X(...)`** everywhere inside the callback (and anywhere else in the file). `restless` is the factory; `sdk` is the client. `restless.mask` is undefined; `sdk.mask` is what you want.

## What to do

1. **Find the file with the SDK setup code.** Run `grep -rE "@restlessai/sdk" --include="*.js" --include="*.ts" --include="*.mjs" --include="*.cjs" -l` from the project root. There will be one server file with `restless.setup(app, ...)` (or `sdk.setup(app, ...)`). That's the only file you should edit.

2. **Locate the call site.** Find the `.setup(` call with two top-level arguments.

3. **Apply the three changes above using Edit.** Keep the callback's body verbatim (apiKey extraction, owner shape, redact options, all of it). The only edits are: insert the factory line, drop the first arg of setup, wrap in app.use / fastify.register, rename `restless.X` to `sdk.X` inside the callback.

4. **Framework registration:**
   - Express, Koa, Hono, Connect: `app.use(sdk.setup(cb))`.
   - Fastify: `await fastify.register(sdk.setup(cb))`.
   - Bare Node http: `http.createServer(sdk.setup(cb)(handler))`.

## Rules

- Only edit the file with the SDK call site. Do not modify package.json, .gitignore, tsconfig, Dockerfile, or CI configs.
- Do not install packages.
- Do not read .env or any file in node_modules.
- Preserve the callback's logic exactly. Do not change `apiKey:`, `owner:`, `enrich:`, or any other field the callback returns.
- Preserve all surrounding imports.
- If the file already has the new factory pattern AND a two-arg setup somewhere unrelated to the SDK (e.g. a `passport.use(app, strategy)` line), leave that other call alone; you're only fixing the `@restlessai/sdk` call site.
