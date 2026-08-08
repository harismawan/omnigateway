import { eligible } from "./filters.ts";
import { QUOTA_FLOOR, quotaHeadroom } from "./quota.ts";
import { score } from "./score.ts";
import { healthKey } from "./snapshot.ts";
import type { Candidate, RankInput, RankResult } from "./types.ts";

/**
 * Reorders candidates by a weighted lottery.
 *
 * Only the head is drawn by weight; the tail keeps score order so failover
 * still walks the best remaining options. `rand` is injected, so the whole
 * router stays pure and a test can pin the draw.
 *
 * The draw runs over `candidates` in its arrival order (not pre-sorted by
 * score) — score already has `credential.weight * target.weight` baked in
 * (see `score.ts`), so sorting by score first would double-count weight and
 * skew the cumulative distribution toward heavier candidates regardless of
 * `rand`. The tail is sorted by score only after the head is drawn.
 *
 * Draw weight is scaled by quota headroom, so an account running out is drawn
 * proportionally less often rather than at its configured weight right up to
 * the moment the filter excludes it. A candidate with no headroom left is not
 * drawn at all, which is the same verdict the filter is about to reach.
 */
function weightedShuffle(
  candidates: Candidate[],
  rand: number,
  headroom: (c: Candidate) => number,
): Candidate[] {
  const drawWeight = (c: Candidate): number => c.credential.weight * c.target.weight * headroom(c);

  const total = candidates.reduce((sum, c) => sum + drawWeight(c), 0);
  if (total <= 0) return [...candidates].sort((a, b) => b.score - a.score);

  let cursor = rand * total;
  let chosen = candidates.length - 1;
  for (let i = 0; i < candidates.length; i++) {
    cursor -= drawWeight(candidates[i] as Candidate);
    if (cursor < 0) {
      chosen = i;
      break;
    }
  }

  const head = candidates[chosen] as Candidate;
  const tail = candidates.filter((_, i) => i !== chosen).sort((a, b) => b.score - a.score);
  return [head, ...tail];
}

export function rank(input: RankInput): RankResult {
  const { pairs, excluded } = eligible(input);
  if (pairs.length === 0) return { candidates: [], excluded };

  const scored = score(pairs, input);

  const headroom = (c: Candidate): number =>
    quotaHeadroom(
      c.credential,
      input.snapshot.quota.get(c.credential.id) ?? [],
      input.now,
      input.snapshot.settings.quotaPollIntervalMs,
    );

  switch (input.model.strategy) {
    case "priority":
      // Tier is the only signal; score breaks ties within a tier.
      scored.sort((a, b) => a.target.tier - b.target.tier || b.score - a.score);
      break;

    case "roundRobin": {
      const idle = (c: Candidate): number => {
        const h = input.snapshot.health.get(healthKey(c.credential.id, c.target.model));
        return h?.lastUsedAt == null ? Number.POSITIVE_INFINITY : input.now - h.lastUsedAt;
      };
      // Least-recently-used, except that an account close to exhaustion drops
      // to the tail. Strict rotation would keep handing work to the account
      // about to be excluded, and spend the rest of its window on retries.
      const spent = (c: Candidate): number => (headroom(c) < QUOTA_FLOOR ? 1 : 0);
      scored.sort((a, b) => spent(a) - spent(b) || idle(b) - idle(a));
      break;
    }

    case "weighted":
      return { candidates: weightedShuffle(scored, input.rand, headroom), excluded };

    case "score":
      scored.sort((a, b) => b.score - a.score);
      break;
  }

  return { candidates: scored, excluded };
}

export { blankHealth, PENALTY, type Penalty, recordFailure, recordSuccess } from "./breaker.ts";
export { eligible, type Pair, requiredCapabilities } from "./filters.ts";
export { QUOTA_FLOOR, quotaHeadroom, UNKNOWN_QUOTA } from "./quota.ts";
export { resolveModel } from "./resolve.ts";
export { buildSnapshot, healthKey } from "./snapshot.ts";
export type { Candidate, Excluded, RankInput, RankResult, Snapshot } from "./types.ts";
