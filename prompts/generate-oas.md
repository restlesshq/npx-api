Generate a complete OpenAPI 3.0 specification (**JSON format**) for the API named "{{name}}" in this codebase.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

{{existingOasNote}}

{{frameworkNote}}

The base URL / server for the API is: {{domain}}

{{internalNote}}

{{endpointChecklist}}

Important:
- **Output JSON, not YAML. Write the file to EXACTLY this absolute path: {{oasFile}}** - do not write to any other location, do not walk up the tree to a parent project's `.restless/` directory, do not "find a better spot." If the parent directory of that path doesn't exist, create it. The path is absolute so there's nothing to resolve.
- The file must be valid JSON: every key and string value double-quoted, no trailing commas, no comments.
- **The `.restless/` directory you're writing into is committed with the user's code.** It's configuration the SDK reads at runtime, not a generated cache. Never add it to `.gitignore`, and include it in any commit you make for the user.
- Include all public endpoints with their methods, paths, parameters, request bodies, and response schemas.
- **Path coverage is mandatory and is checked afterward.** Every path in the checklist above must appear in `paths` - do not skip or summarize the large/nested trees. If you're running low on room, prefer terser descriptions over dropping endpoints; a path with a thin schema still beats a missing path.
- Be as accurate as possible based on the actual code.
- Include descriptions for each endpoint. JSON handles colons and special characters in description strings without any escaping concerns - just make sure the surrounding quotes are correct.
