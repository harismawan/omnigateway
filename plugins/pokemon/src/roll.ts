import {
  DITTO_SPECIES_ID,
  type GuaranteedTier,
  hasAnimatedSprite,
  ODDS,
  type Rarity,
  rarityFromCaptureRate,
  sortRank,
} from "./balance.ts";

/**
 * The 25 natures. Cosmetic — they affect nothing but identity, which is exactly
 * why they are worth having: two players with the same species have different
 * Pokémon.
 */
export const NATURES = [
  "hardy",
  "lonely",
  "brave",
  "adamant",
  "naughty",
  "bold",
  "docile",
  "relaxed",
  "impish",
  "lax",
  "timid",
  "hasty",
  "serious",
  "jolly",
  "naive",
  "modest",
  "mild",
  "quiet",
  "bashful",
  "rash",
  "calm",
  "gentle",
  "sassy",
  "careful",
  "quirky",
] as const;

export type Nature = (typeof NATURES)[number];

/**
 * One species the hatch may produce.
 *
 * Deliberately carries no legendary flag. The candidate index is built from the
 * capture-rate column of the species list, and the legendary and mythical flags live
 * on a different endpoint — which is the structural reason a legendary-only egg
 * cannot be sold. Legendaries still appear: they are all capture_rate <= 45, so
 * they fall inside the rare filter at their natural weight.
 */
export type SpeciesCandidate = {
  /**
   * A **base** form, and only ever a base form.
   *
   * Mid-chain species used to be candidates too, and that made one evolution
   * line cost several different prices: a roll landing on Metapod (capture 120,
   * uncommon, 1.875B) and one landing on Caterpie (capture 255, common, 750M)
   * produced the same line for two and a half times the work. Rarity is read
   * from the rolled species' capture rate, so the only way for a line to have
   * one price is for only its base to be rollable.
   */
  id: number;
  captureRate: number;
  /** Forms in the evolution line, for the Ditto-disguise condition. */
  forms: number;
  /**
   * The last form in the line.
   *
   * Carried so diversity weighting can compare like with like. The Dex records
   * finals, and the weighting used to test a candidate's own id against that
   * set — which for any multi-form line compares a base against a final and is
   * therefore inert, silently, for exactly the species that have evolutions.
   */
  finalId: number;
};

export type Roll = {
  speciesId: number;
  isShiny: boolean;
  nature: Nature;
  /** True when this hatch is a Ditto wearing `speciesId` as a disguise. */
  ditto: boolean;
};

/**
 * A deterministic 32-bit PRNG (mulberry32).
 *
 * The whole reason the seed is a parameter. PokeTokenBar rolls against live
 * randomness, which makes a 1-in-64 shiny and a 1-in-128 Ditto effectively
 * untestable — you cannot assert an event you cannot reproduce, so the source
 * app has no test for either. Here the same seed always produces the same
 * Pokémon, so both are ordinary assertions.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RollInput = {
  candidates: readonly SpeciesCandidate[];
  seed: number;
  /** A paid rarity floor, or null for an unguaranteed egg. */
  guarantee: GuaranteedTier | null;
  hasShinyCharm: boolean;
  /**
   * Final species already in the Dex.
   *
   * Weighted down rather than excluded: a collection should broaden without a
   * duplicate becoming impossible, and excluding outright would make the last
   * few species unreachable once everything else was collected.
   */
  collectedFinals: ReadonlySet<number>;
};

/** How much less likely an already-collected species is. */
const COLLECTED_WEIGHT = 0.25;

/**
 * Picks a species, its shininess, its nature, and whether it is a disguised
 * Ditto — all from one seed.
 *
 * Weighted by capture rate, so a common species is common. Rejection sampling
 * would be the faithful port, but it cannot terminate against a filter that
 * matches nothing (a guaranteed-rare egg over a candidate list with no rares),
 * so this builds the weighted set once and indexes into it. Same distribution,
 * no unbounded loop.
 *
 * Returns null when nothing can satisfy the constraints, which the caller shows
 * as an egg that has not hatched rather than as an error — the candidate index
 * is fetched from a third party and may simply not have arrived yet.
 */
export function roll(input: RollInput): Roll | null {
  const random = mulberry32(input.seed);

  const eligible = input.candidates.filter((candidate) => {
    // A species with no animation is not a candidate at all: a still sprite
    // beside moving ones reads as broken rather than as variety.
    if (!hasAnimatedSprite(candidate.id)) return false;
    // Ditto is reachable only by revealing a disguise, never by a hatch.
    if (candidate.id === DITTO_SPECIES_ID) return false;
    if (input.guarantee === null) return true;
    const rarity = rarityFromCaptureRate(candidate.captureRate, false, false);
    return sortRank(rarity) >= sortRank(input.guarantee);
  });

  if (eligible.length === 0) return null;

  // Capture rate is "how easy to catch", so it is the weight directly: a rate of
  // 255 is common, a rate of 3 is not.
  const weights = eligible.map((candidate) => {
    const base = Math.max(1, candidate.captureRate);
    return input.collectedFinals.has(candidate.finalId) ? base * COLLECTED_WEIGHT : base;
  });
  const total = weights.reduce((a, b) => a + b, 0);

  let target = random() * total;
  let index = 0;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] as number;
    if (target <= 0) {
      index = i;
      break;
    }
  }
  const chosen = eligible[index] as SpeciesCandidate;

  const shinyDenominator = input.hasShinyCharm ? ODDS.shinyWithCharm : ODDS.shiny;
  const isShiny = random() < 1 / shinyDenominator;

  const nature = NATURES[Math.floor(random() * NATURES.length)] as Nature;

  // Only a common multi-form hatch can be a Ditto in disguise. A rare species
  // turning out to be a Ditto would read as the game taking something away.
  const rarity: Rarity = rarityFromCaptureRate(chosen.captureRate, false, false);
  const dittoEligible = rarity === "common" && chosen.forms >= 2;
  const ditto = dittoEligible && random() < 1 / ODDS.dittoDisguise;

  return { speciesId: chosen.id, isShiny, nature, ditto };
}
