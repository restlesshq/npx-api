You are identifying how the API at `{{rootDir}}` accepts credentials, so the Restless SDK can redact them from captured request logs before they leave the customer's server.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

## Goal

Output a JSON object that lists:

- **Headers** whose values carry credentials / secrets (e.g. `Authorization`, `X-API-Key`, custom auth headers).
- **Query-string parameters** whose values carry credentials (e.g. `?api_key=...`, `?access_token=...`).
- **Request-body JSON field names** whose values carry credentials or PII (e.g. `password`, `token`, `ssn`, `credit_card`).

The SDK already redacts the common defaults (`Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-API-Key`, `X-Auth-Token`, and body/query names like `password`, `token`, `secret`, `apiKey`, `accessToken`, `sessionId`, `ssn`, `creditCard`, `cvv`). **Only list things that are NOT already covered by those defaults.** Matching is case-insensitive and ignores `-` / `_`, so `api-key` / `api_key` / `apiKey` all count as "covered."

## Where to look

1. **The OpenAPI spec, if there is one** - `{{oasFile}}`. The `components.securitySchemes` block tells you exactly what headers / query params this API accepts for auth. Read this first.
2. **The source code** - look for middleware, auth decorators, route guards, and any `req.headers[...]` / `req.query[...]` reads that are gated by auth checks. Frameworks vary: Express has middleware, Fastify has hooks, Koa has `ctx.state`, Next has `headers()` helpers.
3. **The route handlers** for fields that take passwords, secrets, or sensitive PII in the request body.

## Rules

- Output ONLY the JSON block below. No prose.
- List names in their natural form - the SDK normalizes them (strips `-`/`_`, lowercases) when matching, so `X-Company-Auth` and `x_company_auth` both work.
- Err on the side of inclusion if you're unsure whether a field is sensitive. Over-redaction is cheap; under-redaction leaks secrets.
- Do NOT include the built-in defaults listed above.
- Do NOT read files in `node_modules/`, `.env*`, or any credentials file.
- If there's no OAS and no obvious auth in the code, return empty arrays.

## Output

```json
{
  "headers": ["x-company-auth", "x-signed-request"],
  "queryParams": ["signed_token"],
  "bodyKeys": ["ssh_private_key", "recovery_code"]
}
```
