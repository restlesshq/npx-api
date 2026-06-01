/**
 * Pull a JSON value out of an LLM's free-text response.
 *
 * Different providers format structured output differently even when the
 * prompt asks for a fenced ```json block: Claude reliably wraps it, but
 * Codex / GPT-style models often emit the raw object with no fence (or a
 * bare ``` fence). A regex that only accepts ```json silently drops those
 * responses, which read downstream as "the AI found nothing." This helper
 * tries, in order:
 *
 *   1. a ```json fenced block,
 *   2. a bare ``` fenced block,
 *   3. the first brace/bracket-balanced {…} or […] that parses.
 *
 * Pass `requireKey` to insist the parsed value is an object containing that
 * key - this skips incidental JSON (e.g. a fenced grep pattern in the
 * model's commentary) and returns the real payload.
 *
 * Returns the parsed value, or `null` if nothing usable is found. Never
 * throws - callers can treat `null` as "no answer."
 */
export function extractJson(text, { requireKey } = {}) {
  if (typeof text !== 'string' || !text) return null;

  const candidates = [];

  const fencedJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) candidates.push(fencedJson[1]);

  const fencedBare = text.match(/```\s*([\s\S]*?)```/);
  if (fencedBare) candidates.push(fencedBare[1]);

  // Balanced-delimiter scan: walk each `{` / `[` and grab the matching close,
  // respecting string literals so braces inside strings don't fool the depth
  // count. Cheap enough for the response sizes we see (tens of KB).
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      const slice = balancedSlice(text, i);
      if (slice) candidates.push(slice);
    }
  }

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (!requireKey) return parsed;
    if (parsed && typeof parsed === 'object' && requireKey in parsed) return parsed;
  }

  return null;
}

/**
 * Return the substring of `text` starting at `openIdx` (a `{` or `[`) that
 * covers the balanced run up to its matching close, or `null` if the
 * delimiters never balance. String contents (including escaped quotes) are
 * skipped so braces inside string values don't affect the depth count.
 */
function balancedSlice(text, openIdx) {
  const open = text[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}
