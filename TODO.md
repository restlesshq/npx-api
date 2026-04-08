# TODO

## SDK Installation Guides
We need installation guides for each supported language in `docs/sdks/`.
Each guide should cover: install command, verify installation, any language-specific setup.

The install step and the setup-code step are separate — each language/framework combo needs both.
Also need to handle TypeScript vs plain JS variants (different imports, type annotations, etc.).

### Languages
- [x] JavaScript (npm)
- [ ] TypeScript (npm) — needs separate guide with typed imports, tsconfig considerations
- [ ] Python (pip)
- [ ] Ruby (gem)
- [ ] Go (go get)
- [ ] Java (maven/gradle)
- [ ] PHP (composer)
- [ ] C# (.NET / NuGet)
- [ ] Swift (SPM)
- [ ] Kotlin (gradle)

### Framework-specific setup code (per language)
Each framework needs its own setup snippet showing how to wire up the middleware/plugin.
- [x] Fastify (JS)
- [ ] Express (JS)
- [ ] Koa (JS)
- [ ] Hono (JS/TS)
- [ ] NestJS (TS)
- [ ] Next.js API routes (JS/TS)
- [ ] Flask (Python)
- [ ] Django / DRF (Python)
- [ ] FastAPI (Python)
- [ ] Rails (Ruby)
- [ ] Sinatra (Ruby)
- [ ] Gin (Go)
- [ ] Echo (Go)
- [ ] Spring Boot (Java)
- [ ] Laravel (PHP)
- [ ] ASP.NET (C#)

## API Key Handling
- [x] Generate an API key during setup (via login flow)
- [x] Surface the key to the user so they can add it to their `.env` file
- [ ] SDK should fail gracefully if `README_API_KEY` is missing (clear error message, not a crash)

## Login / Auth Flow — SECURITY AUDIT NEEDED
**This needs a thorough security review before shipping.**
Flow: CLI generates a random token, opens `site/login?token=TOKEN`, then polls `site/api/auth/check?token=TOKEN` every 2s until status=complete.
- [ ] Token must be cryptographically random and long enough to prevent brute-force guessing.
- [ ] Token should expire after a short window (e.g. 10 minutes). CLI should timeout and tell the user.
- [ ] The `/api/auth/check` endpoint must only return credentials once (delete after first successful read) to prevent replay.
- [ ] Ensure the token cannot be enumerated — rate-limit the check endpoint.
- [ ] The poll endpoint returns `{ apiKey, email }` — confirm the API key is single-use or scoped appropriately.
- [ ] HTTPS in production (localhost HTTP is fine for dev only).
- [ ] API key should never be logged, cached, or stored in plaintext beyond the user's .env.
- [ ] Consider what happens if two CLI sessions use the same token (shouldn't be possible with 16 random bytes, but verify).

## UUID vs API Key — Think About This
The API UUID (in settings.json per-API) and the ReadMe API key (rdme_...) are currently separate things:
- **UUID**: identifies a specific API definition, stable across machines, used for syncing specs
- **API key**: authenticates the user, used for Bearer auth on uploads

Questions to resolve:
- [ ] Should these ever be unified? Or always separate?
- [ ] Should the UUID be server-generated (so the site is the source of truth) instead of CLI-generated?
- [ ] If two people run setup on the same repo, they get different UUIDs — is that a problem?
- [ ] Should the site return a project-level ID on first upload that gets saved locally?

## Metrics SDK
- [ ] The readmeio metrics middleware should send an API version identifier with each request

## Setup Flow
- [ ] Running `setup` again should continue/resume rather than start from scratch (detect existing .api/, skip completed steps)
- [ ] Dedupe APIs in settings.json — don't add the same API twice on re-run

## Test / Try It
- [ ] After curl test, actually show incoming API calls in the terminal as they arrive (live dashboard)
- [ ] Support non-GET test requests for APIs that don't have safe list endpoints
- [ ] Detect when the SDK isn't sending logs (server not restarted, .env in wrong location, etc). During the poll step, if no logs appear after a successful curl, the site could return a hint header or field (e.g. `{ logs: [], hint: "no_logs_yet" }`) and the CLI could suggest: "No logs received — make sure you restarted your server after adding README_API_KEY to .env, and that .env is in the right directory."

## Metrics / ClickHouse
- [ ] Add a migration system for ClickHouse schema changes. Currently the only option is drop-and-recreate (`seedDatabase()`), which is fine for dev but won't work in production. Need incremental migrations that can add columns, modify types, etc. without data loss.

## Site / Dashboard
- [ ] Make the dashboard mobile-friendly (sidebar collapses, tables scroll, responsive breakpoints)
