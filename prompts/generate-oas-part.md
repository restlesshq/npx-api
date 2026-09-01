You are generating **one part of a larger OpenAPI 3.0 specification** for the API named "{{name}}". Several parts are being generated at the same time and the CLI merges them, so your job is narrow: describe **only** the endpoints listed below, completely and accurately.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

**The project's source files are reproduced in this prompt (see below). Do not re-read them with the Read tool, and do not `ls` or `grep` to find them - you already have them. Reach for a tool only for a file that genuinely is not in this prompt. Every tool call costs the user several seconds of waiting.**

## Your part

You own the endpoints declared in these files, and nothing else:

{{groupFiles}}

Which is this list of routes:

{{groupRoutes}}

**These paths are written as they appear in each file, so they are RELATIVE to wherever that router gets mounted.** A `GET /:id` in a router mounted at `/api/v1/projects` is `/api/v1/projects/{id}` in the spec. Find each router's mount (the `app.use(...)` / `router.use(...)` / equivalent, in the source below) and prepend the prefix. If a prefix comes from a variable or config value, resolve it from the source.

{{internalNote}}

{{sourceFiles}}

## What to write

Write a JSON object to EXACTLY this absolute path: **{{partFile}}**

Do not write to any other location. Do not create or touch `{{oasFile}}` - that is the merged file and the CLI owns it. If the parent directory of your part file doesn't exist, create it.

The object has **only these top-level keys**:

```json
{"paths":{...},"components":{...},"tags":[...]}
```

- **`paths`** - one entry per endpoint you own, with methods, parameters, request bodies and response schemas. Model the real request/response shapes from the source.
- **`components`** - the schemas (and any responses/parameters) your paths `$ref`. Only what your own paths reference.
- **`tags`** - the tags your operations use, as `{"name":"...","description":"..."}`.

**Do NOT include `openapi`, `info`, or `servers`.** The CLI supplies those when it merges; emitting them wastes your output and they are discarded.

## Rules that keep the parts mergeable

Other parts are being written concurrently by other workers, and the merge keeps the first definition of any duplicated name. So:

- **Name your schemas after your own resources** (`Project`, `ProjectCreate`, `TaskComment`). Do not invent generic wrappers another part would also define.
- **If the API needs a security scheme, use exactly these names** so every part agrees: `bearerAuth` for a bearer/JWT token, `apiKeyAuth` for an API key in a header, `basicAuth` for HTTP basic. Put it in `components.securitySchemes` and reference it with `security` on the operations that require it.
- **A shared error schema, if you need one, must be named exactly `Error`** with `{"type":"object"}` shape plus whatever fields the code actually returns. Every part naming it the same way is what stops four near-identical copies.
- Only describe endpoints from YOUR files. Another part owns the rest, and duplicating them wastes output and creates conflicts.

## Formatting

- The file must be valid JSON: every key and string value double-quoted, no trailing commas, no comments.
- **Write the JSON COMPACT - no indentation, no newlines between keys, no spaces after `:` or `,`.** One long line is exactly what we want. The CLI re-indents the merged file, so the committed spec ends up properly formatted; every space you emit yourself is a token the user waits for.
- Include a short `description` for each operation. Keep them to a sentence.
