Generate a complete OpenAPI 3.0 specification (YAML format) for the API named "{{name}}" in this codebase.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

{{#existingOasFile}}
An existing OAS file was found at {{existingOasFile}}. Use it as a starting point — update it if the code has diverged, but preserve any hand-written descriptions or examples.
{{/existingOasFile}}

{{#frameworkCanGenerateOas}}
This framework ({{framework}}) supports generating an OAS file natively. Try using the framework's built-in OAS generation first. If it doesn't produce a complete spec, fill in the gaps manually.
{{/frameworkCanGenerateOas}}

The base URL / server for the API is: {{domain}}

{{#internalEndpoints}}
The following endpoints were detected as internal/admin and should be marked as such:
{{internalEndpoints}}

For internal endpoints: include them in the spec but tag them with `x-internal: true` and add them to a tag called "Internal". This way they're documented but can be filtered out by tools that consume the spec.
{{/internalEndpoints}}

Important:
- Write the file to {{oasFile}}
- Create the parent directory if it doesn't exist
- Include all public endpoints with their methods, paths, parameters, request bodies, and response schemas
- Be as accurate as possible based on the actual code
- Include descriptions for each endpoint
