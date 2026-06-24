Discover all APIs in this **Node.js / TypeScript** codebase. You MUST finish within 10 tool calls. Be fast.

**NEVER read .env, .env.local, or any environment/secret files.**

{{findingsSection}}

{{hintSection}}

## Your job

The findings above already include every route our regex could find, every YAML/JSON file whose parsed content has a top-level `openapi` or `swagger` field, and a **Framework signals** block listing, per package, its framework dependencies, the framework calls/types its source actually uses, whether it's OAS-capable, and how many inline routes matched. Treat them as authoritative - you do NOT need to re-run that search. Just synthesize them into the output JSON.

## Step 1 - Confirm the project shape (0–1 tool calls)

Use the **Framework signals** block in the findings to identify each package's framework - it already lists the deps and the source markers (`fastify()`, `express()`, `FastifyInstance`, `fastify.routing()`, etc.). Only read a `package.json` yourself if a package is ambiguous or missing from that block.

Determine the framework **per package, from the code that handles requests - not just the first dependency listed.** A single package often depends on more than one HTTP library. In particular:

- If a package builds a **Fastify** server (imports `fastify` / `@fastify/*`, calls `fastify(...)` / `fastifyModule(...)`, uses `.register(...)`, `.addHook(...)`, or `FastifyInstance`) and a separate Express layer only forwards into it (e.g. `fastify.routing(req, res)`, or an `express.Router()` that delegates), the framework is **Fastify**. The Express piece is a host shim, not the API framework.
- The same logic applies to NestJS (`@nestjs/*`), Koa, and Hono wrapped by an outer host.

If the findings show zero endpoints AND no `package.json` exists, return `{"apis": []}` immediately - we only support Node.

## Step 2 - Grep for routes when findings are empty OR a framework is under-represented (0–2 tool calls)

The pre-scan regex only catches **inline string-literal routes** like `app.get('/x')`. It misses common Fastify/Nest patterns: route modules registered with `fastify.register(routesFn, { prefix })`, `fastify.route({ method, url })`, schema/contract-driven routes, and helper-registered routes where the method binds to a **variable** path (e.g. `getAPIs(instance, '/')` -> `fastify.get(path, ...)` inside the helper). So a package can have a real API and still show **zero endpoints in the findings**.

Explore further if EITHER:
1. findings are empty, OR
2. a package in the **Framework signals** block has a server framework (deps or markers like `fastify()` / `FastifyInstance`) but a low "inline routes matched" count - that mismatch is the signature of a route style our regex doesn't cover. (E.g. a package showing `fastify`, `@fastify/swagger`, `fastify()` markers but only a handful of matched routes almost certainly has many more.)

When you explore, read that package's **server entry** - the file that calls `.register(...)` / attaches the route modules - and enumerate endpoints from there, combining each `{ prefix }` with the paths inside. As a fallback, run Grep with:
```
((app|router|fastify|api|server|instance)\.(get|post|put|delete|patch|all|route)\(|@(Get|Post|Put|Delete|Patch|Controller)\()
```
Glob: `*.{js,ts,mjs,cjs}`. Use `output_mode: "content"`.

## Step 3 - Group endpoints into APIs

If all endpoints come from a single directory / single package.json, emit one API. In a monorepo with multiple package.json files, emit one API per package that has its own endpoints - use `rootDir` relative to the repo root.

## Step 4 - Output JSON

Output ONLY this JSON block - no explanation before or after:
```json
{
  "apis": [
    {
      "name": "Public API",
      "rootDir": ".",
      "framework": "Fastify",
      "language": "javascript",
      "existingOasFile": null,
      "frameworkCanGenerateOas": false,
      "endpoints": ["GET /pets", "POST /pets", "GET /pets/:id"],
      "internalEndpoints": ["GET /health", "GET /admin/users"]
    }
  ]
}
```

Set `language` to `"javascript"` or `"typescript"` based on the file extensions in the findings.

For `existingOasFile`: pick the best candidate from the findings list. Prefer shallower paths and OpenAPI 3.x over Swagger 2.0. Set to `null` if none.

## Internal endpoint signals
Paths containing: `/internal/`, `/admin/`, `/_/`, `/debug/`, `/health`, `/metrics`, `/status`. Files named `admin` or `internal`.

## OAS generation support
Set `frameworkCanGenerateOas: true` when the package's entry in the **Framework signals** block is marked OAS-capable (e.g. `OAS-capable via @fastify/swagger`), or if you otherwise see one of these imports in files you already read: `@fastify/swagger`, `@nestjs/swagger`, `swagger-jsdoc`, `tsoa`, `express-openapi`. Don't search separately.
