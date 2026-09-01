import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as debug from '../lib/debug.js';
import { isInsideRoot, getGitRoot } from '../lib/pathGuard.js';

// AI tool inputs (especially Write/Edit) carry full file contents that
// blow up the debug log size. Truncate every string field at the source
// so we still see *what* the AI did without dragging the body along.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_TOOL_INPUT_TOTAL = 2000;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function truncatedToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = truncate(v, MAX_TOOL_INPUT_FIELD);
    else out[k] = v;
  }
  // Belt-and-suspenders: if the trimmed object is still huge (lots of
  // small fields), cap the serialized form as well.
  const json = JSON.stringify(out);
  if (json.length <= MAX_TOOL_INPUT_TOTAL) return out;
  return { _truncated: json.slice(0, MAX_TOOL_INPUT_TOTAL) + `…(+${json.length - MAX_TOOL_INPUT_TOTAL} chars)` };
}

/**
 * Map a tool_use block into {phase, detail}:
 *  - phase: high-level human category (e.g. "Looking for files")
 *  - detail: the specific tool call (e.g. 'Glob *.{js,ts}')
 *
 * Phase is stable across many calls of the same category; detail changes
 * with every call.
 */
/**
 * The phase for a tool we know the name of but not yet the arguments of.
 *
 * Streaming tells us a tool_use block has STARTED before the model has
 * finished generating its input, and that gap is where the CLI used to go
 * quiet. `describeToolUse` needs the input to build its detail line, so the
 * phase is split out here to be usable a few hundred milliseconds earlier.
 *
 * Bash is the one that can't be answered from the name (the phase depends on
 * the command), so it gets the generic label until the input lands.
 */
function phaseForToolName(toolName) {
  switch (toolName) {
    case 'Read': return 'Reading files';
    case 'Glob': return 'Looking for files';
    case 'Grep': return 'Searching the code';
    case 'Write': return 'Writing files';
    case 'Edit': return 'Editing files';
    case 'Bash': return 'Running commands';
    default: return 'Working';
  }
}

/**
 * Shorten an absolute path for the spinner's one-line detail. Relative to the
 * run's cwd when it sits underneath it, basename otherwise - an absolute
 * `/private/tmp/...` path is mostly prefix nobody is reading.
 */
function relativeToCwd(filePath, cwd) {
  try {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith('..')) return rel;
    return path.basename(filePath);
  } catch {
    return filePath;
  }
}

/** Human byte size for a spinner detail: "34 KB", "1.2 MB". */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pull `file_path` out of a partially-streamed tool input.
 *
 * Tool input arrives as a stream of JSON fragments, and for Write/Edit the
 * `file_path` key comes before the bulk `content`. So a few hundred bytes in
 * we can already name the file, which is the difference between "Writing
 * files" and "Write .restless/openapi.json".
 */
