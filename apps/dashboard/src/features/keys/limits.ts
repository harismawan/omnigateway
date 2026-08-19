import type { Dimension, LimitConfig, LimitReading, Window } from "../../api/types.ts";

/**
 * One editable cell of the matrix.
 *
 * The sparse shape is spelled out rather than derived from the dimension and
 * window unions crossed together: `spend` has no `1m` — a per-minute dollar
 * ceiling is a rate limit in costume, and `requests` and `tokens` already shape
 * burst at that horizon — and `concurrency` is a gauge with no window at all.
 */
export type LimitSlot = { dimension: Dimension; window: Window | null };

export const LIMIT_SLOTS: readonly LimitSlot[] = [
  { dimension: "requests", window: "1m" },
  { dimension: "requests", window: "5h" },
  { dimension: "requests", window: "1w" },
  { dimension: "tokens", window: "1m" },
  { dimension: "tokens", window: "5h" },
  { dimension: "tokens", window: "1w" },
  { dimension: "spend", window: "5h" },
  { dimension: "spend", window: "1w" },
  { dimension: "concurrency", window: null },
];

/** The `dimension:window` spelling the CLI uses, so the two surfaces agree. */
export function slotKey(slot: LimitSlot): string {
  return slot.window === null ? slot.dimension : `${slot.dimension}:${slot.window}`;
}

export const DIMENSION_LABEL: Record<Dimension, string> = {
  requests: "Requests",
  tokens: "Tokens",
  spend: "Spend",
  concurrency: "Concurrent",
};

export const WINDOW_LABEL: Record<Window, string> = {
  "1m": "per minute",
  "5h": "per 5 hours",
  "1w": "per week",
};

/** How one limit reads in a sentence, e.g. `Spend per week`. */
export function describeSlot(slot: LimitSlot): string {
  const dimension = DIMENSION_LABEL[slot.dimension];
  return slot.window === null ? dimension : `${dimension} ${WINDOW_LABEL[slot.window]}`;
}

export function formatLimitValue(dimension: Dimension, value: number): string {
  if (dimension === "spend") return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
  return value.toLocaleString("en-US");
}

/**
 * Share of a ceiling already spent, and null where nothing measures it.
 *
 * Not clamped to 1. `nearestExhaustion` ranks on this figure, and a ceiling can
 * genuinely be passed — `tokens` and `spend` debit after a response completes,
 * so a key finishes one request beyond them — so clamping here makes a key 10%
 * over indistinguishable from one 400% over and hands the summary whichever
 * came first. The gateway's own `evaluate` ranks unclamped for the same reason.
 * `Meter` is the only consumer that needs a bounded number, and it is bounded
 * at that call site.
 */
export function fractionOf(reading: LimitReading): number | null {
  if (reading.used === null || reading.limit <= 0) return null;
  return Math.max(0, reading.used / reading.limit);
}

/**
 * The limit that will deny first: the one nearest exhaustion by proportion.
 *
 * Not the first configured, and not the shortest window. A key one request from
 * its weekly ceiling and idle this minute would otherwise be summarised by a
 * comfortable per-minute figure, which is exactly the row an operator opened the
 * board to find. Readings nothing measures — `concurrency`, an in-flight gauge
 * held in the serving process — cannot be ranked and are skipped rather than
 * treated as empty.
 */
export function nearestExhaustion(readings: readonly LimitReading[]): LimitReading | null {
  let nearest: LimitReading | null = null;
  let best = -1;
  for (const reading of readings) {
    const fraction = fractionOf(reading);
    if (fraction === null) continue;
    if (fraction > best) {
      nearest = reading;
      best = fraction;
    }
  }
  return nearest;
}

/** Every configured limit as typed text, keyed by slot. Blank means unset. */
export type LimitDraft = Record<string, string>;

export function draftFrom(limits: LimitConfig | null): LimitDraft {
  const draft: LimitDraft = {};
  for (const slot of LIMIT_SLOTS) draft[slotKey(slot)] = "";
  if (limits === null) return draft;

  for (const slot of LIMIT_SLOTS) {
    const value =
      slot.window === null
        ? limits.concurrency
        : slot.dimension === "requests"
          ? limits.requests?.[slot.window]
          : slot.dimension === "tokens"
            ? limits.tokens?.[slot.window]
            : slot.window === "1m"
              ? undefined
              : limits.spend?.[slot.window];
    // An absent pair and an explicit null both mean unlimited, so both read
    // back as a blank field rather than as two spellings of the same thing.
    if (value !== undefined && value !== null) draft[slotKey(slot)] = String(value);
  }
  return draft;
}

export type DraftResult = { limits: LimitConfig } | { problem: string };

/**
 * Turns the typed matrix into what the route accepts, or names the first field
 * that cannot be one.
 *
 * The rules mirror the stored schema rather than trusting it to refuse: zero is
 * not a ceiling but a revoked key, and a fractional request count is not a
 * number of requests. Catching them here names the field; catching them at the
 * route names a JSON path.
 */
export function draftToLimits(draft: LimitDraft): DraftResult {
  const requests: Partial<Record<Window, number>> = {};
  const tokens: Partial<Record<Window, number>> = {};
  const spend: Partial<Record<Exclude<Window, "1m">, number>> = {};
  let concurrency: number | undefined;

  for (const slot of LIMIT_SLOTS) {
    const raw = (draft[slotKey(slot)] ?? "").trim();
    if (raw.length === 0) continue;

    const value = Number(raw);
    const money = slot.dimension === "spend";
    if (!Number.isFinite(value) || value <= 0 || (!money && !Number.isInteger(value))) {
      return {
        problem: money
          ? `${describeSlot(slot)} must be an amount above zero, or blank for no limit.`
          : `${describeSlot(slot)} must be a whole number above zero, or blank for no limit.`,
      };
    }

    if (slot.window === null) concurrency = value;
    else if (slot.dimension === "requests") requests[slot.window] = value;
    else if (slot.dimension === "tokens") tokens[slot.window] = value;
    else if (slot.window !== "1m") spend[slot.window] = value;
  }

  // A dimension with nothing in it is omitted outright: unlimited has one
  // spelling, and an empty object inside the matrix would be a second.
  const limits: LimitConfig = {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
    ...(Object.keys(spend).length > 0 ? { spend } : {}),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
  return { limits };
}
