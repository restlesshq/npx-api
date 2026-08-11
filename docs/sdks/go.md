# Go SDK Installation

Full reference: the `install.md` file at the root of the `github.com/restlesshq/go` module. Once the module is a dependency, `go list` resolves where it actually lives - the module cache normally, or the target of a `replace` directive:

```bash
cat "$(go list -m -f '{{.Dir}}' github.com/restlesshq/go)/install.md"
```

Consult that if anything below is ambiguous.

## Install

```bash
go get github.com/restlesshq/go
```

The module path ends in `go`, but the **package name is `restless`** - an unaliased import still binds `restless`. Aliasing it explicitly is common and reads better:

```go
import restless "github.com/restlesshq/go"
```

## Setup

```go
client := restless.MustNew(os.Getenv("RESTLESS_KEY"))

client.Setup(func(r *restless.RequestInfo) restless.SetupResult {
    result := restless.SetupResult{
        APIKey: restless.Mask(r.Header("Authorization")),
    }

    if workspaceID := workspaceIDFor(r.Request); workspaceID != "" {
        result.Owner = &restless.Owner{
            ID:     workspaceID,
            Enrich: loadWorkspace,
        }
    }

    return result
})
```

`MustNew` panics on a configuration error; `New` returns `(*Client, error)` if you would rather handle it. Both take functional options (`restless.WithBaseURL`, `WithRedact`, `WithAPI`) after the key.

Then wrap your handler, as far **out** as you can:

```go
handler := client.Middleware()(mux)
log.Fatal(http.ListenAndServe(":8080", handler))
```

`Middleware()` returns `func(http.Handler) http.Handler`, so it composes with any middleware chain.

### The route resolver - the one decision no other language has

`client.Middleware()` with no argument reads `http.Request.Pattern`, which **only Go 1.23+ `ServeMux` populates**. Every other router needs its own resolver, passed as an optional argument:

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

// gin - resolve from the context set by the gin middleware wrapper
client.Middleware(func(r *http.Request) string { return ginRoutePattern(r) })
```

This matters more than it looks. Without a route pattern every `/pets/1` and `/pets/2` is its own group on the dashboard, and a 404 on a missing *record* cannot be told apart from a 404 on an endpoint that does not exist.

### The callback argument

`r` is a `*restless.RequestInfo`:

| accessor | what |
|---|---|
| `r.Header(name)` | One header, case-insensitive. |
| `r.Request` | The underlying `*http.Request`, for anything else. |
| `r.Route` | The resolved route template, when a resolver produced one. |

### `Owner.ID` is permanent and required

The immutable identifier the dashboard pins a project's entire log history to. Use a workspace UUID or a database primary key.

**Never** an API key, email, username, JWT, or a placeholder literal like `"anonymous"`. `Owner` is a pointer, so "no owner" is simply leaving it nil - which is why the example builds the result and only sets `result.Owner` when there is one.

If you cannot find a stable id in the codebase, set it to `"NEEDS_CONFIGURATION"` and leave a `// RESTLESS_OWNER_ID_TODO` comment. The CLI greps for both and asks the user.

### `Owner.Enrich`

`func(ownerID string) restless.OwnerDetails` - the only channel for owner metadata. Runs once per owner id and then caches, so the expensive lookup goes here.

```go
func loadWorkspace(id string) restless.OwnerDetails {
    ws := db.Workspace(id)
    return restless.OwnerDetails{"label": ws.Name, "email": ws.AdminEmails}
}
```

### `Mask()`

```go
// CORRECT
APIKey: restless.Mask(r.Header("Authorization"))

// WRONG - the fallback's last 4 characters become the mask tail
APIKey: restless.Mask(orDefault(r.Header("Authorization"), "anonymous"))
```

`Mask` returns "" on empty input and the SDK handles it. `client.Mask` is the same function if you prefer the method form.

## Rules (hard constraints for LLM installers)

- Never read `.env` files or anything under `vendor/`.
- Wrap the handler outermost, before any middleware that can reject a request, so the SDK still sees a 401.
- Pass a route resolver for any router other than Go 1.23+ `ServeMux`. Bare `Middleware()` on chi or gorilla silently produces no route patterns.
- Do not modify `go.mod` beyond adding the dependency, and leave `Dockerfile` and CI config alone.
- Panics in the handler are captured, logged with their stack, and re-panicked - do not add recovery around the SDK to "help".
- A callback that panics is recovered by design (SAFETY-002), so a wrong callback produces an install that looks healthy and attributes nothing. Verify rather than assume.

## Verify

1. `github.com/restlesshq/go` appears in `go.mod` and `go list -m github.com/restlesshq/go` resolves.
2. `client.Middleware()` wraps the handler passed to `ListenAndServe`, outermost.
3. A `client.Setup(...)` callback exists and reads its header via `r.Header(...)`.
4. **`go build ./...` succeeds** - Go is the one language where the wiring either compiles or does not.
5. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
