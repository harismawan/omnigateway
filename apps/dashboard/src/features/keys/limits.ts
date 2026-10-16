import type {
  Dimension,
  LimitConfig,
  LimitConfigBase,
  LimitReading,
  Window,
} from "../../api/types.ts";

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

/**
 * How one reading reads in a sentence, naming the model for an override:
 * `Requests per minute for opus`. Without the model an override's ceiling
 * would read as the whole key's.
 */
export function describeReading(reading: LimitReading): string {
  const name = describeSlot({ dimension: reading.dimension, window: reading.window });
  return reading.model === null ? name : `${name} for ${reading.model}`;
}

/** One scope's readings: the key-wide ones (`model: null`) or one model's. */
export type ReadingGroup = { model: string | null; readings: LimitReading[] };

/**
 * Readings grouped by scope, in the order the route emits them — key-wide
 * first, then each override. Grouped on `reading.model` rather than looked up
 * in `limits.models`, so the console never indexes that record by a name.
 */
export function groupReadings(readings: readonly LimitReading[]): ReadingGroup[] {
  const groups: ReadingGroup[] = [];
  for (const reading of readings) {
    const group = groups.find((entry) => entry.model === reading.model);
    if (group === undefined) groups.push({ model: reading.model, readings: [reading] });
    else group.readings.push(reading);
  }
  return groups;
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

export function draftFrom(limits: LimitConfigBase | null): LimitDraft {
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

export type DraftResult = { limits: LimitConfigBase } | { problem: string };

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
  const limits: LimitConfigBase = {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
    ...(Object.keys(spend).length > 0 ? { spend } : {}),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
  return { limits };
}

/**
 * The schema's own bounds on overrides, mirrored so a field is named first.
 *
 * Copies, because the console may not import `@omni/ratelimit`; pinned to the
 * originals by `apps/gateway/test/routes/modelOverrideBoundsMirror.test.ts`.
 */
export const MAX_MODEL_OVERRIDES = 64;
export const MAX_MODEL_NAME_LENGTH = 256;

/**
 * One per-model override being edited. `id` is the row's identity while the
 * dialog is open, so renaming a model does not remount its fields. `stored` is
 * the name the row was read back with, null for a row added here.
 */
export type OverrideDraft = {
  id: string;
  model: string;
  stored: string | null;
  slots: LimitDraft;
};

/**
 * The stored overrides as editable rows, in the order the matrix holds them.
 * Walked as own entries; nothing here looks a model up by name.
 */
export function overridesFrom(limits: LimitConfig | null): OverrideDraft[] {
  if (limits === null) return [];
  return Object.entries(limits.models ?? {}).map(([model, override], index) => ({
    id: `stored-${index}`,
    model,
    stored: model,
    slots: draftFrom(override),
  }));
}

export type OverridesResult = { models: Record<string, LimitConfigBase> } | { problem: string };

/**
 * The rows as the route's `models` member, or the first problem with one.
 *
 * Mirrors the schema's rules so the message names the row: a model is named,
 * once, within the length the schema allows; an override sets at least one
 * limit, because an empty one reads as a ceiling that is not there — removing
 * the row is how an override goes away. An empty `models` is returned as such
 * and the caller leaves the member out.
 *
 * Names are never trimmed. A model is matched exactly, so a trim would rename
 * an override behind the operator's back; a name *typed* with surrounding
 * spaces is refused instead, while a stored one goes back exactly as it came.
 */
export function overridesToModels(overrides: readonly OverrideDraft[]): OverridesResult {
  if (overrides.length > MAX_MODEL_OVERRIDES) {
    return { problem: `A key can override at most ${MAX_MODEL_OVERRIDES} models.` };
  }
  const entries: Array<[string, LimitConfigBase]> = [];
  const seen = new Set<string>();
  for (const override of overrides) {
    const model = override.model;
    if (model.trim().length === 0) return { problem: "Each per-model override needs a model." };
    if (model !== model.trim() && model !== override.stored) {
      return {
        problem: `"${model}" has spaces around it, and model names are matched exactly. Remove them.`,
      };
    }
    if (model.length > MAX_MODEL_NAME_LENGTH) {
      return { problem: `A model name is at most ${MAX_MODEL_NAME_LENGTH} characters.` };
    }
    if (model === "__proto__") return { problem: '"__proto__" cannot be a model name.' };
    if (seen.has(model)) return { problem: `${model} is overridden twice; keep one row.` };
    seen.add(model);

    const result = draftToLimits(override.slots);
    if ("problem" in result) return { problem: `${model}: ${result.problem}` };
    if (Object.keys(result.limits).length === 0) {
      return {
        problem: `The override for ${model} sets no limit. Set one, or remove the override.`,
      };
    }
    entries.push([model, result.limits]);
  }
  // `fromEntries` defines own properties, so no name reaches a prototype setter.
  return { models: Object.fromEntries(entries) };
}
