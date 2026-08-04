# npx api init

Restless makes sure every 🔴 400 Bad Request turns out 🟢 200 Okay.

It's not just another observability platform (although you can use it to see what your users are up to!).

Think of us more as an API success platform. We give humans, AI and you the tools to quickly make successful calls.

# What lands in your project

 - `.restless/` - your API's OpenAPI spec plus the settings the SDK reads at
   startup. **Commit it with your code.** It's configuration, not a build
   artifact, and it holds no credentials.
 - `RESTLESS_KEY` in `.env` - your project's write key. Keep this out of git.

# Running inside a coding agent

If you run `npx api init` inside Claude Code or Codex, it doesn't quietly drive
its own AI through your codebase. It prints the setup as instructions for the
agent you're already talking to, so the work happens in front of you: you see
every diff and can stop or redirect it. Your agent handles reading the code,
writing the spec, and wiring the middleware; these commands cover the parts
that shouldn't be improvised:

| command | what it does |
| ------- | ------------ |
| `npx api guide [oas\|sdk]` | Prints the spec-writing / SDK-wiring instructions |
| `npx api key` | Registers the project and writes `RESTLESS_KEY` to `.env` |
| `npx api register --oas <file>` | Records a spec in `.restless/settings.json` (rejects localhost servers) |
| `npx api verify --url <url>` | Sends one request, confirms the SDK saw it, the log landed, and no owner-id placeholder remains |
| `npx api login` | Prints the URL you open to claim the project |

Re-running is safe: an unchanged key keeps its existing project rather than
registering a new one - even when `.restless/` is gone, `npx api key` re-adopts
the project this machine first registered the key to, and if the key on disk
can't be matched to any known project it mints a fresh key (replacing the `.env`
line) instead of re-registering the old one into a project its logs would never
reach. It writes the key straight to `.env` and never echoes it into the agent's
transcript; `--inline` prints it on stdout instead, but only for humans - under
a coding agent it refuses. It also reports whether git ignores that env file
(`envIgnoredByGit`), so the key can't slip into a commit unnoticed.

Running in a plain terminal? Setup asks whether it can use your local agent.
Answer "No, other options" to copy that same prompt for an agent elsewhere, set
it up by hand with the commands above, book a call, or ask questions first.

Want the guided flow instead, with the CLI doing the work? `npx api init --self-drive`.

# After you've claimed a project

`npx api init` stays safe to re-run, and it notices what's already there: an API
you've mapped is offered back to you instead of being re-scanned, and a project
you've already claimed finishes without asking you to claim it a second time.

Changing things afterwards is `npx api update`, not another `init`. It edits
settings (name, base URL, visibility, request prefix) and refreshes your spec,
then pushes both to the dashboard.

Refreshing means whatever it meant the first time, because setup records where
your spec came from:

| your spec came from | what "refresh" does | checked automatically |
| ------------------- | ------------------- | --------------------- |
| a URL | re-fetches that URL | yes |
| a file you maintain | re-reads it. We never regenerate over your file | yes |
| a command or location you described | runs that again | yes |
| your framework's generator | runs it again, then fills gaps from your routes | yes |
| our AI reading your routes | reads them again | on request |

Anything with a source to go back to gets checked before `update` asks you
anything, so it opens with whether your spec actually changed:

```
$ npx api update
  Your spec changed (3 endpoints now)

    + GET /pets/{id}
    + POST /pets

  Update the spec and sync your settings? [Y/n]
```

Say no and you get the full menu instead.

Nothing touches your spec before you answer, on any path through `update`: every
refresh - re-fetching a URL, replaying a recorded command, regenerating from your
routes - is written to a scratch directory and only moved into place once you
agree. If it fails, or you say no, the file you already had is exactly as it was.

It checks the dashboard too, which is the other way a spec goes out of date:

```
$ npx api update
  ! Your dashboard is missing 2 endpoints that your spec has:
    + GET /api/v1/projects/{}/feedback
    + PATCH /api/v1/projects/{}/feedback/{}

  Your local .restless/openapi.json is already up to date.

  Push it to the dashboard? [Y/n]
```

Those are separate questions. Your local file can be perfectly current while the
dashboard serves something from weeks ago, and that's the one you notice, because
it's what your docs and AI chat answer from. Comparing needs an authorized
session, so if this machine hasn't been authorized yet the check says so instead
of guessing.

When there's genuinely nothing to do, it says so and ends:

```
  ✓ Your spec is unchanged (34 endpoints).
  ✓ Your dashboard is serving this version.

  Press Enter to exit, or s to edit settings.
```

The exception is a spec our AI wrote from your routes. There's no source to go
back to, so re-checking it means reading your whole codebase again from scratch
- a decision rather than a status check. You'll see what you have and can ask
for that explicitly.

If a refresh would remove endpoints from your docs, it says so and asks.
Regenerating from your routes is always available as an explicit choice, and it
writes to `.restless/openapi.json` rather than overwriting a spec you wrote
yourself - when that changes which file your project points at, the confirm says
so before you answer, not afterwards.

`update` also runs without prompts when you tell it exactly what to do, which is
what a coding agent or a CI job needs. Run it inside Claude Code or Codex with
no flags and it prints these rather than trying to drive a picker nobody can
answer:

```
npx api update --status --json     # did the spec change? writes nothing
npx api update --refresh --json    # re-run its source, then push spec + settings
npx api update --oas <file|url>    # point at a different spec and push it
npx api update --base-url https://api.acme.com
npx api update --sync              # push settings with no edits
```

Also `--name`, `--internal` / `--external`, `--prefix`, and `--project <id>` to
pick one API in a multi-API repo.

`--status` is the read-only one: no writes, nothing pushed. It answers two
separate questions, because they have different answers:

```json
{
  "specChanged": false,
  "dashboard": { "behind": true, "missing": ["GET /api/v1/projects/{}/feedback"] }
}
```

`specChanged` is "is my local file stale against its own source". `dashboard` is
"is what Restless serves stale against my local file". It never triggers a
browser login, so `dashboard.status` is `unauthorized` when this machine has no
session yet.

It's deliberately narrower than what the interactive flow checks. A URL or a
file it can answer instantly; re-running a recorded command or a framework
generator needs an agent, and having a status check spawn one defeats the point
of asking first. Those report `checkable: false` and point at `--refresh`, which
is the explicit "yes, do the expensive thing".

Local edits are saved before anything is pushed, so a sync that can't reach us
never discards them: `--json` reports `synced` separately from `ok` and says why.
Authorizing a machine needs a browser once; after that the session is reused for
24 hours.

# Privacy

 - The setup will use AI, but won't use it without asking first.
 - It uses your local AI, so no code will be sent to our servers.
 - Inside a coding agent, the AI doing the work is the one you're already
   using, and nothing extra is spawned behind your back.
