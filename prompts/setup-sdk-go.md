You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files. NEVER read anything under `vendor/`.**

## What to do

0. **First, check if the SDK is already wired in.** A project counts as wired only if all three are present:
   - An **import** of `github.com/restlesshq/go` (the package binds as `restless` even unaliased, because the package name is not the last path element).
   - A **construction**: `restless.MustNew(<arg>)` or `restless.New(<arg>)`.
   - A **`Setup` callback** returning a `restless.SetupResult` containing `APIKey: restless.Mask(...)`, and the middleware wrapping the handler: `client.Middleware()(mux)`.

   A file that imports the package only for its types (a helper taking `*restless.RequestInfo`) is NOT wired. If all three are present, **stop and do nothing**: print one short sentence saying what you found and end the run with no Edit/Write calls.

1. **Find the integration point.** The middleware wraps an `http.Handler`, so it goes where the server is started - usually `main()`, next to `http.ListenAndServe`.

   ```go
   handler := client.Middleware()(mux)
   log.Fatal(http.ListenAndServe(":8080", handler))
   ```

   **Wrap as far OUT as you can**, above any middleware that can reject a request, so the SDK still records the 401 it produced.

   Construct the client once, in `main()` or a package-level initializer - not per request.

2. **Pass a route resolver unless this is a Go 1.23+ `ServeMux`.** This is the step with no equivalent in any other language, and getting it wrong is silent.

   `client.Middleware()` with no argument reads `http.Request.Pattern`, which only the stdlib `ServeMux` on Go 1.23+ populates. For any other router, pass a resolver:

   ```go
   // chi
   client.Middleware(func(r *http.Request) string {
       return chi.RouteContext(r.Context()).RoutePattern()
   })

   // gorilla/mux
   client.Middleware(func(r *http.Request) string {
       tpl, _ := mux.CurrentRoute(r).GetPathTemplate()
       return tpl
   })
   ```

   Without one, every `/pets/1` and `/pets/2` becomes its own group on the dashboard, and a 404 on a missing record cannot be told apart from a 404 on an endpoint that does not exist. Determine the router from the imports in the file you are editing and pass the matching resolver.

3. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

4. **API key handling.** Always write `os.Getenv("RESTLESS_KEY")` as the constructor argument - the CLI rewrites it to the canonical form after you finish. Keep any functional options (`restless.WithBaseURL(...)`) that already follow it; only the first argument is the key. Do not add a dotenv library and do not modify `go.mod`.

5. **Wire up the end-user `APIKey`.** Extract the credential inside the callback and return `APIKey: restless.Mask(<credential>)`. Read headers with `r.Header("Authorization")` - it is case-insensitive - rather than reaching into `r.Request.Header` directly.

6. **Pick `Owner.ID` carefully. It is the permanent, immutable identifier the dashboard pins this customer's entire log history to.** Once a customer has produced logs under one id, changing it fragments their history. This is the single most important thing to get right.

   **An "owner" is not necessarily a user.** It is whatever entity *owns the API key* in this project's model: a workspace, organization, account, tenant, or service. Trace the credential to the record it resolves to - the foreign key on the api-keys table, the `sub` of the JWT, the `belongs_to` on the token model. That record is the owner and its primary key is `Owner.ID`.

   **Decision procedure (in order):**

   a. **Trace the credential to the entity that owns it.** Read the authentication code and follow the token to its record. Resolve it from the credential inside the callback, not from state a later layer sets: the SDK wraps the handler outermost, so the callback runs **before** your own middleware. `current_user`, `request.env["warden"]` and friends are not populated yet. Do the same lookup your auth middleware does, from inside the callback.

   b. **Verify the candidate is immutable.** Enough evidence: the field is named like an id (`id`, `uuid`, `<entity>_id`, `sub`), a struct tag or schema declares it the primary key, or the value is a UUID or integer pk. Reject only if the field is mutable - `email`, `username`, `name`, `handle`, `login`, or a renameable `slug`. If a record has both an id and a mutable field, always pick the id and resolve the other inside `enrich`.

   c. **Match the entity to the API shape:**
      - **Multi-tenant SaaS** (an Account / Organization / Workspace type, an `X-Workspace-Id` header): the tenant's id.
      - **Key owned by a project or service** (an APIKey struct with a ProjectID field): the project id, not the user who created it.
      - **Per-user API** (one key per developer): the user's id.

   d. **If you genuinely cannot find a stable internal id**, do NOT invent one and do NOT fall back to the API key, an email, or a username. Use this exact placeholder and marker so the CLI can prompt the user:

   ```go
   result.Owner = &restless.Owner{
       // RESTLESS_OWNER_ID_TODO: I could not find a stable, immutable
       // identifier in this codebase's auth flow. The CLI will prompt for it.
       ID: "NEEDS_CONFIGURATION",
   }
   ```

   Both exact strings `RESTLESS_OWNER_ID_TODO` and `NEEDS_CONFIGURATION` are required - the CLI greps for them after your run.

   **HARD RULE: never put a raw or masked API key, password, token, or any other secret in `Owner.ID`.** It leaves the user's machine on every request.

   **HARD RULE: never use a placeholder literal** like `"anonymous"`, `"none"`, `"unknown"` or `"guest"`. That groups every unauthenticated request under one fake tenant and hides that they are anonymous. When a request has no real owner, leave `Owner` nil. Go makes this natural, because `Owner` is a pointer and the zero value is exactly "no owner":

   ```go
   client.Setup(func(r *restless.RequestInfo) restless.SetupResult {
       result := restless.SetupResult{
           APIKey: restless.Mask(r.Header("Authorization")),
       }
       if workspaceID := resolveWorkspace(r.Header("Authorization")); workspaceID != "" {
           result.Owner = &restless.Owner{ID: workspaceID, Enrich: loadWorkspace}
       }
       return result
   })
   ```

   `Owner` is a pointer, so "no owner for this request" is simply leaving it nil.

