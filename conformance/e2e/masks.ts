/**
 * The conformance driver's masks.
 *
 * Nothing is re-serialized. A body stays the bytes it was; a mask replaces
 * the exact byte range of one JSON value, found by a small tokenizer that
 * records the span of every value at a known protocol path, with a fixed
 * token. The masked buffers are then compared as bytes.
 *
 * A value is masked only if it has the expected shape for its path (an id
 * shape, an instant near now); otherwise it is left, so the comparison sees
 * it.
 *
 * Mask paths per dialect (`path` is the chain of object keys from the
 * payload root; array indexes are not part of it, and a path matches only
 * at its exact depth):
 *
 * - Anthropic: `id` (buffered message), `message.id` (`message_start`).
 * - Chat: `id`, `created` (completion and every chunk).
 * - Responses: `id`, `created_at` (buffered), `response.id`,
 *   `response.created_at` (lifecycle frames), `item.id`
 *   (`output_item.*`), `item_id` (part/delta frames), `output.id` (buffered
 *   items, matched as `output` → array → `id`), `response.output.id`.
 * - `/health`: `nodeId`.
 *
 * Headers: `date` (an IMF date within ±120 s); `retry-after` (an integer
 * 0..120); `x-ratelimit-reset-*` (a duration like `1m0s`);
 * `anthropic-ratelimit-*-reset` (an RFC 3339 instant within 2 h of now).
 */

export type Exchange = { status: number; headers: [string, string][]; body: Uint8Array };

export const fatal = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REQ = new RegExp(`^"req_${UUID}"$`);
const RESP = new RegExp(`^"resp_req_${UUID}"$`);
const ITEM = new RegExp(`^"msg_req_${UUID}_(\\d+)"$`);
const NODE = new RegExp(`^"${UUID}"$`);

type Rule = (raw: string) => string | null;

const reqId: Rule = (r) => (REQ.test(r) ? '"req_<id>"' : null);
const respId: Rule = (r) => (RESP.test(r) ? '"resp_req_<id>"' : null);
const itemId: Rule = (r) => {
  const m = ITEM.exec(r);
  return m === null ? null : `"msg_req_<id>_${m[1]}"`;
};
const instant: Rule = (r) =>
  /^\d+$/.test(r) && Math.abs(Number(r) - Date.now() / 1000) < 120 ? '"<t>"' : null;
const nodeId: Rule = (r) => (NODE.test(r) ? '"<node>"' : null);

/** Paths are joined with `.`; one table for every dialect's payloads. */
const PATHS: Record<string, Rule> = {
  id: (r) => reqId(r) ?? respId(r),
  created: instant,
  created_at: instant,
  "message.id": reqId,
  "response.id": respId,
  "response.created_at": instant,
  "item.id": itemId,
  item_id: itemId,
  "output.id": itemId,
  "response.output.id": itemId,
  nodeId,
};

type Span = { path: string; start: number; end: number };

/**
 * Byte spans of every scalar value in one JSON text, with its key path.
 * Iterative; returns `null` for text that is not JSON (left unmasked).
 */
export function spans(bytes: Uint8Array, from = 0, to = bytes.length): Span[] | null {
  const out: Span[] = [];
  // Each frame: kind, and for objects the key of the value being read.
  const stack: { obj: boolean; key: string | null }[] = [];
  let i = from;
  const ws = () => {
    while (
      i < to &&
      (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)
    )
      i += 1;
  };
  const path = () =>
    stack
      .map((f) => f.key)
      .filter((k): k is string => k !== null)
      .join(".");
  const str = (): number | null => {
    // At a quote; returns the index after the closing quote.
    let j = i + 1;
    while (j < to) {
      if (bytes[j] === 0x5c) j += 2;
      else if (bytes[j] === 0x22) return j + 1;
      else j += 1;
    }
    return null;
  };
  let expectValue = true;
  for (;;) {
    ws();
    if (i >= to) return stack.length === 0 && !expectValue ? out : null;
    const c = bytes[i];
    const top = stack[stack.length - 1];
    if (expectValue) {
      if (c === 0x7b) {
        stack.push({ obj: true, key: null });
        i += 1;
        ws();
        if (bytes[i] === 0x7d) {
          stack.pop();
          i += 1;
          expectValue = false;
          continue;
        }
        // read key
        if (bytes[i] !== 0x22) return null;
        const e = str();
        if (e === null) return null;
        (stack[stack.length - 1] as { key: string | null }).key = fatal.decode(
          bytes.subarray(i + 1, e - 1),
        );
        i = e;
        ws();
        if (bytes[i] !== 0x3a) return null;
        i += 1;
        continue;
      }
      if (c === 0x5b) {
        stack.push({ obj: false, key: null });
        i += 1;
        ws();
        if (bytes[i] === 0x5d) {
          stack.pop();
          i += 1;
          expectValue = false;
        }
        continue;
      }
      const start = i;
      if (c === 0x22) {
        const e = str();
        if (e === null) return null;
        i = e;
      } else {
        while (i < to && !",]} \n\r\t".includes(String.fromCharCode(bytes[i] as number))) i += 1;
        const word = fatal.decode(bytes.subarray(start, i));
        if (!/^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$/.test(word)) return null;
      }
      out.push({ path: path(), start, end: i });
      expectValue = false;
      continue;
    }
    // after a value
    if (top === undefined) return null;
    if (c === 0x2c) {
      i += 1;
      if (top.obj) {
        ws();
        if (bytes[i] !== 0x22) return null;
        const e = str();
        if (e === null) return null;
        top.key = fatal.decode(bytes.subarray(i + 1, e - 1));
        i = e;
        ws();
        if (bytes[i] !== 0x3a) return null;
        i += 1;
      }
      expectValue = true;
      continue;
    }
    if ((c === 0x7d && top.obj) || (c === 0x5d && !top.obj)) {
      stack.pop();
      i += 1;
      continue;
    }
    return null;
  }
}

