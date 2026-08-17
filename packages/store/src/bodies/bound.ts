/**
 * Structural bounding for captured bodies.
 *
 * Bodies are unbounded by nature — one pasted file, one long agent transcript,
 * one base64 screenshot — so something has to cut them down before they are
 * written. Cutting at a byte offset is what this module exists to avoid: a
 * byte-truncated JSON body is usually unparseable, which makes it useless for
 * exactly the forensics that motivated capturing it. Every bound here therefore
 * cuts along a structural seam, and the result is still valid JSON.
 *
 * The four limits are constants rather than settings. They are load-bearing
 * defaults that the storage format assumes, not a knob an operator has any way
 * to choose well, and a setting would let one installation write artifacts the
 * next release's reader has never seen the shape of.
 */

/**
 * Per string value, in UTF-8 bytes rather than code units.
 *
 * Code units would bound nothing in the cases that matter: an emoji is two units
 * and four bytes, so a payload of them would sit at four times the budget, and
 * CJK prose at one and a half times.
 */
export const MAX_STRING_BYTES = 64 * 1024;

/**
 * Per array, keeping the *last* items.
 *
 * The arrays that overflow here are message histories, and the recent turns are
 * the ones an incident is about. Keeping the head would reliably discard the
 * request that failed in favour of the small talk that opened the session.
 */
export const MAX_ARRAY_ITEMS = 24;

/**
 * How deep a container may sit before it is replaced by a marker.
 *
 * The root object is depth 1, so a body's messages, their content blocks, and a
 * tool result's own structure all fit comfortably. Past this is either a
 * genuinely pathological payload or a cycle-shaped one, and neither is worth
 * storing.
 */
export const MAX_DEPTH = 6;

/** Per object, keeping the first keys, since object key order carries no recency. */
export const MAX_OBJECT_KEYS = 80;

/** Appended to a cut string, inside its budget, so the cut is visible in place. */
export const STRING_TRUNCATION_MARKER = "…[truncated]";

/** Replaces a container that sat deeper than `MAX_DEPTH`. */
export const DEPTH_MARKER = `[omitted: nesting past ${MAX_DEPTH} levels]`;

const encoder = new TextEncoder();
// Non-fatal, so a cut that lands inside a multi-byte code point yields U+FFFD
// rather than throwing. A replacement character is a readable artifact; an
// exception on the write path is a lost one.
const decoder = new TextDecoder();

/**
 * Where the byte slice is taken, leaving room for the marker and three bytes of
 * slack: a cut landing inside a multi-byte code point becomes a three-byte
 * U+FFFD, which can re-encode two bytes longer than the bytes it replaced, and
 * the budget is a bound rather than an approximation.
 */
const CUT_BYTES = MAX_STRING_BYTES - encoder.encode(STRING_TRUNCATION_MARKER).length - 3;

function truncateToBytes(value: string): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= MAX_STRING_BYTES) return value;
  return decoder.decode(bytes.subarray(0, CUT_BYTES)) + STRING_TRUNCATION_MARKER;
}

/**
 * The bounded value, and whether anything was actually cut.
 *
 * The flag is what `request_bodies.truncated` records, so a reader can say "this
 * is not the whole payload" without having to diff it against a copy it does not
 * have.
 */
export type Bounded<T> = { value: T; truncated: boolean };

/**
 * Bounds one JSON-shaped value. Depth counts from 1 at the value passed in.
 *
 * A scalar is never dropped for being deep: only containers past the limit are
 * replaced, so the leaves of the last surviving level are still readable.
 */
export function boundValue(value: unknown): Bounded<unknown> {
  let truncated = false;

  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      const cut = truncateToBytes(input);
      if (cut !== input) truncated = true;
      return cut;
    }

    if (Array.isArray(input)) {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return DEPTH_MARKER;
      }
      const kept = input.length > MAX_ARRAY_ITEMS ? input.slice(-MAX_ARRAY_ITEMS) : input;
      if (kept.length !== input.length) truncated = true;
      return kept.map((item) => walk(item, depth + 1));
    }

    if (input !== null && typeof input === "object") {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return DEPTH_MARKER;
      }
      const entries = Object.entries(input);
      const kept = entries.length > MAX_OBJECT_KEYS ? entries.slice(0, MAX_OBJECT_KEYS) : entries;
      if (kept.length !== entries.length) truncated = true;
      // `fromEntries` defines own properties, so a `__proto__` key survives as a
      // key instead of becoming a prototype assignment.
      return Object.fromEntries(kept.map(([k, v]) => [k, walk(v, depth + 1)]));
    }

    return input;
  };

  const bounded = walk(value, 1);
  return { value: bounded, truncated };
}
