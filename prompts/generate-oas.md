Generate a complete OpenAPI 3.0 specification (**JSON format**) for the API named "{{name}}" in this codebase.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

{{existingOasNote}}

{{frameworkNote}}

The base URL / server for the API is: {{domain}}

{{internalNote}}

Important:
- **Output JSON, not YAML. Write the file to EXACTLY this absolute path: {{oasFile}}** - do not write to any other location, do not walk up the tree to a parent project's `.api/` directory, do not "find a better spot." If the parent directory of that path doesn't exist, create it. The path is absolute so there's nothing to resolve.
- The file must be valid JSON: every key and string value double-quoted, no trailing commas, no comments.
- Include all public endpoints with their methods, paths, parameters, request bodies, and response schemas.
- Be as accurate as possible based on the actual code.
- Include descriptions for each endpoint. JSON handles colons and special characters in description strings without any escaping concerns - just make sure the surrounding quotes are correct.
