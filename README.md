# npx api init

Restless makes sure every 🔴 400 Bad Request turns out 🟢 200 Okay.

It's not just another observability platform (although you can use it to see what your users are up to!).

Think of us more as an API success platform. We give humans, AI and you the tools to quickly make successful calls.

# What lands in your project

 - `.restless/` — your API's OpenAPI spec plus the settings the SDK reads at
   startup. **Commit it with your code.** It's configuration, not a build
   artifact, and it holds no credentials.
 - `RESTLESS_KEY` in `.env` — your project's write key. Keep this out of git.

# Running inside a coding agent

If you run `npx api init` inside Claude Code or Codex, it doesn't quietly drive
its own AI through your codebase. It prints the setup as instructions for the
agent you're already talking to, so the work happens in front of you — you see
every diff and can stop or redirect it. Your agent handles reading the code,
writing the spec, and wiring the middleware; these commands cover the parts
that shouldn't be improvised:

| command | what it does |
| ------- | ------------ |
| `npx api guide [oas\|sdk]` | Prints the spec-writing / SDK-wiring instructions |
| `npx api key` | Registers the project and writes `RESTLESS_KEY` to `.env` |
| `npx api register --oas <file>` | Records a spec in `.restless/settings.json` (rejects localhost servers) |
| `npx api verify --url <url>` | Sends one request, confirms the SDK saw it and the log landed |
| `npx api login` | Prints the URL you open to claim the project |

Re-running is safe: an unchanged key keeps its existing project rather than
registering a new one. `npx api key` writes the key straight to `.env` and never
echoes it into the agent's transcript; pass `--inline` if you explicitly want it
on stdout instead. It also reports whether git ignores that env file
(`envIgnoredByGit`), so the key can't slip into a commit unnoticed.

Running in a plain terminal? Setup asks whether it can use your local agent.
Answer "No, other options" to copy that same prompt for an agent elsewhere, set
it up by hand with the commands above, book a call, or ask questions first.

Want the guided flow instead, with the CLI doing the work? `npx api init --self-drive`.

# Privacy

 - The setup will use AI, but won't use it without asking first.
 - It uses your local AI, so no code will be sent to our servers.
 - Inside a coding agent, the AI doing the work is the one you're already
   using — nothing extra is spawned behind your back.
