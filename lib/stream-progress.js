/**
 * Turning the Agent SDK's streaming events into a truthful spinner.
 *
 * A `tool_use` block only reaches the SDK's `assistant` message once its
 * ENTIRE input has been generated. That is fine for a `Read`, whose argument
 * is a path, and badly wrong for the OpenAPI spec, whose argument is a ~40KB
 * `Write` taking a minute or more: for that whole minute nothing arrives, so
 * the UI kept displaying the tool BEFORE it. A profiled run sat on
 * "Creating directories" for 118 seconds while it was actually writing the
 * spec, which reads as a hang.
 *
 * Streaming events fire as the argument is generated, so the tool can be
 * named the moment its block opens and its size reported as it grows.
 */
import path from 'path';

/**
 * The phase for a tool we know the name of but not yet the arguments of.
 *
 * `describeToolUse` in the provider needs the input to build its detail line;
 * this is the half that is answerable a few hundred milliseconds earlier.
 * Bash is the one that genuinely cannot be answered from the name (its phase
 * depends on the command), so it takes the generic label until the input
 * lands.
 */
export function phaseForToolName(toolName) {
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

/** Human byte size for a spinner detail: "34 KB", "1.2 MB". */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pull `file_path` out of a partially-streamed tool input.
 *
 * Tool input arrives as a stream of JSON fragments, and for Write/Edit the
 * `file_path` key precedes the bulk `content`. So a few hundred bytes in we
 * can already name the file, which is the difference between "Writing files"
 * and "Write .restless/openapi.json".
 */
export function sniffFilePath(partial) {
  const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partial);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/**
 * Shorten an absolute path for a one-line spinner detail. Relative to the
 * run's cwd when it sits underneath it, basename otherwise - an absolute
 * `/private/tmp/...` path is mostly prefix nobody is reading.
 */
export function relativeToCwd(filePath, cwd) {
  try {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith('..')) return rel;
    return path.basename(filePath);
  } catch {
    return filePath;
  }
}

/** Only the head of the argument is kept, to sniff `file_path` out of. */
const SNIFF_WINDOW = 4096;
/** Paints per second, capped because the plan view redraws the whole screen. */
const PAINT_INTERVAL_MS = 250;
/** Force a paint after this much growth, so one big delta is never invisible. */
const PAINT_BYTES = 8192;

/**
 * Track the tool call currently being generated and report its progress.
 *
 * `handle(event)` takes a raw stream event and returns true when it consumed
 * it. Stateful by nature - one tool block is open at a time - so it lives
 * behind a factory rather than as loose module state, which would leak
 * between concurrent runs.
 */
export function createToolProgressTracker({ cwd, onStatus } = {}) {
  let open = null;

  return {
    handle(event) {
      if (!event) return false;

      if (event.type === 'content_block_start') {
        if (event.content_block?.type !== 'tool_use') return true;
        open = { name: event.content_block.name, json: '', bytes: 0, filePath: null, paintedAt: 0, paintedBytes: 0 };
        onStatus?.({ phase: phaseForToolName(open.name), detail: `${open.name}…` });
        return true;
      }

      if (event.type === 'content_block_delta') {
        if (event.delta?.type !== 'input_json_delta' || !open) return true;
        const chunk = event.delta.partial_json || '';
        open.bytes += chunk.length;
        // Holding a 40KB argument twice just to label it would be the sort of
        // accidental cost this whole change exists to avoid paying elsewhere.
        if (open.json.length < SNIFF_WINDOW) open.json += chunk;
        if (!open.filePath) open.filePath = sniffFilePath(open.json);

        const now = Date.now();
        const grew = open.bytes - open.paintedBytes >= PAINT_BYTES;
        if (grew || now - open.paintedAt > PAINT_INTERVAL_MS) {
          open.paintedAt = now;
          open.paintedBytes = open.bytes;
          const target = open.filePath ? ` ${relativeToCwd(open.filePath, cwd)}` : '';
          onStatus?.({
            phase: phaseForToolName(open.name),
            detail: `${open.name}${target} (${formatBytes(open.bytes)} so far)`,
          });
        }
        return true;
      }

      if (event.type === 'content_block_stop') {
        open = null;
        return true;
      }

      return true;
    },
  };
}
