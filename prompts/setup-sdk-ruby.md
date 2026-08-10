You need to wire up the Restless SDK in this {{language}} project that uses {{framework}}.

**IMPORTANT: NEVER read .env, .env.local, `config/master.key`, `config/credentials.yml.enc`, or any environment/secret files. NEVER read anything under `vendor/bundle/`.**

## What to do

0. **First, check if the SDK is already wired in.** A project counts as wired only if all three are present:
   - A **construction**: `CLIENT = Restless.new(<arg>)` (or `Restless::Client.new`).
   - A **`setup` callback**: `CLIENT.setup do |request| ... end` returning a hash containing `api_key: CLIENT.mask(...)`.
   - The **middleware mounted**: `use CLIENT.rack` in `config.ru`, `config.middleware.insert_before 0, CLIENT.rack` in Rails, or `CLIENT.rack.new(app)` directly.

   Note there may be **no `require "restless"` anywhere** - under Bundler the gem is already loaded, so a Rails wiring legitimately has none. Do not treat a missing require as "not wired". If all three are present, **stop and do nothing**: print one short sentence saying what you found and end the run with no Edit/Write calls.

1. **Find the integration point. It is almost certainly NOT the file with the routes.** The SDK is Rack middleware, so it mounts where the app is assembled:

   - **Rails**: `config/application.rb`, inside the `Application` class. Use `config.middleware.insert_before 0, CLIENT.rack` so it sits outside every other middleware, including `ActionDispatch::ShowExceptions` - that is what lets it see the real status for a handled error. Do NOT edit `config/routes.rb`; the routes are not where middleware goes.
   - **Sinatra / Roda / Hanami / Grape / any Rack app**: `config.ru`. `use CLIENT.rack` above `run App`.
   - **No `config.ru`** (a script calling a server directly): wrap the app object where it is handed to the server, `handler = CLIENT.rack.new(APP)`.

   **Mount as far OUT as you can.** An inner mount sees a different status and body than the client did.

   Where to construct the client: somewhere loaded once, before the mount. `config/application.rb` for Rails, the top of `config.ru` otherwise. Do not construct it per request.

2. **Follow the installation pattern in the guide exactly.** Here's the pattern:

{{guide}}

3. **API key handling.** Always write `ENV["RESTLESS_KEY"]` as the constructor argument - the CLI rewrites it to the canonical form (literal key, env-ref, or no-arg) after you finish, based on what the user picked. Do not reason about env loaders, do not add `dotenv`, and do not modify the `Gemfile`.

   If the constructor already passes options (`base_url:`, `redact:`), keep them. Only the first argument is the key.

4. **Wire up the end-user `api_key`.** Look at how this API authenticates its callers and extract the credential inside the setup callback. The returned hash MUST include `api_key: CLIENT.mask(<credential>)`. Without it every log shows up as anonymous.

   Read headers through the request view: `request.header("Authorization")`. It is case-insensitive and handles Rack's `HTTP_`-prefixed env keys for you. Do not reach into `request.env["HTTP_AUTHORIZATION"]` directly.

5. **Pick `owner[:id]` carefully. It is the permanent, immutable identifier the dashboard pins this customer's entire log history to.** Once a customer has produced logs under one id, changing it fragments their history. This is the single most important thing to get right.

   **An "owner" is not necessarily a user.** It is whatever entity *owns the API key* in this project's model: a workspace, organization, account, tenant, or service. Trace the credential to the record it resolves to - the foreign key on the api-keys table, the `sub` of the JWT, the `belongs_to` on the token model. That record is the owner and its primary key is `owner[:id]`.

   **Decision procedure (in order):**

   a. **Trace the credential to the entity that owns it.** Read the authentication code and follow the token to its record. Resolve it from the credential inside the callback, not from state a later layer sets: the SDK is mounted outside the whole middleware stack, so the callback runs **before** your controller filters. `current_user`, `request.env["warden"]` and friends are not populated yet. Do the same lookup `authenticate!` does, from inside the block.

   b. **Verify the candidate is immutable.** Enough evidence: the field is named like an id (`id`, `uuid`, `<entity>_id`, `sub`), an ActiveRecord model declares it the primary key, or the value is a UUID or integer pk. Reject only if the field is mutable - `email`, `username`, `name`, `handle`, `login`, or a renameable `slug`. If a record has both an id and a mutable field, always pick the id and resolve the other inside `enrich`.

   c. **Match the entity to the API shape:**
      - **Multi-tenant SaaS** (an `Account` / `Organization` / `Workspace` model, an `X-Workspace-Id` header): the tenant's id.
      - **Key owned by a project or service** (`ApiKey belongs_to :project`): the project id, not the user who created it.
      - **Per-user API** (one key per developer): the user's id.

   d. **If you genuinely cannot find a stable internal id**, do NOT invent one and do NOT fall back to the API key, an email, or a username. Use this exact placeholder and marker so the CLI can prompt the user:

   ```ruby
   owner: {
     # RESTLESS_OWNER_ID_TODO: I could not find a stable, immutable identifier
     # in this codebase's auth flow. The CLI will prompt for it.
     id: "NEEDS_CONFIGURATION",
   }
   ```

   Both exact strings `RESTLESS_OWNER_ID_TODO` and `NEEDS_CONFIGURATION` are required - the CLI greps for them after your run.

   **HARD RULE: never put a raw or masked API key, password, token, or any other secret in `owner[:id]`.** It leaves the user's machine on every request.

   **HARD RULE: never use a placeholder literal** like `"anonymous"`, `"none"`, `"unknown"` or `"guest"`. That groups every unauthenticated request under one fake tenant and hides that they are anonymous. When a request has no real owner, omit the `owner` key. Ruby makes this natural, because a hash literal cannot omit a key conditionally:

   ```ruby
   CLIENT.setup do |request|
     result = { api_key: CLIENT.mask(request.header("Authorization")) }

     workspace_id = resolve_workspace(request.header("Authorization"))
     if workspace_id
       result[:owner] = { id: workspace_id, enrich: method(:load_workspace) }
     end

     result
   end
   ```

