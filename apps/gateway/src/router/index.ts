import { eligible } from "./filters.ts";
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
 */
function weightedShuffle(candidates: Candidate[], rand: number): Candidate[] {
  const total = candidates.reduce((sum, c) => sum + c.credential.weight * c.target.weight, 0);
  if (total <= 0) return [...candidates].sort((a, b) => b.score - a.score);

  let cursor = rand * total;
  let chosen = candidates.length - 1;
  for (let i = 0; i < candidates.length; i++) {
    cursor -=
      (candidates[i] as Candidate).credential.weight * (candidates[i] as Candidate).target.weight;
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
      scored.sort((a, b) => idle(b) - idle(a));
      break;
    }

    case "weighted":
      return { candidates: weightedShuffle(scored, input.rand), excluded };

    case "score":
      scored.sort((a, b) => b.score - a.score);
      break;
  }

  return { candidates: scored, excluded };
}

export { requiredCapabilities } from "./filters.ts";
export { resolveModel } from "./resolve.ts";
export { buildSnapshot, healthKey } from "./snapshot.ts";
export type { Candidate, Excluded, RankInput, RankResult, Snapshot } from "./types.ts";
