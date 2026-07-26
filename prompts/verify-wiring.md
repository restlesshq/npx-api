Read the file where the Restless SDK is wired in and answer a short checklist about it. This is a review pass: **do not edit anything.** Report only.

File: {{sourceFile}}
Framework: {{framework}}

Read that file (and any file it registers middleware from, if the answer isn't clear from the entry file alone). Do NOT read `.env` files or anything in `node_modules/`.

Answer each check:

1. **order** - Is `sdk.setup(...)` registered BEFORE every middleware that can reject or short-circuit a request? Auth guards, API-key checks, rate limiters, and CORS blockers respond and return without calling `next()`, so anything registered after them never runs for a rejected request - and a rejected request (a 401/403/429) is exactly what Restless needs to see. "Before the routes" is NOT sufficient on its own. Fail this if any such middleware is registered above the SDK.

2. **mounted** - Is it registered on the app/router that actually serves the API's routes? Fail if it's attached to a router that is never mounted, or to a different app than the one the routes hang off.

3. **credential** - Does `apiKey: sdk.mask(...)` receive the real inbound credential for this API (the header/cookie/token the auth layer actually checks), rather than a placeholder, a hardcoded string, or an unrelated value? Fail if `mask()` is given a fallback like `x || 'anonymous'`.

4. **collateral** - Was anything changed that shouldn't have been? Fail if the file has commented-out user code, deleted routes, altered business logic, or unrelated refactors near the SDK block. Setup should only have added the SDK init line and the `setup(...)` registration.

5. **runtime** - Would this file still load? Fail on obvious syntax errors, a duplicate SDK registration, imports that don't resolve, or a `setup()` call with the wrong arity (it takes EXACTLY one argument, the callback).

Reply with ONLY a JSON object, no prose around it:

```json
{
  "checks": [
    { "id": "order", "ok": true, "note": "registered above the API-key guard" },
    { "id": "mounted", "ok": true, "note": "" },
    { "id": "credential", "ok": true, "note": "" },
    { "id": "collateral", "ok": true, "note": "" },
    { "id": "runtime", "ok": true, "note": "" }
  ]
}
```

Rules for `note`: one short phrase, lowercase, no trailing period. Required when `ok` is false - say what's wrong and where (e.g. "sits below requireApiKey on line 42"). Leave it empty when `ok` is true unless there's something genuinely worth surfacing. Never invent a failure to seem thorough: if a check passes, say it passes.
