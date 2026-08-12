The user just ran a LIVE test of their Restless SDK setup against their running dev server, and it failed. Your job is to find and fix the problem in their code using the Read / Edit / Write / Bash tools. Do not just describe the fix — apply it to the files.

## What we observed at runtime

{{evidence}}

This is a runtime signal, not a guess: a real HTTP request was just sent to their server and we inspected the response. A previous step already installed the SDK, so the package is present — the problem is that live requests aren't actually flowing through it (or the process is missing configuration).

## What to do

{{guidance}}

Start by reading the relevant server / route / config files to understand the current wiring, then make the smallest change that fixes it. The Restless SDK package is `{{sdkPackage}}`. The server was reached at {{base}}.

## Hard rules

- On **Next.js**, NEVER wire the SDK into a middleware file (`middleware.ts` / `proxy.ts`). Next passes middleware a request whose `.request` getter throws `PageSignatureError`, and middleware runs on the Edge runtime where the SDK can't do its work. If a previous attempt wired it there, REMOVE it and instead wrap the route handlers (import from `{{sdkPackage}}/next`).
- Do NOT print, log, echo, or hardcode the value of `RESTLESS_KEY`. Always reference it as `process.env.RESTLESS_KEY`.
- Make the smallest change that fixes the wiring. If the existing setup is already correct, leave it alone.
- Do not use `python`, `ruby`, `pip`, or other interpreters the user may not have — use Node or POSIX tools.

When you're done, briefly say what you changed in one or two sentences. The user will restart their server and we'll re-check automatically — you do not need to start or restart anything yourself.