/** One JSON payload's masked bytes (unchanged when it is not JSON). */
function maskJson(bytes: Uint8Array, from: number, to: number): Uint8Array[] {
  const found = spans(bytes, from, to);
  if (found === null) return [bytes.subarray(from, to)];
  const parts: Uint8Array[] = [];
  let at = from;
  for (const s of found) {
    const rule = PATHS[s.path];
    if (rule === undefined) continue;
    const token = rule(fatal.decode(bytes.subarray(s.start, s.end)));
    if (token === null) continue;
    parts.push(bytes.subarray(at, s.start), enc.encode(token));
    at = s.end;
  }
  parts.push(bytes.subarray(at, to));
  return parts;
}

const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** A body: JSON as a whole, or SSE with each `data: ` line's payload masked. */
export function maskBody(body: Uint8Array, contentType: string): Uint8Array {
  if (contentType.startsWith("application/json")) return concat(maskJson(body, 0, body.length));
  if (!contentType.startsWith("text/event-stream")) return body;
  const parts: Uint8Array[] = [];
  let line = 0;
  while (line < body.length) {
    let nl = body.indexOf(0x0a, line);
    if (nl < 0) nl = body.length;
    const prefix = enc.encode("data: ");
    const isData = prefix.every((b, k) => body[line + k] === b);
    if (isData) {
      parts.push(body.subarray(line, line + prefix.length));
      parts.push(...maskJson(body, line + prefix.length, nl));
    } else {
      parts.push(body.subarray(line, nl));
    }
    if (nl < body.length) parts.push(body.subarray(nl, nl + 1));
    line = nl + 1;
  }
  return concat(parts);
}

export function maskHeader(k: string, v: string): string {
  const nowS = Date.now() / 1000;
  if (k === "date") return Math.abs(Date.parse(v) / 1000 - nowS) < 120 ? "<date>" : v;
  if (k === "retry-after") return /^\d{1,3}$/.test(v) && Number(v) <= 120 ? "<s>" : v;
  if (/^x-ratelimit-reset-/.test(k)) return /^(\d+h)?(\d+m)?\d+s$/.test(v) ? "<dur>" : v;
  if (/^anthropic-ratelimit-.*-reset$/.test(k)) {
    const ok =
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) && Math.abs(Date.parse(v) / 1000 - nowS) < 7200;
    return ok ? "<rfc3339>" : v;
  }
  return v;
}

export type Normalized = { status: number; headers: [string, string][]; body: Uint8Array };

/** Raw bytes in, masked bytes out; `null` when the body is not UTF-8. */
export function normalize(x: Exchange): Normalized | null {
  try {
    fatal.decode(x.body);
  } catch {
    return null;
  }
  const type = x.headers.find(([k]) => k === "content-type")?.[1] ?? "";
  return {
    status: x.status,
    headers: x.headers
      .map(([k, v]): [string, string] => [k, maskHeader(k, v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    body: maskBody(x.body, type),
  };
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Equal status, equal (masked) headers, byte-equal masked bodies. */
export function normalizedEqual(a: Normalized | null, b: Normalized | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.status === b.status &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers) &&
    bytesEqual(a.body, b.body)
  );
}

/** For failure output only. */
export function show(n: Normalized | null): string {
  return n === null
    ? "<not UTF-8>"
    : JSON.stringify({ ...n, body: Buffer.from(n.body).toString("latin1") });
}
