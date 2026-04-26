Generate a complete OpenAPI 3.0 specification (**JSON format**) for the API named "{{name}}" in this codebase.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

{{existingOasNote}}

{{frameworkNote}}

The base URL / server for the API is: {{domain}}

{{internalNote}}

Important:
- Output JSON, not YAML. Write the file to {{oasFile}}.
- The file must be valid JSON: every key and string value double-quoted, no trailing commas, no comments.
- Create the parent directory if it doesn't exist.
- Include all public endpoints with their methods, paths, parameters, request bodies, and response schemas.
- Be as accurate as possible based on the actual code.
- Include descriptions for each endpoint. JSON handles colons and special characters in description strings without any escaping concerns — just make sure the surrounding quotes are correct.
