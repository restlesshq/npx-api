Read the OpenAPI spec at .api/openapi.yaml. Generate a realistic curl command to test this API.

Requirements:
- Pick a safe, non-destructive endpoint (prefer GET list endpoints, avoid DELETE or dangerous mutations)
- If the endpoint requires path parameters, fill them with realistic example values (e.g. `1`, `abc-123`)
- Include the correct authentication based on the securitySchemes in the spec (Bearer token, API key header, query param, etc.). Use `API_KEY_HERE` as the placeholder value. If the spec has no security/securitySchemes, omit auth entirely.
- If it's a POST/PUT that needs a request body, include a minimal valid JSON body with required fields filled in with realistic example data
- The base URL should be `BASE_URL_HERE` (we'll replace it)
- Make sure `API_KEY_HERE` appears as the very last thing in the command, for easy editing

Output ONLY a JSON block:
```json
{ "curl": "curl -sS BASE_URL_HERE/pets -H \"Authorization: Bearer API_KEY_HERE\"" }
```
