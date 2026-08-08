/** Display helpers. Every one is pure and safe to call with absent data. */

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value < 10_000 ? PLAIN.format(Math.round(value)) : COMPACT.format(value).toLowerCase();
}

export function formatTokens(value: number): string {
  return formatCount(value);
}

/**
 * Cost spans six orders of magnitude between one request and one month, so the
 * precision follows the value instead of being fixed at two decimals.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${COMPACT.format(value).toLowerCase()}`;
}

export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.round(value / 60_000)}m`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

const DURATION_STEPS: ReadonlyArray<[limit: number, unit: number, suffix: string]> = [
  [60_000, 1_000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [Number.POSITIVE_INFINITY, 86_400_000, "d"],
];

/** Compact duration, e.g. `4d`, `18h`, `12m`, `9s`. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1_000) return "0s";
  const step = DURATION_STEPS.find(([limit]) => abs < limit);
  if (step === undefined) return "—";
  return `${Math.floor(abs / step[1])}${step[2]}`;
}

/** `12m ago` / `in 3h` / `just now`. */
export function formatRelative(at: number | null | undefined, now = Date.now()): string {
  if (at == null || !Number.isFinite(at)) return "—";
  const delta = at - now;
  if (Math.abs(delta) < 5_000) return "just now";
  return delta < 0 ? `${formatDuration(delta)} ago` : `in ${formatDuration(delta)}`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}

export function formatDateTime(at: number | null | undefined): string {
  if (at == null || !Number.isFinite(at)) return "—";
  return new Date(at).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Truncates an id for display while keeping it recognisable. */
export function shortId(id: string, head = 8): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`;
}
