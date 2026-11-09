/**
 * The conformance driver's masks.
 *
 * Nothing is re-serialized. A body stays the bytes it was; a mask replaces the
 * exact byte range of one JSON value with a fixed token, and the masked
 * buffers are compared as bytes. Text is decoded only with a fatal UTF-8
 * decoder.
 *
 * **Where masks apply.** Each payload is classified by its dialect (from the
 * route) and its kind (from its own top-level `type` / `object`). Each kind
 * names its mask paths, as arrays of decoded segments with explicit array
 * traversal (`ANY_INDEX`), matched at exact depth. A path is either
 * `required` for that kind, so a payload of that kind lacking it throws with
 * the dialect, kind and path, or explicitly `optional`. Payloads of kinds not
 * listed carry no generated ids (errors, `/v1/models`, `count_tokens`) and
 * are compared unmasked.
 *
 * | dialect | kind | paths |
 * |---|---|---|
 * | anthropic | buffered `message` | `id` (required) |
 * | anthropic | SSE `message_start` | `message.id` (required) |
 * | openai | buffered `chat.completion` | `id`, `created` (required) |
 * | openai | SSE `chat.completion.chunk` | `id`, `created` (required) |
 * | responses | buffered `response` | `id`, `created_at` (required); `output[*].id` (optional) |
 * | responses | SSE `response.{created,in_progress,completed,failed,incomplete}` | `response.id`, `response.created_at` (required); `response.output[*].id` (optional) |
 * | responses | SSE `response.output_item.{added,done}` | `item.id` (required) |
 * | responses | SSE item-scoped frames (`content_part`, `output_text`, `function_call_arguments`, `custom_tool_call_input`, `reasoning_summary_part`, `reasoning_summary_text`, each `.added`/`.delta`/`.done`) | `item_id` (required) |
 * | health | `/health` | `nodeId` (required) |
 *
 * A value at a mask path is replaced only if it has its expected shape
 * (`req_<uuid>`; `resp_req_<uuid>`; `<msg|rs|fc|ctc|item>_req_<uuid>_<n>`;
 * an integer within ±120 s of now; a v4 uuid for the node id). Anything else
 * is left, so the comparison sees it.
 *
 * A request id's uuid is version 4 (TS mints `crypto.randomUUID()`) or 7
 * (Rust mints time-ordered ids: spec §Writes, "Request ids: time-ordered"),
 * at the same paths; any other version is not masked. The scenario check in
 * `run.ts` holds each binary to its own version.
 *
 * Headers: `date` (an IMF date within ±120 s); `retry-after` (an integer
 * 0..120); `x-ratelimit-reset-*` (a duration like `1m0s`);
 * `anthropic-ratelimit-*-reset` (an RFC 3339 instant within 2 h of now).
 */

export type Exchange = {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  /** The request path, which names the dialect. */
  route: string;
  /** Epoch ms the driver sent the request, and when the body had arrived. */
  sentAt?: number;
  doneAt?: number;
};

export const fatal = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

export const ANY_INDEX = Symbol("any index");
type Seg = string | number;
type PathPattern = readonly (string | typeof ANY_INDEX)[];

