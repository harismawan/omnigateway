export type SseMessage = { event: string; data: string };

/**
 * Parses an SSE byte stream into messages.
 *
 * Chunk boundaries fall anywhere, including mid-field, so the buffer is only
 * consumed up to the last complete record.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // A `\r` at the end of a chunk is the one byte whose meaning is not yet
  // decided: `\r\n` to be normalized if the next chunk opens with `\n`,
  // ordinary data otherwise. It is held back rather than appended so that
  // everything already in `buf` is settled and never looked at again.
  let carry = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Only the new segment is normalized. Normalizing `buf` instead re-scans
      // and re-allocates the whole accumulated prefix once per chunk, which is
      // quadratic in the size of a record that spans many chunks — the shape
      // large tool results and coarsely-flushing providers produce.
      let segment = carry + decoder.decode(value, { stream: true });
      carry = "";
      if (segment.endsWith("\r")) {
        carry = "\r";
        segment = segment.slice(0, -1);
      }
      buf += segment.replaceAll("\r\n", "\n");

      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const record = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const msg = parseRecord(record);
        if (msg) yield msg;
        sep = buf.indexOf("\n\n");
      }
    }
    // A stream that ends without a final blank line still carries a message.
    // A still-held `\r` ended the stream, so nothing can follow it: it is data.
    const tail = parseRecord(buf + carry);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseRecord(record: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of record.split("\n")) {
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
