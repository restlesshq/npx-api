import fs from 'fs';
import path from 'path';
import { loadSettings } from './settings.js';
import { findFrameworkSignals } from './find-endpoints.js';

/**
 * The playbook `npx api init` prints when a coding agent is driving it.
 *
 * The alternative - and what the CLI used to do in this situation - is to
 * spawn its own model and edit the user's code from inside a child process.
 * That works, but from the caller's seat it's a black box: no diffs, no way
 * to steer it, no way to tell a stuck run from a slow one, and a second
 * agent reasoning about a repo the calling agent already understands.
 *
 * So when an agent is detected we stop being an actor and become a
 * toolkit: state what we know about the repo, hand over the same guides our
 * own model would have used, and name the deterministic commands worth
 * calling back into. The agent does the code work in the open, where the
 * user can watch and interrupt it.
 *
 * What stays ours (and why): key generation and project registration
 * (credentials, plus a server round-trip), the shape of the SDK init line
 * (it has a canonical form the CLI repairs on every run), and the runtime
 * check (it reads response headers the agent shouldn't have to parse).
 * Everything else - reading the code, writing the spec, wiring middleware -
 * is exactly what the calling agent is already good at.
 */

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function countEndpoints(absPath) {
  try {
    const oas = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    let n = 0;
    for (const ops of Object.values(oas?.paths || {})) {
      for (const m of Object.keys(ops || {})) if (HTTP_METHODS.has(m.toLowerCase())) n++;
    }
    return n;
  } catch {
    return null;
  }
}

/**
 * What we can say about this repo without running a model: which APIs are
 * already mapped, and what the deterministic scan found. Keeps the playbook
 * concrete ("wire benefits-api/index.js") instead of generic.
 */
export function repoFacts({ rootDir, signals }) {
  const settings = loadSettings(rootDir);
  const mapped = [];
  for (const api of settings.apis || []) {
    if (!api.oasFile) continue;
    const abs = path.join(rootDir, api.oasFile);
    if (!fs.existsSync(abs)) continue;
    mapped.push({
      name: api.name,
      oasFile: api.oasFile,
      rootDir: api.rootDir || '.',
      framework: api.framework || null,
      language: api.language || null,
      projectId: api.projectId || null,
      endpoints: countEndpoints(abs),
    });
  }
  // Only scan when nothing is mapped: mapped facts win the rendering anyway,
  // and skipping the walk keeps re-runs instant. Callers (tests) can still
  // inject signals explicitly.
  if (!signals) signals = mapped.length ? [] : scanForSignals(rootDir);
  return { mapped, signals };
}

/** The deterministic framework scan, downgraded to "no facts" on any error. */
function scanForSignals(rootDir) {
  try {
    return findFrameworkSignals(rootDir);
  } catch {
    return [];
  }
}

function facts({ mapped, signals }) {
  const lines = [];
  if (mapped.length) {
    lines.push('Already mapped in `.restless/` (from a previous run):');
    for (const m of mapped) {
      const bits = [
        m.endpoints === null ? 'unreadable spec' : `${m.endpoints} endpoints`,
        m.framework || m.language,
        m.rootDir === '.' ? './' : `./${m.rootDir}`,
      ].filter(Boolean);
      lines.push(`- **${m.name}** - \`${m.oasFile}\` (${bits.join(', ')})`);
    }
    lines.push('');
    lines.push('If the user wants one of these set up again, reuse the spec instead of regenerating it. Only re-map an API whose spec is missing, unreadable, or out of date with the code.');
  } else if (signals.length) {
    lines.push('Found by a deterministic scan of dependencies and source (no model involved, so verify before trusting):');
    for (const s of signals.slice(0, 6)) {
      const where = s.package === '.' ? './' : `./${s.package}/`;
      const framework = (s.frameworkDeps?.length ? s.frameworkDeps : s.sourceMarkers || []).join(', ');
      const bits = [];
      if (framework) bits.push(framework);
      if (s.endpointCount) bits.push(`${s.endpointCount} route${s.endpointCount === 1 ? '' : 's'} spotted inline`);
      if (s.oasGenDeps?.length) bits.push(`can generate its own spec via ${s.oasGenDeps.join(', ')}`);
      lines.push(`- \`${where}\`${s.name ? ` (${s.name})` : ''}${bits.length ? ` - ${bits.join('; ')}` : ''}`);
    }
    if (signals.length > 6) lines.push(`- ...and ${signals.length - 6} more.`);
    if (signals.length > 1) {
      lines.push('');
      lines.push('More than one API candidate. Ask the user which one to set up before starting - do not pick for them.');
    }
  } else {
    lines.push('Nothing is mapped yet, and a scan of dependencies and source found no framework it recognizes. Find the API yourself before starting.');
  }
  return lines.join('\n');
}

/**
 * Build the playbook. `cli` is how the user invoked us (`api`, `api-beta`),
 * so the commands we print are the ones that actually exist on their PATH.
 */
