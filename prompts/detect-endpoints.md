Analyze this codebase and discover all APIs. Follow these steps in order:

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files. They contain sensitive credentials. Only look at source code files.**

1. **Find all APIs in the project.** There may be more than one (e.g. a public API and an internal admin API, or multiple microservices). Look for separate route files, separate servers, or distinct base paths that indicate distinct APIs.

2. **Check for existing OpenAPI/Swagger spec files.** Look for files like `openapi.yaml`, `openapi.json`, `swagger.yaml`, `swagger.json`, or similar in common locations (root, docs/, spec/, etc).

3. **Check if the framework can generate an OAS file.** Some frameworks (e.g. Fastify with @fastify/swagger, Django REST Framework, NestJS) have built-in or plugin-based OAS generation. Note if this is available.

4. **Identify internal endpoints.** Flag endpoints that are likely internal/not meant to be public. Signs of internal endpoints include:
   - Routes behind auth middleware named things like `isAdmin`, `requireAdmin`, `internalOnly`
   - Paths containing `/internal/`, `/admin/`, `/_/`, `/debug/`, `/health`, `/metrics`, `/status`
   - Routes in files named `admin`, `internal`, `debug`, etc.
   - Endpoints that manage the system itself rather than serve the API's domain

5. **For each API found**, identify:
   - A short descriptive name (e.g. "Public API", "Admin API", "Webhook Service")
   - The root directory where its code lives (relative path)
   - What framework is being used
   - What language
   - All endpoints with HTTP methods and paths
   - Which endpoints appear to be internal (list them separately)
   - Whether an existing OAS file was found (and its path)
   - Whether the framework supports OAS generation natively

Output a JSON block with your findings:
```json
{
  "apis": [
    {
      "name": "Public API",
      "rootDir": ".",
      "framework": "Fastify",
      "language": "javascript",
      "existingOasFile": null,
      "frameworkCanGenerateOas": false,
      "endpoints": ["GET /pets", "POST /pets", "GET /pets/:id"],
      "internalEndpoints": ["GET /health", "GET /admin/users"]
    }
  ]
}
```
