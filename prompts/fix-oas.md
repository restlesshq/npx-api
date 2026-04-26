The OpenAPI spec at {{oasFile}} won't parse. Fix it.

Parser error:
```
{{parseError}}
```

**IMPORTANT: NEVER read .env, .env.local, or any environment/secret files.**

What to do:
- Read {{oasFile}}.
- Identify the syntax issue. For JSON: usually a missing/extra comma, an unescaped quote inside a string, or an unterminated string.
- Rewrite the file as valid JSON. Every key and string value double-quoted, no trailing commas, no comments.
- Preserve every endpoint, parameter, and schema. Don't drop content to make it parse.
- Write the corrected file back to {{oasFile}}.
