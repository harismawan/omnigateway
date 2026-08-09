import type { ErrorCode } from "./errors.ts";
import type { ProviderId } from "./request.ts";

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

/**
 * The only shape a log line may carry, and the mechanism that keeps prompts,
 * tokens, and keys out of stdout.
 *
 * There is deliberately no index signature: a body, a header map, or a
 * credential secret does not typecheck as an argument, so redaction is enforced
 * by the compiler rather than by review. Widening this type — and especially
 * adding a field that can hold free text — needs the same care as the redaction
 * rules themselves.
 *
 * Every value spells out `| undefined` so a nullable value can be passed
 * directly under `exactOptionalPropertyTypes`, instead of forcing a
 * `...(x === undefined ? {} : { x })` spread at every call site.
 */
export type LogFields = {
  requestId?: string | undefined;
  surface?: "anthropic" | "openai" | undefined;
  status?: number | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  requestedModel?: string | undefined;
  credentialId?: string | undefined;
  apiKeyId?: string | undefined;
  attempt?: number | undefined;
  attempts?: number | undefined;
  code?: ErrorCode | "INTERNAL" | "interrupted" | undefined;
  retryable?: boolean | undefined;
  stream?: boolean | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
  ttftMs?: number | null | undefined;
  durationMs?: number | undefined;
  retryAfterMs?: number | undefined;
  count?: number | undefined;
  rawCount?: number | undefined;
  dailyCount?: number | undefined;
  host?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  reason?: string | undefined;
};

/**
 * Render order, fixed rather than insertion-ordered.
 *
 * A line's shape is then a function of its fields alone, which is what lets a
 * test assert an exact string and an operator grep for `code=UPSTREAM` without
 * caring which call site wrote it.
 */
const FIELD_ORDER = [
  "requestId",
  "surface",
  "status",
  "provider",
  "model",
  "requestedModel",
  "credentialId",
  "apiKeyId",
  "attempt",
  "attempts",
  "code",
  "retryable",
  "stream",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "ttftMs",
  "durationMs",
  "retryAfterMs",
  "count",
  "rawCount",
  "dailyCount",
  "host",
  "port",
  "path",
  // Last on purpose: the only free-text field, and the only truncated one, so
  // a long message can never push a structured field out of view.
  "reason",
] as const satisfies ReadonlyArray<keyof LogFields>;

/**
 * How much of `reason` survives.
 *
 * It carries `error.message`, and `httpError` fills that with up to 500
 * characters of an upstream error body — which can echo prompt fragments on a
 * context-length error. Truncation is the cap on that leak.
 */
const REASON_MAX = 200;

const LEVEL_COLOR: Readonly<Record<LogLevel, string>> = {
  debug: "\u001b[2;37m",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

const RESET = "\u001b[0m";

/** Bare values are printed as-is; anything ambiguous is quoted. */
const NEEDS_QUOTING = /[\s="]/;

function renderValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  return NEEDS_QUOTING.test(value) ? JSON.stringify(value) : value;
}

export function formatLine(
  level: LogLevel,
  at: number,
  msg: string,
  fields: LogFields | undefined,
  color: boolean,
): string {
  const label = level.toUpperCase().padEnd(5, " ");
  const head = `${new Date(at).toISOString()} ${color ? `${LEVEL_COLOR[level]}${label}${RESET}` : label} ${msg}`;
  if (fields === undefined) return head;

  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined) continue;
    const capped =
      key === "reason" && typeof value === "string" && value.length > REASON_MAX
        ? `${value.slice(0, REASON_MAX)}…`
        : value;
    parts.push(`${key}=${renderValue(capped)}`);
  }

  return parts.length === 0 ? head : `${head}  ${parts.join(" ")}`;
}

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Guard for the few paths where building `fields` is not free. */
  enabled(level: LogLevel): boolean;
};

/**
 * A logger over an injected sink.
 *
 * Pure by construction: the clock and the write are arguments, so nothing here
 * touches `process`, `console`, or a timer, and `packages/ir` stays
 * side-effect-free. The bootstrap is the one place that supplies stdout.
 */
export function createLogger(opts: {
  level: LogLevel;
  write: (line: string) => void;
  now?: () => number;
  color?: boolean;
}): Logger {
  const threshold = LEVELS[opts.level];
  const now = opts.now ?? (() => Date.now());
  const color = opts.color ?? false;

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVELS[level] < threshold) return;
    try {
      opts.write(formatLine(level, now(), msg, fields, color));
    } catch {
      // A log line must never fail the work that produced it. A full pipe or a
      // closed stdout under a service manager is exactly the moment an operator
      // least wants the gateway to start throwing.
    }
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    enabled: (level) => LEVELS[level] >= threshold,
  };
}

/** The default on every deps object, so logging is opt-in for callers. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  enabled: () => false,
};

/** Returns null for an unrecognised value, so the caller decides the fallback. */
export function parseLogLevel(value: string | undefined): LogLevel | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return null;
  // `in` would also match inherited keys, so `OMNI_LOG_LEVEL=constructor`
  // would parse as a level and then index to undefined.
  return Object.hasOwn(LEVELS, normalized) ? (normalized as LogLevel) : null;
}
