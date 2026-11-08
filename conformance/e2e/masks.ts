/** The conformance driver's masks (see `run.ts`). */

export type Exchange = { status: number; headers: [string, string][]; body: Uint8Array };

/**
 * What differs between two runs of the same request, and only that, masked at
 * the protocol locations it occupies. Every masked value is checked against
 * its expected shape first; a value that does not fit is left as it is, so
 * the comparison fails rather than hiding it.
 *
 * - JSON bodies and SSE `data:` payloads (parsed, then re-serialized):
 *   - `id` of an Anthropic message / Chat completion / chunk: `req_<uuid>`;
 *   - `id` of a Responses response: `resp_req_<uuid>`; of an output item:
 *     `msg_req_<uuid>_<n>` (and `item_id` the same);
 *   - `created` (Chat) and `created_at` (Responses): epoch seconds within
 *     ±120 s of now;
 *   - `nodeId` of `/health`: a uuid.
 * - Headers: `date` (an IMF date within ±120 s); `retry-after` (an integer
 *   0..120); `x-ratelimit-reset-*` (a duration like `1m0s`);
 *   `anthropic-ratelimit-*-reset` (an RFC 3339 instant within 2 h of now).
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ID_SHAPES: [RegExp, string][] = [
  [new RegExp(`^req_${UUID}$`), "req_<id>"],
  [new RegExp(`^resp_req_${UUID}$`), "resp_req_<id>"],
  [new RegExp(`^msg_req_${UUID}_(\\d+)$`), "msg_req_<id>_$1"],
];
const nowS = () => Date.now() / 1000;

function maskId(v: unknown): unknown {
  if (typeof v !== "string") return v;
  for (const [re, to] of ID_SHAPES) if (re.test(v)) return v.replace(re, to);
  return v;
}

function maskInstant(v: unknown): unknown {
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v - nowS()) < 120 ? "<t>" : v;
}

/** Walks a parsed payload and masks the known locations only. */
function maskJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskJson);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "id" || k === "item_id") out[k] = maskId(x);
    else if (k === "created" || k === "created_at") out[k] = maskInstant(x);
    else if (k === "nodeId" && typeof x === "string" && new RegExp(`^${UUID}$`).test(x))
      out[k] = "<node>";
    else out[k] = maskJson(x);
  }
  return out;
}

function maskPayload(text: string): string {
  try {
    return JSON.stringify(maskJson(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** A body: JSON as a whole, or SSE with each `data:` line's JSON masked. */
export function maskBody(text: string, contentType: string): string {
  if (contentType.startsWith("text/event-stream")) {
    return text
      .split("\n")
      .map((line) => (line.startsWith("data: ") ? `data: ${maskPayload(line.slice(6))}` : line))
      .join("\n");
  }
  if (contentType.startsWith("application/json")) return maskPayload(text);
  return text;
}

export function maskHeader(k: string, v: string): string {
  if (k === "date") return Math.abs(Date.parse(v) / 1000 - nowS()) < 120 ? "<date>" : v;
  if (k === "retry-after") return /^\d{1,3}$/.test(v) && Number(v) <= 120 ? "<s>" : v;
  if (/^x-ratelimit-reset-/.test(k)) return /^(\d+h)?(\d+m)?\d+s$/.test(v) ? "<dur>" : v;
  if (/^anthropic-ratelimit-.*-reset$/.test(k)) {
    const ok =
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) && Math.abs(Date.parse(v) / 1000 - nowS()) < 7200;
    return ok ? "<rfc3339>" : v;
  }
  return v;
}

export const fatal = new TextDecoder("utf-8", { fatal: true });

/** Raw bytes in, a comparable form out; `null` when the bytes are not UTF-8. */
export function normalize(
  x: Exchange,
): { status: number; headers: [string, string][]; body: string } | null {
  let text: string;
  try {
    text = fatal.decode(x.body);
  } catch {
    return null;
  }
  const type = x.headers.find(([k]) => k === "content-type")?.[1] ?? "";
  return {
    status: x.status,
    headers: x.headers
      .map(([k, v]): [string, string] => [k, maskHeader(k, v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    body: maskBody(text, type),
  };
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