7. **Owner shape.** The struct is `restless.SetupResult{APIKey, Owner, Block, Extra}`, and `Owner` is a `*restless.Owner` holding exactly two things: the immutable `ID` and the `Enrich` func. There are NO inline label / email fields on `Owner`; everything except `ID` comes back from `Enrich`. Extra top-level data goes in `Extra`.

8. **Always wire `Owner.Enrich`. It is the only channel for display info.** A bare id shows up on the dashboard as an opaque string. `Enrich` resolves the human-readable `label` AND `email`, which is what makes logs legible and powers dashboard access grants. It receives the owner id, runs once per id and then caches for an hour, so a real database call is expected and its cost is amortized.

   Resolve `label` and `email` independently. A field counts as available if it is on the record **or reachable with one more query** - a `belongs_to`, an `includes`, a second lookup against a table this codebase already queries. If `label` is free but `email` needs a join, do both.

   Mirror the data access this project already uses (database/sql, sqlx, GORM, an in-memory map) - do not invent one it does not have. A lambda or a `method(:name)` reference both work:

   ```go
   func loadWorkspace(id string) restless.OwnerDetails {
       ws := db.Workspace(id)
       return restless.OwnerDetails{"label": ws.Name, "email": ws.AdminEmails}
   }
   ```

   If `Enrich` panics, the SDK recovers and the log still ships with the ID, so a best-effort real lookup is safe. Only if there is genuinely no source for owner metadata anywhere, still set `Enrich` and have it return an empty `restless.OwnerDetails{}`.

   Return flat keys in the `OwnerDetails` map (`"label"`, `"email"`), never nested. `email` may be a string or a slice of strings.

## Rules

- **NEVER read `.env` files or anything under `vendor/`.**
- **DO NOT modify `go.mod` or `go.sum`** beyond the dependency already added.
- **DO NOT modify other config** (`Dockerfile`, CI config). Your edits should be the file where the client is constructed and the handler wrapped - usually just `main.go`.
- **Wrap the handler, do not add a route or a per-request hook.**
- **Pass a route resolver for any router other than Go 1.23+ `ServeMux`** (step 2). This failure is silent.
- **Use `r.Header(name)`**, not `r.Request.Header.Get(name)`.
- **Do not add a `recover()` around the SDK.** Panics in the handler are captured, logged with their stack, and re-panicked so your own handling behaves exactly as before.
- **A callback that panics is recovered by design** (SAFETY-002), so a wrong callback produces an install that looks healthy and attributes nothing.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it at startup.
- **`.restless/` is source and belongs in the repo.** Never add it to `.gitignore`.
- **Do NOT substitute a fallback string inside `restless.Mask()`.** It returns "" on empty input; a fallback's last 4 characters would become the mask tail.
- **`go build ./...` must succeed when you are done.** Go is the one language where the wiring either compiles or does not - check it rather than assuming.
- Keep changes minimal and gofmt-clean.
