The OpenAPI spec at {{oasFile}} is missing operations for some endpoints that exist in the code. Add them.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

The spec already exists and is valid JSON. Do NOT rewrite it from scratch, do NOT remove or renumber anything already there, and do NOT drop existing paths, schemas, tags, or descriptions. You are only ADDING the missing operations listed below.

## Missing endpoints
Each line is the HTTP method(s), the URL path, and the source file that implements it:

{{missingList}}

## What to do
For each missing endpoint:
- Read the listed source file to model the real path/query parameters, request body, and response shape. Be accurate to the actual code.
- Add the operation(s) under the correct entry in `paths` (create the path entry if it doesn't exist yet). Path parameters use the `{name}` form already shown in the path.
- Reuse existing `components/schemas` where they fit; several of them may already have been defined for exactly these endpoints. Add new schemas only when nothing existing matches.
- Include a description for each operation. If an endpoint looks internal/admin, tag it with `x-internal: true` and add it to an "Internal" tag, matching how the rest of the spec treats internal endpoints.

## Output
Write the updated spec back to EXACTLY this absolute path: {{oasFile}} - do not write anywhere else. It must stay valid JSON: every key and string value double-quoted, no trailing commas, no comments.