const uuid = (version: string) =>
  `[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
/** A request id's uuid: v4 (TS) or v7 (Rust). */
export const REQUEST_UUID = uuid("[47]");
const REQ = new RegExp(`^"req_${REQUEST_UUID}"$`);
const RESP = new RegExp(`^"resp_req_${REQUEST_UUID}"$`);
const ITEM = new RegExp(`^"(msg|rs|fc|ctc|item)_req_${REQUEST_UUID}_(\\d+)"$`);
/** The node id is v4 in both. */
const NODE = new RegExp(`^"${uuid("4")}"$`);

type Shape = (raw: string) => string | null;
const reqId: Shape = (r) => (REQ.test(r) ? '"req_<id>"' : null);
const respId: Shape = (r) => (RESP.test(r) ? '"resp_req_<id>"' : null);
const itemId: Shape = (r) => {
  const m = ITEM.exec(r);
  return m === null ? null : `"${m[1]}_req_<id>_${m[2]}"`;
};
const instant: Shape = (r) =>
  /^\d+$/.test(r) && Math.abs(Number(r) - Date.now() / 1000) < 120 ? '"<t>"' : null;
const nodeId: Shape = (r) => (NODE.test(r) ? '"<node>"' : null);

type Rule = { path: PathPattern; shape: Shape; required: boolean };
const required = (path: PathPattern, shape: Shape): Rule => ({ path, shape, required: true });
const optional = (path: PathPattern, shape: Shape): Rule => ({ path, shape, required: false });

export type Dialect = "anthropic" | "openai" | "responses" | "health" | "none";

const RESPONSE_LIFECYCLE = [
  required(["response", "id"], respId),
  required(["response", "created_at"], instant),
  optional(["response", "output", ANY_INDEX, "id"], itemId),
];
const ITEM_SCOPED = [required(["item_id"], itemId)];

/** dialect → kind → rules. Maps, so no payload-chosen key reaches a prototype. */
const RULES = new Map<Dialect, Map<string, Rule[]>>([
  [
    "anthropic",
    new Map([
      ["message", [required(["id"], reqId)]],
      ["message_start", [required(["message", "id"], reqId)]],
    ]),
  ],
  [
    "openai",
    new Map([
      ["chat.completion", [required(["id"], reqId), required(["created"], instant)]],
      ["chat.completion.chunk", [required(["id"], reqId), required(["created"], instant)]],
    ]),
  ],
  [
    "responses",
    new Map<string, Rule[]>([
      [
        "response",
        [
          required(["id"], respId),
          required(["created_at"], instant),
          optional(["output", ANY_INDEX, "id"], itemId),
        ],
      ],
      ...["created", "in_progress", "completed", "failed", "incomplete"].map(
        (k): [string, Rule[]] => [`response.${k}`, RESPONSE_LIFECYCLE],
      ),
      ["response.output_item.added", [required(["item", "id"], itemId)]],
      ["response.output_item.done", [required(["item", "id"], itemId)]],
      ...[
        "content_part.added",
        "content_part.done",
        "output_text.delta",
        "output_text.done",
        "function_call_arguments.delta",
        "function_call_arguments.done",
        "custom_tool_call_input.delta",
        "custom_tool_call_input.done",
        "reasoning_summary_part.added",
        "reasoning_summary_part.done",
        "reasoning_summary_text.delta",
        "reasoning_summary_text.done",
      ].map((k): [string, Rule[]] => [`response.${k}`, ITEM_SCOPED]),
    ]),
  ],
  ["health", new Map([["health", [required(["nodeId"], nodeId)]]])],
]);

export function dialectOf(route: string): Dialect {
  const path = route.split("?")[0];
  if (path === "/health") return "health";
  if (path === "/v1/messages") return "anthropic";
  if (path === "/v1/chat/completions") return "openai";
  if (path === "/v1/responses") return "responses";
  return "none";
}

type Span = { path: Seg[]; start: number; end: number };

/** A JSON string literal's value (`JSON.parse` of the literal alone). */
function decodeString(bytes: Uint8Array, start: number, end: number): string {
  return JSON.parse(fatal.decode(bytes.subarray(start, end))) as string;
}

const NUMBER = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$/;

/**
 * Byte spans of every scalar value in one JSON text with its path: decoded
 * property names (escapes and surrogate pairs included) and array indexes.
 * Iterative; `null` for text that is not JSON (then compared unmasked).
 */
export function spans(bytes: Uint8Array, from = 0, to = bytes.length): Span[] | null {
  try {
    return scan(bytes, from, to);
  } catch {
    return null;
  }
}

function scan(bytes: Uint8Array, from: number, to: number): Span[] | null {
  const out: Span[] = [];
  const path: Seg[] = [];
  const frames: ("obj" | "arr")[] = [];
  let i = from;
  const ws = () => {
    while (
      i < to &&
      (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)
    )
      i += 1;
  };
  const strEnd = (): number | null => {
    let j = i + 1;
    while (j < to) {
      if (bytes[j] === 0x5c) j += 2;
      else if (bytes[j] === 0x22) return j + 1;
      else j += 1;
    }
    return null;
  };
  /** At a key's opening quote: reads `"key" :` and sets the last path segment. */
  const key = (): boolean => {
    if (bytes[i] !== 0x22) return false;
    const e = strEnd();
    if (e === null) return false;
    path[path.length - 1] = decodeString(bytes, i, e);
    i = e;
    ws();
    if (bytes[i] !== 0x3a) return false;
    i += 1;
    return true;
  };
  let wantValue = true;
  for (;;) {
    ws();
    if (i >= to) return frames.length === 0 && !wantValue ? out : null;
    const c = bytes[i];
    if (wantValue) {
      if (c === 0x7b) {
        frames.push("obj");
        path.push("");
        i += 1;
        ws();
        if (bytes[i] === 0x7d) {
          frames.pop();
          path.pop();
          i += 1;
          wantValue = false;
          continue;
        }
        if (!key()) return null;
        continue;
      }
      if (c === 0x5b) {
        frames.push("arr");
        path.push(0);
        i += 1;
        ws();
        if (bytes[i] === 0x5d) {
          frames.pop();
          path.pop();
          i += 1;
          wantValue = false;
        }
        continue;
      }
      const start = i;
      if (c === 0x22) {
        const e = strEnd();
        if (e === null) return null;
        decodeString(bytes, start, e);
        i = e;
      } else {
        while (i < to && !",]} \n\r\t".includes(String.fromCharCode(bytes[i] as number))) i += 1;
        if (!NUMBER.test(fatal.decode(bytes.subarray(start, i)))) return null;
      }
      out.push({ path: [...path], start, end: i });
      wantValue = false;
      continue;
    }
    const top = frames[frames.length - 1];
    if (top === undefined) return null;
    if (c === 0x2c) {
      i += 1;
      if (top === "obj") {
        ws();
        if (!key()) return null;
      } else {
        path[path.length - 1] = (path[path.length - 1] as number) + 1;
      }
      wantValue = true;
      continue;
    }
    if ((c === 0x7d && top === "obj") || (c === 0x5d && top === "arr")) {
      frames.pop();
      path.pop();
      i += 1;
      continue;
    }
    return null;
  }
}

function matches(pattern: PathPattern, path: Seg[]): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((p, k) =>
    p === ANY_INDEX ? typeof path[k] === "number" : typeof path[k] === "string" && p === path[k],
  );
}

/** The decoded top-level string at `name`, if any. */
function topString(bytes: Uint8Array, found: Span[], name: string): string | null {
  const s = found.find((x) => x.path.length === 1 && x.path[0] === name);
  if (s === undefined || bytes[s.start] !== 0x22) return null;
  return decodeString(bytes, s.start, s.end);
}

/** The payload's kind: `/health`, else its `type`, else its `object`. */
function kindOf(dialect: Dialect, bytes: Uint8Array, found: Span[]): string | null {
  if (dialect === "health") return "health";
  return topString(bytes, found, "type") ?? topString(bytes, found, "object");
}

export class MissingPath extends Error {}

/** One JSON payload's masked bytes. Throws when a required path is missing. */
function maskJson(dialect: Dialect, bytes: Uint8Array, from: number, to: number): Uint8Array[] {
  const found = spans(bytes, from, to);
  if (found === null) return [bytes.subarray(from, to)];
  const kind = kindOf(dialect, bytes, found);
  const rules = kind === null ? undefined : RULES.get(dialect)?.get(kind);
  if (rules === undefined) return [bytes.subarray(from, to)];
  const edits: { start: number; end: number; token: string }[] = [];
  for (const rule of rules) {
    const hits = found.filter((s) => matches(rule.path, s.path));
    if (hits.length === 0 && rule.required) {
      const shown = rule.path.map((p) => (p === ANY_INDEX ? "[*]" : p)).join(" / ");
      throw new MissingPath(`${dialect} ${kind}: required path ${shown} is missing`);
    }
    for (const s of hits) {
      const token = rule.shape(fatal.decode(bytes.subarray(s.start, s.end)));
      if (token !== null) edits.push({ start: s.start, end: s.end, token });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let at = from;
  for (const e of edits) {
    parts.push(bytes.subarray(at, e.start), enc.encode(e.token));
    at = e.end;
  }
  parts.push(bytes.subarray(at, to));
  return parts;
}

const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** A body: JSON as a whole, or SSE with each `data: ` line's payload masked. */
export function maskBody(body: Uint8Array, contentType: string, dialect: Dialect): Uint8Array {
  if (contentType.startsWith("application/json"))
    return concat(maskJson(dialect, body, 0, body.length));
  if (!contentType.startsWith("text/event-stream")) return body;
  const prefix = enc.encode("data: ");
  const parts: Uint8Array[] = [];
  let line = 0;
  while (line < body.length) {
    let nl = body.indexOf(0x0a, line);
    if (nl < 0) nl = body.length;
    const isData = prefix.every((b, k) => body[line + k] === b);
    if (isData) {
      parts.push(body.subarray(line, line + prefix.length));
      parts.push(...maskJson(dialect, body, line + prefix.length, nl));
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

/**
 * Raw bytes in, masked bytes out; `null` when the body is not UTF-8. Throws
 * `MissingPath` when a payload lacks a path its kind requires.
 */
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
    body: maskBody(x.body, type, dialectOf(x.route)),
  };
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Equal status, equal (masked) headers, byte-equal masked bodies. */
export function normalizedEqual(a: Normalized | null, b: Normalized | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.status === b.status &&
    a.headers.length === b.headers.length &&
    a.headers.every(([k, v], i) => b.headers[i]?.[0] === k && b.headers[i]?.[1] === v) &&
    bytesEqual(a.body, b.body)
  );
}

/** For failure output only. */
export function show(n: Normalized | null): string {
  return n === null
    ? "<not UTF-8>"
    : JSON.stringify({ ...n, body: Buffer.from(n.body).toString("latin1") });
}
