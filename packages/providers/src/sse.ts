export type SseMessage = { event: string; data: string };

/**
 * Characters held back from the settled text at the end of each chunk.
 *
 * The longest record separator this recognises is `\n\r\n`, three characters,
 * so deciding whether a `\n` ends a record needs the two characters after it.
 * When a chunk ends before those arrive, the last two go back into `tail` and
 * are re-examined once the next chunk supplies the context.
 */
const HOLDBACK = 2;

/**
 * Parses an SSE byte stream into messages.
 *
 * Chunk boundaries fall anywhere, including mid-field, so the stream is only
 * consumed up to the last complete record.
 *
 * **Nothing accumulates into one growing string, and that is the point.** This
 * parser used to append each chunk to a `buf` that was searched from index 0.
 * Both halves were superlinear: `replaceAll` re-scanned the whole prefix per
 * chunk, and `indexOf` forced JavaScriptCore to flatten the rope that `+=`
 * builds — an O(n) copy per chunk whatever offset the search resumed from,
 * which is why moving the search offset was measured and did not help. Segments
 * are kept in `pending` and joined exactly once, when a record completes, so
 * every character is examined a constant number of times.
 *
 * Measured on one record arriving in 1 KB chunks: 2.6 ms at 1,000 chunks and
 * 28.8 ms at 16,000 — doubling with the input, where the previous version went
 * 53 ms to 19,859 ms, quadrupling. About 690× at the top of that range.
 *
 * CRLF is handled where it is observable rather than by rewriting the bytes:
 * `separatorEnd` recognises a blank line in either spelling, and `parseRecord`
 * drops a trailing `\r` per line. A bare `\r` is *not* treated as a line
 * terminator, which the SSE grammar does permit — unchanged from every previous
 * version of this parser, and no provider measured here emits one.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** Settled segments of the record being accumulated. Joined once, on completion. */
  const pending: string[] = [];
  /** Trailing characters whose meaning the next chunk may still change. */
  let tail = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Only ever the held-back tail plus one chunk, never the accumulated
      // record, so the flatten this forces is bounded by the chunk.
      const probe = tail + decoder.decode(value, { stream: true });

      // Where the current record's content starts inside `probe`.
      let start = 0;
      let nl = probe.indexOf("\n");
      while (nl !== -1) {
        const end = separatorEnd(probe, nl);
        if (end === -1) {
          nl = probe.indexOf("\n", nl + 1);
          continue;
        }
        pending.push(probe.slice(start, nl));
        const record = pending.join("");
        pending.length = 0;
        const msg = parseRecord(record);
        if (msg) yield msg;
        start = end;
        nl = probe.indexOf("\n", end);
      }

      // Everything but the last `HOLDBACK` characters is settled: no separator
      // ends inside it, because the scan above just looked at all of it with
      // the previous tail in front.
      const keep = Math.min(HOLDBACK, probe.length - start);
      const settled = probe.slice(start, probe.length - keep);
      if (settled.length > 0) pending.push(settled);
      tail = probe.slice(probe.length - keep);
    }
    // A stream that ends without a final blank line still carries a message,
    // and nothing can follow the held tail, so it is ordinary content now.
    const last = parseRecord(pending.join("") + tail);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Where the record ends, for a `\n` at `at`, or `-1` if this is not a boundary.
 *
 * A record ends at a blank line, and a line ends with either `\n` or `\r\n`, so
 * from the `\n` closing the last content line the separator is `\n\n` or
 * `\n\r\n`. Those two also cover `\r\n\r\n`, where the first `\n` found is the
 * one closing that content line.
 *
 * `charCodeAt` past the end is `NaN`, which equals nothing, so a separator that
 * runs off the end of `probe` reads as "not here" and is re-examined next chunk.
 *
 * The returned offset is one past the whole separator, so the terminators are
 * not re-examined as content. Do not expect a test to catch an off-by-one here:
 * a stray `\n` left at the front of the next record becomes a leading empty
 * line, and `parseRecord` skips empty lines, so `+1` and `+2` are behaviourally
 * identical. Measured — that mutant survives the suite.
 */
function separatorEnd(text: string, at: number): number {
  const next = text.charCodeAt(at + 1);
  if (next === 0x0a) return at + 2;
  if (next === 0x0d && text.charCodeAt(at + 2) === 0x0a) return at + 3;
  return -1;
}

function parseRecord(record: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of record.split("\n")) {
    // The `\r` of a CRLF terminator. Stripping it here is what lets the rest of
    // the parser — and the buffer above — hold raw bytes rather than a rewritten
    // copy of them.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}
