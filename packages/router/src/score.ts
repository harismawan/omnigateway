import { type ChatRequest, estimateInputTokens } from "@omni/ir";
import type { CredentialHealth, Target } from "@omni/store";
import type { Pair } from "./filters.ts";
import { quotaHeadroom } from "./quota.ts";
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
 * Maps a magnitude into 0..1 against the best observed, keeping the distance.
 *
 * `lowerIsBetter` answers "where does this rank", which throws away how far
 * apart the candidates are: 100ms against 105ms and 100ms against 10s both come
 * out 1 and 0. That makes a configured weight mean something different on every
 * request, and makes the `reasons` map unreadable. This answers "how much worse
 * than the best" instead, so twice as slow scores 0.5 whoever else is eligible.
 */
function ratio(value: number, min: number): number {
  return Math.min(1, min / value);
}

/**
 * The smallest positive value, or null when nothing was measured or priced.
 *
 * Zero means "unknown" for both terms that use this, so it must not become the
 * minimum every other candidate is divided by — one unpriced target would
 * otherwise zero the cost term for the whole pool.
 */
function bestPositive(values: number[]): number | null {
  const positive = values.filter((v) => v > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
}

/**
 * Assumed output length, in tokens, when the request does not cap it lower.
 *
 * A prior, not a prediction. `maxTokens` alone cannot serve: clients routinely
 * send tens of thousands and return a few hundred, so trusting it would make
 * every request look output-bound. An unusually low cap is believed, because a
 * client asking for a hundred tokens really will not get more.
 *
 * Deliberately not a setting. Tuning it needs per-workload output data the
 * gateway does not collect, so a knob would only invite guessing.
 */
const EXPECTED_OUTPUT_TOKENS = 1000;

/**
 * What this request would cost on this target, in price-units.
 *
 * Only ever compared against other targets for the same request, so the units
 * cancel and the absolute number does not need to mean currency.
 */
function requestCost(target: Target, request: ChatRequest): number {
  const inTok = estimateInputTokens(request);
  const outTok = Math.min(request.maxTokens ?? EXPECTED_OUTPUT_TOKENS, EXPECTED_OUTPUT_TOKENS);
  return inTok * target.costPerMTok.input + outTok * target.costPerMTok.output;
}

/**
 * How much a credential's recent record is worth, in 0..1.
 *
 * Shared with the weighted draw so scoring and the lottery cannot disagree
 * about which credentials are sick.
 */
export function healthScore(h: CredentialHealth | undefined): number {
  const base = 1 / (1 + (h?.consecutiveFailures ?? 0));
  // A half-open probe is worth trying but should lose to a healthy peer.
  return h?.breakerState === "open" || h?.breakerState === "halfOpen" ? base * 0.5 : base;
}

export function score(pairs: Pair[], input: RankInput): Candidate[] {
  const { snapshot, now, load } = input;
  const w = snapshot.settings.weights;

  const tiers = pairs.map((p) => p.target.tier);
  const minTier = Math.min(...tiers);
  const maxTier = Math.max(...tiers);

  const costs = pairs.map((p) => requestCost(p.target, input.request));
  const bestCost = bestPositive(costs);

  const bestLatency = bestPositive(
    pairs.flatMap((p) => {
      const h = snapshot.health.get(healthKey(p.credential.id, p.target.model));
      return h?.ewmaTtftMs != null ? [h.ewmaTtftMs] : [];
    }),
  );

  return pairs.map((pair, i) => {
    const key = healthKey(pair.credential.id, pair.target.model);
    const h = snapshot.health.get(key);

    const tier = lowerIsBetter(pair.target.tier, minTier, maxTier);

    // Requests already in flight, not requests already finished. `lastUsedAt`
    // only moves on completion, so it cannot separate a burst that arrives
    // together; this can.
    const inflight = load.get(key) ?? 0;
    const loadTerm = 1 / (1 + inflight);

    const health = healthScore(h);

    const quota = quotaHeadroom(
      pair.credential,
      snapshot.quota.get(pair.credential.id) ?? [],
      now,
      snapshot.settings.quotaPollIntervalMs,
    );

    // A zero-priced target means "unpriced", not "free"; treat it as unknown.
    const ownCost = costs[i] as number;
    const cost = ownCost <= 0 || bestCost === null ? UNKNOWN : ratio(ownCost, bestCost);

    const latency =
      h?.ewmaTtftMs == null || bestLatency === null ? UNKNOWN : ratio(h.ewmaTtftMs, bestLatency);

    const reasons = { tier, health, quota, cost, latency, load: loadTerm };
    const base =
      tier * w.tier +
      health * w.health +
      quota * w.quota +
      cost * w.cost +
      latency * w.latency +
      loadTerm * w.load;

    return {
      credential: pair.credential,
      target: pair.target,
      score: base * pair.credential.weight * pair.target.weight,
      reasons,
    };
  });
}
