import type { Pair } from "./filters.ts";
import { healthKey } from "./snapshot.ts";
import type { Candidate, RankInput } from "./types.ts";

/** Neutral value for a term with no data — neither rewarded nor punished. */
const UNKNOWN = 0.5;

/** Maps a raw value into 0..1 where the minimum observed scores 1. */
function lowerIsBetter(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return (max - value) / (max - min);
}

/**
 * Blends input and output price into one number. Output dominates real spend on
 * chat workloads, so it carries three quarters of the weight.
 */
function blendedCost(input: number, output: number): number {
  return input * 0.25 + output * 0.75;
}

export function score(pairs: Pair[], input: RankInput): Candidate[] {
  const { snapshot, now } = input;
  const w = snapshot.settings.weights;

  const tiers = pairs.map((p) => p.target.tier);
  const minTier = Math.min(...tiers);
  const maxTier = Math.max(...tiers);

  const costs = pairs.map((p) =>
    blendedCost(p.target.costPerMTok.input, p.target.costPerMTok.output),
  );
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const latencies = pairs.flatMap((p) => {
    const h = snapshot.health.get(healthKey(p.credential.id, p.target.model));
    return h?.ewmaTtftMs != null ? [h.ewmaTtftMs] : [];
  });
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  const idleTimes = pairs.map((p) => {
    const h = snapshot.health.get(healthKey(p.credential.id, p.target.model));
    return h?.lastUsedAt == null ? Number.POSITIVE_INFINITY : now - h.lastUsedAt;
  });
  const finiteIdle = idleTimes.filter(Number.isFinite);
  const maxIdle = finiteIdle.length > 0 ? Math.max(...finiteIdle) : 1;

  return pairs.map((pair, i) => {
    const h = snapshot.health.get(healthKey(pair.credential.id, pair.target.model));

    const tier = lowerIsBetter(pair.target.tier, minTier, maxTier);

    // A half-open probe is worth trying but should lose to a healthy peer.
    let health = 1 / (1 + (h?.consecutiveFailures ?? 0));
    if (h?.breakerState === "open" || h?.breakerState === "halfOpen") health *= 0.5;

    const windows = snapshot.quota.get(pair.credential.id) ?? [];
    const limited = windows.filter((q) => q.limit !== null);
    const quota =
      limited.length === 0
        ? 1
        : Math.min(...limited.map((q) => Math.max(0, 1 - q.used / (q.limit as number))));

    // A zero-priced target means "unpriced", not "free"; treat it as unknown.
    const cost = maxCost === 0 ? UNKNOWN : lowerIsBetter(costs[i] as number, minCost, maxCost);

    const latency =
      h?.ewmaTtftMs == null ? UNKNOWN : lowerIsBetter(h.ewmaTtftMs, minLatency, maxLatency);

    const idle = idleTimes[i] as number;
    const recency = Number.isFinite(idle) ? Math.min(1, idle / (maxIdle || 1)) : 1;

    const reasons = { tier, health, quota, cost, latency, recency };
    const base =
      tier * w.tier +
      health * w.health +
      quota * w.quota +
      cost * w.cost +
      latency * w.latency +
      recency * w.recency;

    return {
      credential: pair.credential,
      target: pair.target,
      score: base * pair.credential.weight * pair.target.weight,
      reasons,
    };
  });
}
