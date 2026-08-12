You need to **completely remove the Restless SDK** from this project's source code. The package (`{{sdkPackage}}`) has already been uninstalled from `{{manifest}}`, and the `.restless/` settings directory has been deleted - your job is to strip every reference out of the source so nothing is left dangling.

## Files that reference `{{sdkPackage}}`

{{files}}

## What to remove

For each file above (and anywhere else you find SDK code), remove:

1. **Imports / requires** of `{{sdkPackage}}`:
   - `import restless from '{{sdkPackage}}'`
   - `import { ... } from '{{sdkPackage}}'`
   - `const restless = require('{{sdkPackage}}')`
   - `const sdk = require('{{sdkPackage}}')(...)` (CJS factory-call form)

2. **Factory calls** that bind the SDK client (these may live a few lines below the import):
   - `const sdk = restless(...)` / `const sdk = restless(process.env.RESTLESS_KEY)` / etc.

3. **Middleware registration**:
   - `app.use(sdk.setup(...))`, `app.use(restless.setup(...))`
   - `fastify.register(sdk.setup(...))`, `await fastify.register(sdk.setup(...))`
   - Any other `.setup(...)` call wired into the framework

4. **Any other call sites** of SDK methods: `sdk.mask(...)`, `restless.mask(...)`, `sdk.upsertUser(...)`, etc. If a helper variable was defined purely to feed the SDK callback (e.g. `function getApiKey(req) { ... }` only used inside `sdk.setup(req => ({ apiKey: sdk.mask(getApiKey(req)) }))`), remove that helper too.

5. **The Next.js single-config integration**, if present:
   - In `next.config.*`: remove the `withRestless` import and UNWRAP the config export - `export default withRestless(nextConfig)` goes back to `export default nextConfig` (same for `module.exports` / function / async forms). Every other config option stays exactly as it is.
   - `restless.config.*` at the project root exists solely for the SDK: strip it to a minimal valid empty module (`export {}`).
   - Per-route wrapping, if any (`export const GET = wrap(getPets)` with `wrap` from a Restless client module): unwrap back to `export const GET = getPets;` and remove the shared client module's SDK code.

6. **Comments** that mention Restless, ReadMe, `{{sdkPackage}}`, `RESTLESS_KEY`, or the install steps left behind by `npx api init`.

## Rules

- **NEVER read, open, grep, or list `.env`, `.env.*`, or any environment / secret file.** The CLI cleans those up separately. Do not touch them under any circumstances.
- **NEVER read or scan {{neverRead}}.**
- Use the **Edit** tool to remove SDK code, one file at a time. Preserve surrounding code style, indentation, and formatting exactly.
- **Only remove SDK-related lines.** Do not refactor, rename, or "improve" surrounding code while you're in there.
- If removing the SDK leaves a now-unused import for an unrelated module (e.g. a `path` import that was only used to construct a Restless config path), remove that too. But do not remove imports that still have other valid uses.
- If a file's only purpose was SDK setup and removing the SDK code leaves it effectively empty, leave a minimal valid file in place (e.g. an empty `export {}` for ESM, or just an empty file). Do not delete the file from disk.
- If you encounter a reference that's already broken or commented out, remove it anyway - we want a clean slate.

When you're done, print one short sentence summarizing which files you edited. No long explanation, no diff dump.
