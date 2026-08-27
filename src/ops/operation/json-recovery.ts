/**
 * Getting the JSON object out of a reply that also contains other things.
 *
 * Even when the prompt says "JSON and nothing else", providers wrap it in a code fence,
 * open with "Sure!", or add a sentence afterwards. The answer inside is perfectly good;
 * failing the run over the packaging would throw away work already paid for.
 *
 * What this does NOT do is repair. A truncated reply — the response cut off mid-object —
 * is missing content, and guessing at what was in it would put invented data into
 * someone's system. Those stay failures, and the runner moves to another provider.
 */

/**
 * The first balanced `{…}` in `text` that parses as a JSON object, or null.
 *
 * Braces inside string literals are not counted (`{"note":"a } b"}` is one object), and
 * `\"` inside a string does not end it. Candidate starts are tried in order, so a stray
 * brace in a preamble — `The result {see below}: {"a":1}` — doesn't hide the real answer.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    // An unclosed brace means the reply ran out — `{"a":{"b":1}` is a cut-off object, not
    // a preamble. Moving on to the next `{` would "recover" the inner fragment and hand
    // back half an answer as if it were whole, which is the one outcome worse than
    // failing. Only a brace that DID close and merely failed to parse is worth skipping
    // past. (Cost: a stray unclosed brace in prose before the answer loses the answer —
    // an over-cautious failure, and the runner still tries another provider.)
    if (end === -1) return null;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON from here; try the next opening brace.
    }
  }
  return null;
}

/** Index of the `}` closing the object that starts at `start`, or -1 if it never closes. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      // A backslash escapes exactly the next character, including another backslash —
      // so `"a\\"` ends the string but `"a\""` does not.
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}
