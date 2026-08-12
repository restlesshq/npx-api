Verify that the Restless SDK was installed correctly in this {{language}} project.

For JavaScript / TypeScript projects, the package is `{{sdkPackage}}`. Check:
- It appears in `{{manifest}}` dependencies.
- The server entry point imports the SDK (e.g. `require('{{sdkPackage}}')` or `import restless from '{{sdkPackage}}'`). Framework-specific subpaths like `{{sdkPackage}}/express` also work but are no longer the recommended form.
- The middleware/plugin is registered BEFORE any route definitions.
- `process.env.RESTLESS_KEY` is referenced (the SDK reads this automatically).

For other languages, check for the language-appropriate Restless package (`restlessai` on PyPI / RubyGems, `github.com/restlessai/go` in Go).

Just verify - don't fix anything. Report whether it's working.
