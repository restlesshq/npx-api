Discover all APIs in this **Node.js / TypeScript** codebase. You MUST finish within 10 tool calls. Be fast.

**NEVER read .env, .env.local, or any environment/secret files.**

{{findingsSection}}

{{hintSection}}

## Your job

The findings above already include every route our regex could find and every YAML/JSON file whose parsed content has a top-level `openapi` or `swagger` field. Treat them as authoritative — you do NOT need to re-run that search. Just synthesize them into the output JSON.

## Step 1 — Confirm the project shape (1 tool call)

Read `package.json` at the repo root (or, for a monorepo, at each sub-package's root) to identify the framework: Express, Fastify, Koa, Hono, NestJS, Next.js, etc. If you see multiple plausible candidates, look at which framework the files in the findings actually import.

If the findings show zero endpoints AND no `package.json` exists, return `{"apis": []}` immediately — we only support Node.

## Step 2 — Grep for routes ONLY if findings are empty (0–1 tool calls)

If the Findings section above already lists endpoints, skip this step. Only if findings are empty and you suspect our regex missed a framework we don't cover, run Grep with this combined pattern:
```
((app|router|fastify|api)\.(get|post|put|delete|patch|all|route)\(|@(Get|Post|Put|Delete|Patch|Controller)\()
```
Glob: `*.{js,ts,mjs,cjs}`. Use `output_mode: "content"`.

## Step 3 — Group endpoints into APIs

If all endpoints come from a single directory / single package.json, emit one API. In a monorepo with multiple package.json files, emit one API per package that has its own endpoints — use `rootDir` relative to the repo root.

## Step 4 — Output JSON

Output ONLY this JSON block — no explanation before or after:
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
Note `frameworkCanGenerateOas: true` ONLY if you see these imports in files you already read: `@fastify/swagger`, `@nestjs/swagger`, `swagger-jsdoc`, `tsoa`, `express-openapi`. Don't search separately.
