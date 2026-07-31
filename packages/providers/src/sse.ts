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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replaceAll("\r\n", "\n");

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
    const tail = parseRecord(buf.replaceAll("\r\n", "\n"));
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
