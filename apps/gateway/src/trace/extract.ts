import type { ChatRequest } from "@omni/ir";
import type { RequestLog, TraceAgent } from "@omni/store";

/**
 * Who a request belongs to, as far as the caller told us.
 *
 * Grouping only: nothing here ever selects a key, a model, a route or a limit.
 * Every field is caller-supplied, bounded, and dropped rather than refused when
 * it is malformed — traceability never fails inference. Design:
 * docs/superpowers/specs/2026-10-24-request-traceability-design.md.
 */
export type TraceContext = {
  /** `<agent>:<id>` when inferred, the caller's own value verbatim when explicit. */
  sessionId: string | null;
  turnId: string | null;
  agent: TraceAgent | null;
  tags: string[];
  metadata: Record<string, string>;
  clientRequestId: string | null;
  /** Something was dropped or cut; the row records {@link TRACE_INVALID}. */
  invalid: boolean;
};

/** A constant on purpose: it lands in `degradations`, which never holds request data. */
export const TRACE_INVALID = "trace:invalid";

const MAX_ID = 256;
const MAX_TAGS = 16;
const MAX_TAG = 64;
const MAX_META = 16;
const MAX_META_KEY = 64;
const MAX_META_VALUE = 256;
const MAX_LINE = 4096;

const PRINTABLE_ID = /^[\x21-\x7e]+$/;
const PRINTABLE_VALUE = /^[\x20-\x7e]*$/;
const TAG = /^[A-Za-z0-9._:/-]+$/;
const META_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * User agents, from each client's source:
 * - OpenCode: `opencode/<channel>/<version>/<app>` (`packages/core/src/app.ts` `useragent`).
 * - Pi: `pi/<version> (<platform>; <runtime>; <arch>)`, or `pi` in short mode
 *   (`packages/ai/src/utils/identity.ts` `formatUserAgent`).
 * Pinned by `apps/gateway/test/trace/extract.test.ts`.
 */
const OPENCODE_UA = /^opencode\//i;
const PI_UA = /^pi(?:\/|$)/i;

/**
 * Stamps a request's trace onto one of its log rows, in place.
 *
 * Every site that writes the row calls this — begin, completion, the terminal
 * catch — so a row completed by a different path than began it still carries
 * the same context. The upstream request id is not part of the trace; dispatch
 * fills it in. Degradations are deduplicated, as dispatch's are.
 */
export function applyTrace(log: RequestLog, trace: TraceContext): void {
  log.sessionId = trace.sessionId;
  log.turnId = trace.turnId;
  log.agent = trace.agent;
  log.tags = [...trace.tags];
  log.traceMetadata = { ...trace.metadata };
  log.clientRequestId = trace.clientRequestId;
  if (trace.invalid && !log.degradations.includes(TRACE_INVALID)) {
    log.degradations.push(TRACE_INVALID);
  }
}

/** {@link applyTrace} for a log built inline: returns it, and accepts no trace. */
export function withTrace(log: RequestLog, trace: TraceContext | null): RequestLog {
  if (trace !== null) applyTrace(log, trace);
  return log;
}

export function extractTrace(headers: Headers, request: ChatRequest): TraceContext {
  let invalid = false;
  const flag = () => {
    invalid = true;
  };

  /** One header line, ignored whole past 4 KiB. */
  const line = (name: string): string | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    if (raw.length > MAX_LINE) {
      flag();
      return undefined;
    }
    return raw;
  };

  const id = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const value = raw.trim();
    if (value.length === 0) return null;
    if (value.length > MAX_ID || !PRINTABLE_ID.test(value)) {
      flag();
      return null;
    }
    return value;
  };

  const inferred = inferAgent(request, line, flag);
  const prefixed = (value: string | undefined): string | null => {
    if (inferred === null || value === undefined) return null;
    const bounded = id(value);
    return bounded === null ? null : `${inferred.agent}:${bounded}`;
  };

  const sessionId = id(line("x-omni-session-id")) ?? prefixed(inferred?.session);
  const turnId = id(line("x-omni-turn-id")) ?? prefixed(inferred?.turn);
  const tags = parseTags(line("x-omni-tags"), flag);
  const metadata = parseMetadata(line("x-omni-metadata"), flag);
  const clientRequestId = id(line("x-request-id"));

  return {
    sessionId,
    turnId,
    agent: inferred?.agent ?? null,
    tags,
    metadata,
    clientRequestId,
    invalid,
  };
}

