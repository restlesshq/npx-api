The user already has an OpenAPI / Swagger spec for their API, or a way to produce one, and described where it is in their own words. Your job is to make a valid spec end up at the exact path below - by finding an existing file or running the project's own generation, NOT by hand-writing one.

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files. NEVER read files inside node_modules/.**

The user said:

> {{userInstruction}}

Treat that as authoritative - it is the best description of where their spec lives or how it gets generated.

Do this, in order:

1. **Find an existing spec.** Use the description to locate an OpenAPI/Swagger file already in the repo (a `.json`, `.yaml`, or `.yml` whose top level has `openapi` or `swagger`). The description may name a folder, a filename, a package, or a route. If you find the right one, copy it to the destination path below.

2. **Run the project's own generation.** If the description points at a build/generate step rather than a file (e.g. "run the openapi script", "it's emitted by the gateway build"), look at `package.json` scripts (and any obvious Makefile / task runner the repo already defines) for a command that generates the spec, run it, then copy the produced spec to the destination path. Only run commands the project already defines - do NOT install packages, do NOT add scripts, do NOT modify `package.json`.

3. **Write the result to EXACTLY this absolute path: {{oasFile}}** - do not write anywhere else, do not walk up the tree to a parent project's `.restless/`, do not "find a better spot". If the parent directory doesn't exist, create it. If the source is YAML, you may copy it as-is (the extension can stay `.yaml`); if it's JSON, keep it JSON. The file must be a single valid spec.

If you genuinely cannot find an existing spec and the project has no generation step that produces one, **do nothing** - do not hand-write a spec from scratch, and do not write a placeholder. Leaving the destination path empty is the correct signal that this approach didn't work; the CLI will ask the user how to proceed.
