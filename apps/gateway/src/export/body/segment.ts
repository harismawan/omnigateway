/**
 * Deterministic code-point cuts, measured through the real transport encoder.
 * Counts converge monotonically: additional count digits can only shorten cuts.
 * Callers retain text slices, not a collection of encoded HTTP requests.
 */
export function segments(
  text: string,
  limitBytes: number,
  envelope: (seg: string, n: number, of: number) => number,
): string[] {
  let count = 1;
  for (;;) {
    const out: string[] = [];
    let start = 0;
    do {
      let low = start;
      // Every code unit costs at least one byte on every supported wire. Do
      // not encode a whole 64 MiB field just to discover a 4 MiB receiver cap.
      let high = Math.min(text.length, start + limitBytes);
      let best = start;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        let end = middle;
        // Never cut between a UTF-16 surrogate pair.
        if (
          end < text.length &&
          highSurrogate(text.charCodeAt(end - 1)) &&
          lowSurrogate(text.charCodeAt(end))
        )
          end--;
        if (envelope(text.slice(start, end), out.length, count) <= limitBytes) {
          best = Math.max(best, end);
          low = middle;
        } else high = middle - 1;
      }
      const segment = text.slice(start, best);
      if (
        (best === start && start < text.length) ||
        envelope(segment, out.length, count) > limitBytes
      ) {
        throw new RangeError("body segment exceeds request limit");
      }
      out.push(segment);
      start = best;
    } while (start < text.length);
    if (out.length === count) return out;
    count = out.length;
  }
}

function highSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function lowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