export function buildAgentPlan({ rootDir, cli = 'api', agent = 'your agent' }) {
  const { mapped, signals } = repoFacts({ rootDir });
  const npx = (cmd) => `npx ${cli} ${cmd}`;

  return `# Restless setup - instructions for ${agent}

You ran \`${npx('init')}\` inside a coding agent. Rather than editing this repo from
a hidden sub-agent, here is the whole job so you can do it in the open, where the
user can see the diffs and stop you.

Work through the steps in order. Each one says what to do and which command to
call for the parts you should not hand-roll.

## What we already know

${facts({ mapped, signals })}

## Step 1 - map the API to an OpenAPI spec

Goal: \`.restless/openapi.json\` describing every endpoint the server exposes.

1. Run \`${npx('guide oas')}\` and follow it. It is the same instruction set the CLI's
   own model uses: required fields, path coverage, the exact output location.
2. **Check whether the project can generate the spec itself first.** If it already
   has \`@fastify/swagger\`, NestJS's Swagger module, drf-spectacular, FastAPI's
   \`/openapi.json\`, or a committed spec that is merely stale, that output beats
   anything inferred by reading routes. Run it, or point at what exists.
3. Otherwise read the routes and write the spec. Don't guess from folder names,
   and don't drop endpoints to save room - coverage gets checked later.
4. **Get \`servers[0].url\` right.** It is the API's real base URL, including any
   mount prefix (\`/api\`, \`/v1\`) - later steps test against it. Work it out from
   the code and config: the mount path in the server file, \`package.json\` scripts,
   framework config, \`docker-compose.yml\` ports, the README's own curl examples.
   Ask the user if it stays ambiguous; a wrong base URL fails step 3 confusingly.
5. Register it so the SDK and later commands can find it:

   \`\`\`
   ${npx('register --oas .restless/openapi.json --dir <dir-with-package.json> --name "<API name>"')}
   \`\`\`

Never read \`.env\` files or anything under \`node_modules/\` while doing this. If you
need the port and it only exists in \`.env\`, ask the user rather than opening it.

## Step 2 - install and wire the SDK

1. Get the project's key. This one is ours: it generates the key, registers the
   project, and writes \`RESTLESS_KEY\` to the right \`.env\`:

   \`\`\`
   ${npx('key --json')}
   \`\`\`

   It prints \`{ "projectId": "...", "envFile": "..." }\`. The key itself never appears
   in your output - it goes straight into the env file named there. Do not invent a
   key, and do not read it back out of \`.env\`.
2. Install the SDK: \`npm install @restlessai/sdk --save\` (or the project's package
   manager) in the directory that owns the server's \`package.json\`.
3. Run \`${npx('guide sdk')}\` and follow it exactly. The critical part is *where* the
   middleware goes: above every guard that can reject a request, so the SDK still
   sees a 401. The guide covers each framework, the \`owner.id\` rules, and the
   \`sdk.mask()\` gotchas.

## Step 3 - prove it works

Start the server yourself, in the background, the way the project normally starts
(\`npm run dev\`, \`npm start\`, the command in the README). You don't need to load
\`.env\` specially - the SDK finds \`RESTLESS_KEY\` on its own. Only hand this to the
user if you genuinely can't run it (a database you can't provide, secrets, docker):
then ask them to start it in another terminal and wait for their go-ahead.

Once it's listening, point the check at the base URL you established in step 1
(host, port, and any mount prefix - don't assume \`:3000\`, and if the app is
containerized use the published port, not the internal one):

\`\`\`
${npx('verify --url http://localhost:<port> --path /<an-existing-route> --json')}
\`\`\`

It sends a real request and reads the response headers, reporting one of:

- \`ok\` - the SDK saw the request. Done.
- \`no-sdk\` - the request never reached the SDK. Almost always middleware order:
  something above it answered first. Fix the order and re-run.
- \`no-key\` - the SDK ran but \`RESTLESS_KEY\` is not in the server's environment.
  Usually the server needs a restart, or it does not load \`.env\`.
- \`unreachable\` - nothing is listening. Check the port with the user.

A non-2xx status is fine here. A 401 that the SDK captured is a pass - capturing
rejected requests is the point.

If you started the server for this check, shut it down once the check passes -
don't leave an orphaned process running.

## Step 4 - let the user claim the project

\`\`\`
${npx('login')}
\`\`\`

Prints a URL. Hand it to the user - they open it, sign in, and the project
becomes theirs. Do not open a browser yourself.

## Rules

- \`.restless/\` is committed with the code. It is configuration the SDK reads at
  startup, not a cache. Never add it to \`.gitignore\`; include it in commits.
- \`.env\` holds the key and stays out of git. Never read it, never print it.
- Do not touch \`package.json\` scripts, \`tsconfig\`, \`Dockerfile\`, or CI config.
- Keep the diff small: the spec, the SDK wiring, \`.restless/\`, and \`.env\`.

Prefer the guided experience? \`${npx('init --self-drive')}\` runs the original flow, where
the CLI does all of this itself.
`;
}