type Inferred = { agent: TraceAgent; session?: string | undefined; turn?: string | undefined };

function inferAgent(
  request: ChatRequest,
  line: (name: string) => string | undefined,
  flag: () => void,
): Inferred | null {
  const ua = line("user-agent") ?? "";
  const generic = () =>
    line("x-session-id") ?? line("session_id") ?? line("x-session-affinity") ?? undefined;

  const claude = line("x-claude-code-session-id");
  if (claude !== undefined) return { agent: "claude-code", session: claude };

  const codex = codexTurn(request, line, flag);
  if (codex !== null) return { agent: "codex", ...codex };

  // Pi before OpenCode: Pi sends OpenCode's routing headers when it talks to
  // an OpenCode endpoint, with `x-opencode-client: pi` and its own user agent.
  if (PI_UA.test(ua) || line("x-opencode-client")?.trim().toLowerCase() === "pi") {
    return { agent: "pi", session: line("x-opencode-session") ?? generic() };
  }

  const opencodeSession = line("x-opencode-session-id") ?? line("x-opencode-session");
  if (opencodeSession !== undefined || OPENCODE_UA.test(ua)) {
    return {
      agent: "opencode",
      session: opencodeSession ?? generic(),
      turn: line("x-opencode-request"),
    };
  }
  return null;
}

/**
 * Codex's thread and turn, read from its turn snapshot: the Responses body's
 * `client_metadata["x-codex-turn-metadata"]` first, then the header of the
 * same name, then the flat `client_metadata` keys. Nothing else is kept.
 */
function codexTurn(
  request: ChatRequest,
  line: (name: string) => string | undefined,
  flag: () => void,
): { session: string; turn?: string | undefined } | null {
  const meta = request.vendor?.openai?.client_metadata;
  const bag = isRecord(meta) ? meta : undefined;

  const fromSnapshot = (raw: unknown) => {
    if (typeof raw !== "string") return null;
    if (raw.length > MAX_LINE) {
      flag();
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("not an object");
      const session = str(parsed.thread_id);
      if (session === undefined) return null;
      return { session, turn: str(parsed.turn_id) };
    } catch {
      flag();
      return null;
    }
  };

  const body = fromSnapshot(bag?.["x-codex-turn-metadata"]);
  if (body !== null) return body;
  const header = fromSnapshot(line("x-codex-turn-metadata"));
  if (header !== null) return header;
  const flat = str(bag?.thread_id);
  if (flat !== undefined) return { session: flat, turn: str(bag?.turn_id) };
  return null;
}

function parseTags(raw: string | undefined, flag: () => void): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG || !TAG.test(tag)) {
      flag();
      continue;
    }
    if (out.includes(tag)) continue;
    if (out.length === MAX_TAGS) {
      flag();
      break;
    }
    out.push(tag);
  }
  return out;
}

function parseMetadata(raw: string | undefined, flag: () => void): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  for (const part of raw.split(",")) {
    if (part.trim().length === 0) continue;
    const colon = part.indexOf(":");
    if (colon < 0) {
      flag();
      continue;
    }
    const key = decode(part.slice(0, colon).trim());
    const value = decode(part.slice(colon + 1).trim());
    if (
      key === null ||
      value === null ||
      key.length === 0 ||
      key.length > MAX_META_KEY ||
      !META_KEY.test(key) ||
      value.length > MAX_META_VALUE ||
      !PRINTABLE_VALUE.test(value)
    ) {
      flag();
      continue;
    }
    if (!(key in out) && Object.keys(out).length === MAX_META) {
      flag();
      continue;
    }
    out[key] = value;
  }
  return out;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
