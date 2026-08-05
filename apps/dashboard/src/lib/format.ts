export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

const UNITS: ReadonlyArray<readonly [limit: number, ms: number, label: string]> = [
  [60_000, 1_000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [Number.POSITIVE_INFINITY, 86_400_000, "d"],
];

/** "12s ago" / "in 4h". Coarse on purpose: exact clock times invite squinting. */
export function formatRelative(at: number, now: number): string {
  const delta = at - now;
  const abs = Math.abs(delta);
  if (abs < 1_000) return "just now";
  const unit = UNITS.find(([limit]) => abs < limit) ?? UNITS[UNITS.length - 1];
  if (unit === undefined) return "just now";
  const [, milliseconds, suffix] = unit;
  const label = `${Math.round(abs / milliseconds)}${suffix}`;
  return delta < 0 ? `${label} ago` : `in ${label}`;
}

/** Token expiry, with `null` meaning a credential whose token does not expire. */
export function formatExpiry(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "no expiry";
  return expiresAt <= now ? "expired" : `expires ${formatRelative(expiresAt, now)}`;
}
