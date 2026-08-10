# Ruby SDK Installation

Full reference: the `install.md` file at the root of the `restless-sdk` gem (`bundle show restless-sdk`). Consult that if anything below is ambiguous.

## Install

```bash
gem install restless-sdk
```

or in a `Gemfile`:

```ruby
gem "restless-sdk"
```

The gem is `restless-sdk`; the require is `require "restless"`.

## Setup

One Rack middleware covers Rails, Sinatra, Hanami, Grape, Roda and anything else that speaks Rack. There are no per-framework adapters.

```ruby
require "restless"

CLIENT = Restless.new(ENV["RESTLESS_KEY"])

CLIENT.setup do |request|
  result = { api_key: CLIENT.mask(request.header("Authorization")) }

  workspace_id = workspace_id_for(request)
  if workspace_id
    result[:owner] = {
      id: workspace_id,
      enrich: ->(id) {
        workspace = Workspace.find(id)
        { label: workspace.name, email: workspace.admin_emails }
      },
    }
  end

  result
end
```

Then mount it, as far **out** as you can so the SDK sees the real status and body:

```ruby
# config.ru - Sinatra, Roda, Hanami, Grape, plain Rack
use CLIENT.rack
run App
```

```ruby
# config/application.rb - Rails
config.middleware.insert_before 0, CLIENT.rack
```

`insert_before 0` rather than `use`: appending puts the SDK at the bottom of the stack, below `ActionDispatch::ShowExceptions`, where it would record a rendered error page instead of the real exception.

`CLIENT.rack` returns a middleware factory - anything that calls `.new(app)` on it works, including `CLIENT.rack.new(app)` directly.

### The callback argument

`request` is a read-only `RequestInfo`:

| accessor | what |
|---|---|
| `request.header(name)` | One header, case-insensitive. `request["authorization"]` is an alias. |
| `request.request_method` | `"GET"`, `"POST"`, ... |
| `request.path` | `SCRIPT_NAME` + `PATH_INFO`. |
| `request.query_string` | Raw query string. |
| `request.url` | Full URL. |
| `request.env` | The raw Rack env, for anything the view does not model. |

Use `header`, not `env["HTTP_AUTHORIZATION"]`.

### `owner[:id]` is permanent and required

The immutable identifier the dashboard pins a project's entire log history to. Use a workspace uuid or database primary key.

**Never** an API key, email, username, JWT, or a placeholder literal like `"anonymous"` - anything that rotates or is a dummy string is wrong. If a request has no authenticated owner, omit the `owner` key. A Ruby hash literal cannot omit a key conditionally, which is why the example above builds the hash and then assigns `result[:owner]`.

If you cannot find a stable id in the codebase, set it to `"NEEDS_CONFIGURATION"` and leave a `# RESTLESS_OWNER_ID_TODO` comment. The CLI greps for both and asks the user.

### `owner[:enrich]`

The only channel for owner metadata. Runs once per owner id and then caches for an hour, so the expensive lookup goes here and never in the fields above. A lambda or `method(:name)` both work. Inline `label` / `email` keys on `owner` are dropped.

### `mask()`

```ruby
# CORRECT
api_key: CLIENT.mask(request.header("Authorization"))

# WRONG - the fallback's last 4 characters become the mask tail
api_key: CLIENT.mask(request.header("Authorization") || "anonymous")
```

`mask` returns nil on missing input and the SDK handles it. Never substitute.

### Route patterns

The middleware reads the matched route from the framework, so handlers do not report it: Sinatra's `sinatra.route`, Rails' `action_dispatch.route_uri_pattern`, or `env["restless.route"]` if you set it yourself. `:id`-style params are rewritten to `{id}` so the same endpoint groups identically here and in every other Restless SDK.

## Rules (hard constraints for LLM installers)

- Never read `.env`, `config/master.key`, `config/credentials.yml.enc`, or anything under `vendor/bundle/`.
- Mount middleware; do not add a route, a controller, or a `before_action`. A filter runs far too late and only for requests that reach a controller.
- In Rails use `config.middleware.insert_before 0`, never `config.middleware.use`.
- Construct the client once, somewhere loaded at boot - not per request.
- Do not modify the `Gemfile` beyond adding the gem, and leave `Dockerfile` and CI config alone.
- A callback that raises is swallowed by design (SAFETY-002), so a wrong callback produces an install that looks healthy and attributes nothing. Verify rather than assume.

## Verify

1. `restless-sdk` appears in the `Gemfile` (or `bundle list` finds it).
2. `CLIENT.rack` is mounted in `config.ru` or `config/application.rb`, as far out as possible.
3. A `CLIENT.setup do |request|` block exists and reads its header through `request.header(...)`.
4. Starting the server and hitting any endpoint returns an `x-restless-id` response header.
