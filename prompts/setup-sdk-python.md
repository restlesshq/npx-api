You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files. NEVER read anything under `.venv/` or `site-packages/`.**

## What to do

0. **First, check if the SDK is already wired in.** Grep for `import restless` / `from restless import` in the user's source (NOT in `.venv/` or `site-packages/`). A file counts as correctly wired only if it has all three:
   - A **construction**: `client = restless.Restless(<arg>)` (or the functional `restless.restless(<arg>)`, or `Restless(<arg>)` after `from restless import Restless`).
   - A **`@client.setup` callback** returning a dict with `"api_key": client.mask(...)` in it.
   - The **app wrapped**: `app.wsgi_app = client.wsgi(app.wsgi_app)`, `application = client.wsgi(...)`, or `app = client.asgi(app)`.

   An import with no construction (a test importing `mask`, for instance) is NOT wired. If all three are present, **stop and do nothing**: print one short sentence saying what you found and end the run with no Edit/Write calls.

1. **Find the integration point.** The SDK wraps the *application object*, it is not registered as a route or a per-framework plugin. Where that happens depends on the framework:

   - **Flask**: where `Flask(__name__)` is created. Set `app.wsgi_app = client.wsgi(app.wsgi_app)` after the app and after any other WSGI middleware that should sit inside the capture.
   - **Django**: `wsgi.py` (or `asgi.py`). Wrap what `get_wsgi_application()` returns. Do NOT add it to `MIDDLEWARE` - wrapping outside the whole stack is the point, so the SDK sees the real response Django sent.
   - **FastAPI / Starlette / Quart**: where the app object is built. `app = client.asgi(app)`. Do **NOT** use `add_middleware(...)` - that places the SDK inside Starlette's exception middleware, where an unhandled error has already become a 500 and the raise site is lost.
   - **Anything else speaking WSGI or ASGI** (Pyramid, Bottle, bare WSGI): wrap the application callable the same way.

   **Wrap as far out as you can.** An inner wrap sees a different status and body than the client did.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

3. **API key handling.** Always write `os.environ.get("RESTLESS_KEY")` as the constructor argument - the CLI rewrites it to the canonical form (literal key, env-ref, or no-arg) after you finish, based on what the user picked. Do not reason about env loaders, do not install `python-dotenv`, and do not modify `requirements.txt` or `pyproject.toml`.

   Use `os.environ.get(...)`, never `os.environ[...]`. The subscript raises `KeyError` when the variable is not set yet, and the client is normally constructed at module import, so that takes the whole app down at startup over an observability variable.

4. **Wire up the end-user `api_key`.** Look at how this API authenticates its callers (Authorization header, JWT, API-key header, query param) and extract the credential inside the setup callback. The returned dict MUST include `"api_key": client.mask(<credential>)` at the top level. Without it every log shows up as anonymous.

   Read the credential through the request view: `request.header("authorization")`. It is case-insensitive and works identically under WSGI and ASGI. Do NOT reach into `request.environ["HTTP_AUTHORIZATION"]` or decode `request.scope["headers"]` by hand - both work under exactly one protocol, so the same callback silently attributes nothing under the other.

5. **Pick `owner["id"]` carefully. It is the permanent, immutable identifier the dashboard pins this customer's entire log history to.** Once a customer has produced logs under one id, changing it fragments their history. This is the single most important thing to get right.

   **An "owner" is not necessarily a user.** It is whatever entity *owns the API key* in this project's data model: a workspace, project, team, organization, account, tenant, or service. Determine it from the model - what does the credential map back to? The foreign key on the api-keys table, the `sub` of the JWT, the record an API-key row points at. That record is the owner, and its immutable primary key is `owner["id"]`.

   **Decision procedure (in order):**

   a. **Trace the credential to the entity that owns it.** Read the authentication code and follow the key/token to the record it resolves to. Resolve it from the credential inside the callback, not from request state a later layer attaches - the SDK wraps the whole application, so the callback runs before your auth code does. Django's `request.user` and Flask's `g.*` are NOT populated yet. Do the same lookup the auth layer does, from inside the callback.

   b. **Verify the candidate is immutable.** Enough evidence: the field is named like an id (`id`, `pk`, `uuid`, `<entity>_id`, `sub`), a model declares it a primary key (Django `models.Model` pk, SQLAlchemy `primary_key=True`, a Pydantic id field), the value is a UUID / integer pk / stable slug used as a record key, or it is a dict key in a fixture or in-memory store.

      Reject ONLY if the field is mutable: `email`, `username`, `name`, `display_name`, `handle`, `nickname`, `login`, or a renameable slug. If an entity has both an id and a mutable field, always pick the id and resolve the other inside `enrich`.

   c. **Match the entity to the API shape:**
      - **Multi-tenant SaaS** (workspaces / orgs / accounts, a `company_id` claim, an `X-Workspace-Id` header): the tenant's internal id.
      - **Key owned by a project or service** (the api-keys table has a `project_id` foreign key): the project id, not the user who created it.
      - **Per-user API** (one key per developer): the user's internal id.

   d. **If you genuinely cannot find a stable internal id**, do NOT invent one and do NOT fall back to the API key, an email, or a username. Use this exact placeholder and marker so the CLI can prompt the user:

   ```python
   "owner": {
       # RESTLESS_OWNER_ID_TODO: I could not find a stable, immutable
       # identifier in this codebase's auth flow. The CLI will prompt for it.
       "id": "NEEDS_CONFIGURATION",
   },
   ```

   Both exact strings `RESTLESS_OWNER_ID_TODO` and `NEEDS_CONFIGURATION` are required - the CLI greps for them after your run.

   **HARD RULE: never put a raw or masked API key, password, token, or any other secret in `owner["id"]`.** It leaves the user's machine on every request.

   **HARD RULE: never use a placeholder literal** like `"anonymous"`, `"none"`, `"unknown"`, `"guest"` or `"default"`. That groups every unauthenticated request under one fake tenant and hides that they are anonymous. When a request has no real owner (a public endpoint, a health check, a login route), omit the `"owner"` key entirely:

   ```python
   @client.setup
   def _(request):
       result = {"api_key": client.mask(request.header("authorization"))}
       workspace_id = resolve_workspace(request.header("authorization"))
       if workspace_id:
           result["owner"] = {"id": workspace_id, "enrich": enrich_owner}
       return result
   ```

