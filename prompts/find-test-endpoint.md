Read the OpenAPI spec at {{oasFile}}. Generate a realistic curl command to test this API.

Requirements:
- Pick a safe, non-destructive endpoint (prefer GET list endpoints, avoid DELETE or dangerous mutations)
- If the endpoint requires path parameters, fill them with realistic example values (e.g. `1`, `abc-123`)
- Authentication is MANDATORY whenever the spec's top-level `security` or the operation's `security` is non-empty. Check BOTH places; a per-operation `security` overrides the global one. Only omit auth if the matching requirement is `security: []` or neither is set.
  - For `type: http, scheme: bearer` → add `-H "Authorization: Bearer API_KEY_HERE"`
  - For `type: http, scheme: basic` → add `-H "Authorization: Basic API_KEY_HERE"`
  - For `type: apiKey, in: header` → add `-H "<name>: API_KEY_HERE"`
  - For `type: apiKey, in: query` → append `?<name>=API_KEY_HERE` to the URL
  - For `type: apiKey, in: cookie` → add `-H "Cookie: <name>=API_KEY_HERE"`
- If it's a POST/PUT that needs a request body, include a minimal valid JSON body with required fields filled in with realistic example data
- The base URL should be `BASE_URL_HERE` (we'll replace it)
- Make sure `API_KEY_HERE` appears as the very last thing in the command, for easy editing

Output ONLY a JSON block:
```json
{ "curl": "curl -sS BASE_URL_HERE/pets -H \"Authorization: Bearer API_KEY_HERE\"" }
```
