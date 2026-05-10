Verify that the Restless SDK was installed correctly in this {{language}} project.

For JavaScript / TypeScript projects, the package is `@restlessai/sdk`. Check:
- It appears in `package.json` dependencies.
- The server entry point imports the SDK (e.g. `require('@restlessai/sdk')` or `import restless from '@restlessai/sdk'`). Framework-specific subpaths like `@restlessai/sdk/express` also work but are no longer the recommended form.
- The middleware/plugin is registered BEFORE any route definitions.
- `process.env.RESTLESS_KEY` is referenced (the SDK reads this automatically).

For other languages, check for the language-appropriate Restless package (`restlessai` on PyPI / RubyGems, `github.com/restlessai/go` in Go).

Just verify - don't fix anything. Report whether it's working.
