/** Body bytes for the local HTTP/1.1 conformance recorders. Undefined until complete. */
export function readRequestBody(buffer: Buffer, start: number, headers: string[]) {
  if (!headers.some((h) => /^transfer-encoding: chunked$/i.test(h))) {
    const size = Number(headers.find((h) => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
    const end = start + size;
    return buffer.length < end ? undefined : { body: buffer.subarray(start, end), end };
  }
  const parts: Buffer[] = [];
  let at = start;
  for (;;) {
    const line = buffer.indexOf("\r\n", at);
    if (line < 0) return undefined;
    const hex = buffer.toString("ascii", at, line).split(";", 1)[0] ?? "";
    const size = Number.parseInt(hex, 16);
    if (!/^[\da-f]+$/i.test(hex) || !Number.isSafeInteger(size)) throw Error("invalid chunk size");
    at = line + 2;
    if (size === 0) {
      for (;;) {
        const trailer = buffer.indexOf("\r\n", at);
        if (trailer < 0) return undefined;
        if (trailer === at) return { body: Buffer.concat(parts), end: at + 2 };
        at = trailer + 2;
      }
    }
    if (buffer.length < at + size + 2) return undefined;
    parts.push(buffer.subarray(at, at + size));
    at += size;
    if (buffer.toString("ascii", at, at + 2) !== "\r\n") throw Error("invalid chunk terminator");
    at += 2;
  }
}