6. **Owner shape.** The returned dict is `{"api_key": ..., "owner": {"id": ..., "enrich": ...}}`. `owner` is nested and holds exactly two things: the immutable `id` and the `enrich` callable. There are NO inline `label` / `email` keys on `owner`, and no top-level `project`, `project_id` or `enrich` - the SDK drops all of them.

7. **Always wire `owner["enrich"]`. It is the only channel for display info.** A bare id shows up on the dashboard as an opaque string. `enrich` resolves the human-readable `label` AND `email`, which is what makes logs legible and powers dashboard access grants. It receives the owner id, runs once per id and then caches, so a real database call is expected and its cost is amortized.

   Resolve `label` and `email` independently. A field counts as available if it is on the request **or reachable with one more lookup** - following a foreign key, a `select_related`, or a second query against a table this codebase already queries. If `label` is free but `email` needs a lookup, do both.

   Mirror the data access this project already uses - Django ORM, SQLAlchemy session, a raw driver, an in-memory dict - do not invent one it does not have:

   ```python
   def enrich_owner(owner_id):
       workspace = Workspace.objects.get(pk=owner_id)
       return {"label": workspace.name, "email": workspace.admin_emails}
   ```

   If `enrich` raises, the SDK swallows it and the log still ships with the id, so a best-effort real lookup is safe. Only if there is genuinely no source for owner metadata anywhere, still include `enrich` and have it `return {}` - do not drop it and do not invent a store.

   Return flat keys (`{"label": ..., "email": ...}`), never nested. `email` may be a string or a list of strings.

## Rules

- **NEVER read `.env`, `.env.local`, `.env.*`, or any file containing secrets.**
- **NEVER read files under `.venv/`, `venv/`, or `site-packages/`.** The guide above tells you everything you need.
- **DO NOT modify `requirements.txt`, `pyproject.toml`, `Pipfile`, or `setup.py`.** The package is already installed.
- **DO NOT modify other config** (`Dockerfile`, CI config, `manage.py`, `settings.py` beyond nothing at all). Your only edit should be the module where the application object is built.
- **DO NOT install extra packages**, including `python-dotenv`. If the key is not in the environment the SDK degrades to capturing without uploading, which is the intended behaviour.
- **Wrap the app object, do not add a route or a per-framework plugin.** There is no `restless.flask` or `restless.fastapi`; there is one client with `.wsgi()` and `.asgi()`.
- **Use `request.header(name)`,** not the raw `environ` / `scope`. The raw form works under one protocol only.
- **The callback takes exactly one argument** and returns a dict. A callback that raises is swallowed by design (SAFETY-002), so a wrong one produces an install that looks healthy and attributes nothing - get it right rather than relying on an error to tell you.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it at startup.
- **`.restless/` is source and belongs in the repo.** It holds the spec and the settings the SDK reads at startup. Never add it to `.gitignore`; include it if you commit.
- **Do NOT substitute `or "anonymous"` inside `client.mask()`.** `mask()` returns `None` on missing input and the SDK handles it; the fallback's last 4 characters would become the mask tail.
- Keep changes minimal. Add the SDK wiring, do not refactor anything else, and match the file's existing import order and formatting.
