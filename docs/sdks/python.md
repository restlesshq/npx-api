# Python SDK Installation

Full reference: the `install.md` file at the root of the `restless-sdk` package (`python -c "import restless, pathlib; print(pathlib.Path(restless.__file__).parent)"`). Consult that if anything below is ambiguous.

## Install

```bash
pip install restless-sdk
```

The install name and the import name differ: you install `restless-sdk` and you `import restless`.

## Setup

One client, two adapters. There are no per-framework imports.

```python
import os
import restless

client = restless.Restless(os.environ.get("RESTLESS_KEY"))

@client.setup
def _(request):
    return {
        "api_key": client.mask(request.header("authorization")),
        "owner": {
            "id": workspace_id_for(request),
            "enrich": enrich_owner,
        },
    }
```

Then wrap the application object, as far **out** as you can so the SDK sees the real status and body:

```python
# Flask
app.wsgi_app = client.wsgi(app.wsgi_app)

# Django - in wsgi.py, outside the whole middleware stack
application = client.wsgi(get_wsgi_application())

# FastAPI / Starlette / any ASGI
app = client.asgi(app)
```

### The callback argument

`request` is a read-only `RequestInfo`, identical under WSGI and ASGI:

| accessor | what |
|---|---|
| `request.header(name)` | One header, case-insensitive. `request["authorization"]` is an alias. |
| `request.headers` | All of them, case-insensitive mapping. |
| `request.method` / `request.path` / `request.query_string` / `request.url` | The obvious things. |
| `request.environ` / `request.scope` | The raw WSGI environ or ASGI scope; the other is `None`. |

Use the accessors. Reading `request.environ["HTTP_AUTHORIZATION"]` works but only under WSGI, so the same callback silently attributes nothing under ASGI.

### `owner.id` is permanent and required

`owner["id"]` is the immutable identifier the dashboard pins a project's entire log history to. Use a workspace uuid or database primary key.

**Never** use an API key, email, username, JWT, or a placeholder literal like `"anonymous"` - anything that rotates or is a dummy string is wrong. If a request has no authenticated owner, omit the `owner` key entirely rather than substituting a placeholder.

If you cannot find a stable id in the codebase, set it to `"NEEDS_CONFIGURATION"` and leave a `# RESTLESS_OWNER_ID_TODO` comment. The CLI greps for both and asks the user.

### `owner.enrich`

The only channel for owner metadata. Runs once per owner id, then caches, so the expensive lookup goes here and never in the fields above.

```python
def enrich_owner(owner_id):
    workspace = Workspace.objects.get(pk=owner_id)
    return {"label": workspace.name, "email": workspace.admin_emails}
```

Inline `label` / `email` keys on `owner` are dropped. Everything except `id` comes back from `enrich`.

### `mask()`

```python
# CORRECT
"api_key": client.mask(request.header("authorization"))

# WRONG - the fallback's last 4 characters become the mask tail
"api_key": client.mask(request.header("authorization") or "anonymous")
```

`mask()` returns `None` on falsy input and the SDK handles it. Never substitute.

## Rules (hard constraints for LLM installers)

- Never read `.env`, `.env.local`, or anything under `.venv/` or `site-packages/`.
- Wrap the app object outermost. Do NOT use Starlette's `add_middleware`: it places the SDK inside the exception middleware, where an unhandled error is already a 500 and the raise site is lost.
- Construct the client once. In Django that means `wsgi.py`, not `settings.py` (which can be imported twice).
- Do not add per-framework imports like `restless.flask` - they do not exist.
- Do not touch `pyproject.toml` / `requirements.txt` beyond adding the dependency, and leave `Dockerfile` and CI config alone.
- A callback that raises is swallowed by design (SAFETY-002), so a wrong callback produces an install that looks healthy and attributes nothing. Verify rather than assume.

## Verify

1. `restless-sdk` appears in `requirements.txt` / `pyproject.toml` / `Pipfile`.
2. The app object is wrapped with `client.wsgi(...)` or `client.asgi(...)`, outermost.
3. A `@client.setup` callback exists and reads its header through `request.header(...)`.
4. Starting the server and hitting any endpoint returns an `x-request-id` response header carrying a fresh id - `<prefix>-<uuid>` when the API has a `requestIdPrefix` in `.restless/settings.json` (the CLI sets one on every project), otherwise a bare UUID. If your request already sent an `x-request-id`, the SDK leaves that chain alone and answers on `x-restless-id` instead - the SDK sets exactly one of the two. Other stacks set `x-request-id` too, so for proof it was ours, check for the `x-debug` header, which rides every captured response.