6. **Owner shape.** The hash is `{ api_key:, owner: { id:, enrich: } }`. `owner` is nested and holds exactly two things: the immutable `id` and the `enrich` callable. There are NO inline `label` / `email` keys on `owner`, and no top-level `project`, `project_id` or `enrich` - the SDK drops all of them.

7. **Always wire `owner[:enrich]`. It is the only channel for display info.** A bare id shows up on the dashboard as an opaque string. `enrich` resolves the human-readable `label` AND `email`, which is what makes logs legible and powers dashboard access grants. It receives the owner id, runs once per id and then caches for an hour, so a real database call is expected and its cost is amortized.

   Resolve `label` and `email` independently. A field counts as available if it is on the record **or reachable with one more query** - a `belongs_to`, an `includes`, a second lookup against a table this codebase already queries. If `label` is free but `email` needs a join, do both.

   Mirror the data access this project already uses (ActiveRecord, Sequel, a plain hash) - do not invent an ORM it does not have. A lambda or a `method(:name)` reference both work:

   ```ruby
   enrich: ->(owner_id) {
     workspace = Workspace.find(owner_id)
     { label: workspace.name, email: workspace.admin_emails }
   }
   ```

   If `enrich` raises, the SDK swallows it and the log still ships with the id, so a best-effort real lookup is safe. Only if there is genuinely no source for owner metadata anywhere, still include `enrich` and have it return `{}`.

   Return flat keys (`{ label:, email: }`), never nested. `email` may be a string or an array of strings.

## Rules

- **NEVER read `.env`, `config/master.key`, `config/credentials.yml.enc`, or any secret file.**
- **NEVER read files under `vendor/bundle/`.** The guide above tells you everything you need.
- **DO NOT modify the `Gemfile`, `Gemfile.lock`, or the gemspec.** The gem is already installed.
- **DO NOT modify other config** (`Dockerfile`, CI config, `config/environments/*`). Your edits should be the file where the client is constructed and the middleware mounted - usually one file, at most two.
- **DO NOT add `dotenv` or any other gem.** If the key is not in the environment the SDK degrades to capturing without uploading, which is intended.
- **Mount the middleware, do not add a route or a controller filter.** A `before_action` runs far too late and only for requests that reach a controller.
- **In Rails use `config.middleware.insert_before 0`,** not `config.middleware.use`, which appends to the bottom of the stack where the SDK would see a rendered error page instead of the real exception.
- **Use `request.header(name)`,** not `request.env["HTTP_..."]`.
- **A callback that raises is swallowed by design** (SAFETY-002), so a wrong one produces an install that looks healthy and attributes nothing. Get it right rather than relying on an error to tell you.
- **Do NOT read `.restless/settings.json` manually.** The SDK reads it at startup.
- **`.restless/` is source and belongs in the repo.** Never add it to `.gitignore`; include it if you commit.
- **Do NOT substitute `|| "anonymous"` inside `CLIENT.mask()`.** `mask` returns nil on missing input and the SDK handles it; the fallback's last 4 characters would become the mask tail.
- Keep changes minimal, and match the file's existing style and indentation.
