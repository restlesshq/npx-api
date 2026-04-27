Pick the single best endpoint to use as a "hello world" demo endpoint for this API.

We've already filtered to safe candidates (GET/HEAD only, no admin/internal/deprecated paths) and ranked them by simplicity. Your job is just to pick the one a developer would most expect us to hit on their behalf.

## Candidates

{{candidates}}

## How to choose

- Prefer endpoints that look like a healthcheck, status, list, or "get current user" — anything that returns useful data with the least setup.
- Prefer endpoints that don't require path params. If they all do, prefer ones whose params look like they'd accept the example value we picked.
- Avoid anything that looks expensive, paginated through massive datasets, or domain-specific (e.g. "transfer funds", "delete user data").
- The candidates are pre-ranked. If nothing stands out, pick the first one — it's the simplest.

## Output

Return ONLY a JSON block with the index (0-based) of your chosen candidate and a one-line reason:

```json
{ "index": 0, "reason": "list endpoint with no params, returns useful data immediately" }
```