function sniffFilePath(partial) {
  const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partial);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function describeToolUse(toolName, input) {
  switch (toolName) {
    case 'Read':
      return {
        phase: 'Reading files',
        detail: `Read ${input.file_path || 'file'}`,
      };
    case 'Glob':
      return {
        phase: 'Looking for files',
        detail: `Glob ${input.pattern || '*'}${input.path ? ` in ${input.path}` : ''}`,
      };
    case 'Grep': {
      const pat = (input.pattern || '').slice(0, 40);
      const glob = input.glob ? ` --include="${input.glob}"` : '';
      return {
        phase: 'Searching the code',
        detail: `Grep "${pat}"${glob}`,
      };
    }
    case 'Write':
      return {
        phase: 'Writing files',
        detail: `Write ${input.file_path || 'file'}`,
      };
    case 'Edit':
      return {
        phase: 'Editing files',
        detail: `Edit ${input.file_path || 'file'}`,
      };
    case 'Bash': {
      // Claude often prefixes commands with a `# comment` line and joins pipes
      // with real newlines. Flatten to one line so the spinner detail stays
      // on a single visual row, and strip leading comments.
      const raw = (input.command || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .join(' ');
      let phase = 'Running commands';
      if (/^(npm|pnpm|yarn|bun|pip|gem|go|cargo)\s/.test(raw)) phase = 'Installing packages';
      else if (/^(ls|cat|find|head|tail)\s/.test(raw)) phase = 'Checking files';
      else if (/^curl\s/.test(raw)) phase = 'Making requests';
      else if (/^mkdir\s/.test(raw)) phase = 'Creating directories';
      return {
        phase,
        detail: `Bash ${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}`,
      };
    }
    default:
      return {
        phase: 'Working',
        detail: toolName,
      };
  }
}

/**
 * Pull every absolute path token out of a Bash command. Best-effort:
 * matches `/`-prefixed POSIX paths separated by whitespace, quotes, or
 * shell metacharacters. We use this to refuse Bash invocations that
 * touch a path outside the git root - it isn't perfect (a clever AI
 * could obfuscate via env-var indirection or `eval`) but it stops the
 * common cases (cd, cat, mv with absolute paths above the root).
 */
function extractAbsPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const out = [];
  const re = /(?<![\w\\])(\/[^\s"';|&<>()`$]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1]);
  return out;
}

/**
 * `canUseTool` callback for the Claude Agent SDK. Hard-rejects any
 * Write / Edit / NotebookEdit whose target path is outside the git
 * root, plus any Bash command that mentions an absolute path outside
 * the git root. Defense in depth alongside the safe fs helpers - if
 * the AI dreams up a path we'd write somewhere bad, this layer kills
 * the call before it reaches disk.
 */
function makeCanUseTool(gitRoot) {
  return async (toolName, input) => {
    if (!gitRoot) return { behavior: 'allow' };

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const fp = input?.file_path || input?.notebook_path;
      if (typeof fp === 'string' && fp && !isInsideRoot(fp, gitRoot)) {
        debug.log('ai.tool.denied', { tool: toolName, path: fp, reason: 'outside-git-root' });
        return {
          behavior: 'deny',
          message:
            `${toolName} ${fp} is outside the git root ${gitRoot}. ` +
            `The CLI never lets writes escape the repository it was invoked from. ` +
            `Use a path inside ${gitRoot} instead.`,
        };
      }
    }
    if (toolName === 'Bash') {
      for (const p of extractAbsPaths(input?.command)) {
        if (!isInsideRoot(p, gitRoot)) {
          debug.log('ai.tool.denied', { tool: 'Bash', path: p, reason: 'outside-git-root' });
          return {
            behavior: 'deny',
            message:
              `Bash command references ${p}, which is outside the git root ${gitRoot}. ` +
              `Refusing to run; nothing the CLI does is allowed to escape the repo.`,
          };
        }
      }
    }
    return { behavior: 'allow' };
  };
}

export default {
  name: 'claude',

  /**
   * `maxTurns` defaults to the 30 that suits a focused task (write this spec,
   * wire this SDK). A caller whose job is open-ended - reading a whole
   * repository, say - raises it, because hitting the cap does NOT degrade
   * gracefully the way a partial edit does: the agent never reaches the turn
   * where it emits its answer, so the run returns nothing at all rather than
   * returning less.
   *
   * `onError` exists for the same reason. The loop below deliberately swallows
   * SDK errors and returns whatever partial text it has (see the note above
   * it), which is right for steps that re-check their own output. But it makes
   * "the model found nothing" and "the model never got to answer" identical
   * from the outside, and a caller that reports the second as the first is
   * lying to the user. Callers that cannot otherwise tell those apart pass
   * this and check.
   */
  async run(prompt, cwd, { onStatus, maxTurns = 30, onError } = {}) {
    let result = '';
    // Counts so the debug log answers "did the AI actually write?" in a
    // single line. Useful post-mortem when install-sdk later finds nothing
    // wired and we need to know whether the AI tried to edit or just
    // produced commentary.
    const toolCounts = { Read: 0, Glob: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, other: 0 };
    const gitRoot = getGitRoot();
    debug.log('ai.run.start', {
      provider: 'claude',
      cwd,
      gitRoot,
      promptChars: prompt?.length ?? 0,
      // Just the first slice - full prompt is reproducible from
      // prompts/*.md + the variables, so don't send the whole thing.
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });
    // The Agent SDK rejects its async iterator on terminal conditions -
    // most commonly "Reached maximum number of turns", but also process
    // exits and transport errors. A throw here used to escape runAI and,
    // for any call site that didn't wrap it (e.g. generate-oas), bubble up
    // to `uncaughtException` and kill the whole CLI mid-run. Swallow it
    // instead: log the reason and return whatever partial text we already
    // accumulated. Every step has its own retry / re-check logic (the
    // install-sdk retry loop, generate-oas's validation, final-checks) and
    // is built to handle an empty or partial AI result, so degrading is
    // always better than crashing.
    let runError = null;
    // The tool call currently being generated, or null between calls.
    let streaming = null;
    try {
      for await (const message of query({
        prompt,
        options: {
          maxTurns,
          allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write'],
          cwd,
          canUseTool: makeCanUseTool(gitRoot),
          // Streaming events are what let the spinner track the model while
          // it is generating a tool call. A tool_use block only reaches the
          // `assistant` branch below once its ENTIRE input has been
          // generated, and for the OpenAPI spec that is a ~40KB argument
          // taking a minute or more. Without these events the CLI showed the
          // PREVIOUS tool's label for that whole minute - a profiled run sat
          // on "Creating directories" for 118 seconds while it was actually
          // writing the spec, which reads as a hang.
          includePartialMessages: true,
        }
      })) {
        // ── Streaming: track the tool call being generated right now ──────
        if (message.type === 'stream_event') {
          const ev = message.event;
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            streaming = {
              name: ev.content_block.name,
              json: '',
              bytes: 0,
              filePath: null,
              paintedAt: 0,
              paintedBytes: 0,
            };
            onStatus?.({
              phase: phaseForToolName(streaming.name),
              detail: `${streaming.name}…`,
            });
          } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && streaming) {
            const chunk = ev.delta.partial_json || '';
            streaming.bytes += chunk.length;
            // Only the head is kept: it is enough to sniff `file_path` out of,
            // and holding a 40KB argument twice for a spinner label would be
            // the kind of accidental memory cost this whole change exists to
            // avoid paying elsewhere.
            if (streaming.json.length < 4096) streaming.json += chunk;
            if (!streaming.filePath) streaming.filePath = sniffFilePath(streaming.json);

            // Throttled on BOTH time and size. Time alone (~4 paints a
            // second) keeps the plan view from redrawing per delta - they
            // arrive in their thousands. But a single large delta landing
            // inside the window would otherwise never be shown, leaving the
            // size stuck at whatever the last paint said, so a big jump
            // forces a paint of its own.
            const now = Date.now();
            const grew = streaming.bytes - streaming.paintedBytes >= 8192;
            if (grew || now - streaming.paintedAt > 250) {
              streaming.paintedAt = now;
              streaming.paintedBytes = streaming.bytes;
              const target = streaming.filePath ? ` ${relativeToCwd(streaming.filePath, cwd)}` : '';
              onStatus?.({
                phase: phaseForToolName(streaming.name),
                detail: `${streaming.name}${target} (${formatBytes(streaming.bytes)} so far)`,
              });
            }
          } else if (ev?.type === 'content_block_stop') {
            streaming = null;
          }
          continue;
        }

        // An API-level retry, which is invisible from the outside and looks
        // exactly like a slow model. A profiled run had one unexplained 49.5s
        // gap; this is the event that would have named it.
        if (message.type === 'system' && message.subtype === 'api_retry') {
          debug.log('ai.api-retry', {
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status,
            error: message.error,
          });
          onStatus?.({ phase: 'Retrying', detail: `API retry ${message.attempt}/${message.max_retries}` });
          continue;
        }

        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              result += block.text;
              onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
              debug.log('ai.text', { text: truncate(block.text, MAX_AI_TEXT) });
            } else if (block.type === 'tool_use') {
              onStatus?.(describeToolUse(block.name, block.input));
              debug.log('ai.tool_use', { tool: block.name, input: truncatedToolInput(block.input) });
              if (block.name in toolCounts) toolCounts[block.name]++;
              else toolCounts.other++;
            }
          }
        } else if (message.type === 'result' && message.is_error) {
          // The SDK emits the terminal error result here just before it
          // rejects the iterator; capture the reason for the log.
          runError =
            message.subtype === 'success'
              ? message.result
              : Array.isArray(message.errors)
                ? message.errors.join('; ')
                : message.subtype || 'error';
        }
      }
    } catch (err) {
      runError = runError || err?.message || String(err);
    }

    if (runError) {
      debug.log('ai.run.error', {
        provider: 'claude',
        message: runError,
        resultChars: result.length,
      });
      onError?.(runError);
    }
    debug.log('ai.run.end', {
      provider: 'claude',
      resultChars: result.length,
      toolCounts,
      // Surface the "did it write" answer at the top level so a quick
      // grep of the debug log doesn't have to parse the per-tool list.
      mutations: toolCounts.Edit + toolCounts.Write,
      // Present only when the run ended on an SDK error (max turns, etc.).
      error: runError || undefined,
    });
    return result;
  },
};
