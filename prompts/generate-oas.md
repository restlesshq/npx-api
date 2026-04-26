Generate a complete OpenAPI 3.0 specification (YAML format) for the API named "{{name}}" in this codebase.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

{{existingOasNote}}

{{frameworkNote}}

The base URL / server for the API is: {{domain}}

{{internalNote}}

Important:
- Write the file to {{oasFile}}
- Create the parent directory if it doesn't exist
- Include all public endpoints with their methods, paths, parameters, request bodies, and response schemas
- Be as accurate as possible based on the actual code
- Include descriptions for each endpoint
