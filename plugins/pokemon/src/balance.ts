/**
 * The companion's economy, ported from PokeTokenBar with its reasoning intact.
 *
 * Several of these numbers look arbitrary and are not: each one that carries a
 * comment is a bug the source app already shipped and fixed. Changing a value
 * without reading the comment above it re-introduces the bug the comment
 * describes.
 *
 * Pure by construction — no clock, no randomness, no I/O. Everything here is a
 * function of its arguments, which is what lets the whole economy be tested
 * without a database or a network.
 */

/**
 * The rarity vocabulary.
 *
 * Persisted in `rarity` on every companion and every dex entry, so this is a
 * storage contract rather than an internal enum. Adding a name is free;
 * renaming or removing one loses every row that used it.
 */
export const RARITIES = ["common", "uncommon", "rare", "legendary"] as const;

export type Rarity = (typeof RARITIES)[number];

/** A rarity a fresh egg can guarantee. Legendary is deliberately absent — see `freshEggPrice`. */
export type GuaranteedTier = Exclude<Rarity, "legendary">;

/**
 * Rank within `RARITIES`, ascending by value.
 *
 * The only consumer is the premium egg's guarantee gate, which refuses a rolled
 * species whose rarity ranks below the tier that was paid for. Inverted, a
 * guaranteed-rare egg quietly hands back commons — which is why the ordering has
 * its own test rather than being trusted to the array's order.
 */
export function sortRank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

/**
 * The capture-rate ceiling for each rarity: at or below it, a species is at
 * least this rare.
 *
 * One source for the thresholds. PokeTokenBar learned this the hard way — the
 * classifier and the premium egg's candidate filter each had their own copy, and
 * only one of them was updated.
 *
 * `legendary` has no ceiling because it cannot be expressed as one: legendaries
 * are all capture_rate <= 45, so a rate-only rule would call them rare. They are
 * identified by their flags alone.
 */
const CAPTURE_RATE_CEILING: Record<Exclude<Rarity, "legendary">, number> = {
  rare: 45,
  uncommon: 120,
  common: 255,
};

export function rarityFromCaptureRate(
  captureRate: number,
  isLegendary: boolean,
  isMythical: boolean,
): Rarity {
  if (isLegendary || isMythical) return "legendary";
  if (captureRate <= CAPTURE_RATE_CEILING.rare) return "rare";
  if (captureRate <= CAPTURE_RATE_CEILING.uncommon) return "uncommon";
  return "common";
}

/**
 * Tokens to take a line from egg to graduation.
 *
 * Tuned in the source app against roughly 253M tokens/day on one laptop, which
 * put a common at about three days of real work and a legendary at a month. A
 * gateway fronting several clients moves far more than that, which is what the
 * operator-facing multiplier is for — see the plugin's `config.multiplier`.
 */
const GRADUATION_TOTAL: Record<Rarity, number> = {
  common: 750_000_000,
  uncommon: 1_875_000_000,
  rare: 3_000_000_000,
  legendary: 6_000_000_000,
};

export function graduationTotal(rarity: Rarity): number {
  return GRADUATION_TOTAL[rarity];
}

/**
 * Tokens to leave stage `stageIndex` of a line with `totalForms` forms.
 *
 * Weighted so stage *i* of *k* costs `T·i / (k(k+1)/2)`. Two properties fall out
 * and both are load-bearing:
 *
 * The costs sum to `T` whatever `k` is, so graduating a one-form common and a
 * three-form common cost the same. Without that, how many evolutions a species
 * happens to have becomes a difficulty setting nobody chose.
 *
 * And each stage costs more than the last, so growth decelerates as a Pokémon
 * matures rather than passing evenly.
 */
export function phaseThreshold(rarity: Rarity, totalForms: number, stageIndex: number): number {
  const forms = Math.max(1, totalForms);
  const step = stageIndex + 1;
  const denominator = (forms * (forms + 1)) / 2;
  return Math.round((graduationTotal(rarity) * step) / denominator);
}

/**
 * Tokens an egg absorbs before it hatches.
 *
 * Small next to a single stage on purpose: an egg is a prelude, not a stage of
 * its own. Whatever is spent past this carries into the hatchling.
 */
export const EGG_HATCH_THRESHOLD = 5_000_000;

/** Growth a rare candy injects. */
export const RARE_CANDY_XP = 100_000_000;

/**
 * Shop prices.
 *
 * `rareCandy` is five times the growth it grants, and that ratio is the point.
 * Tokens are both the growth meter and the wallet here, so pricing a candy at
 * its own XP would make buying one free growth — spend 100M to gain 100M. At
 * five times, earning the price already grew you more than the candy will, which
 * is what keeps the free grant from hitting a rate limit strictly better than
 * the purchase.
 *
 * `mint` only rerolls nature, which is cosmetic. There is no balance argument
 * for its price, so it is cheap enough to reroll until a nature feels right.
 *
 * `shinyCharm` is bought once and never consumed, so it is priced against a
 * whole rare graduation.
 */
export const ITEM_PRICES: Record<"rareCandy" | "mint" | "shinyCharm", number> = {
  rareCandy: 500_000_000,
  mint: 100_000_000,
  shinyCharm: 3_000_000_000,
};

export type ItemKind = keyof typeof ITEM_PRICES;

export const ITEM_KINDS = Object.keys(ITEM_PRICES) as readonly ItemKind[];

export const FRESH_EGG_BASE_PRICE = 1_000_000_000;

/**
 * What a fresh egg costs, optionally guaranteeing a rarity floor.
 *
 * Priced by the **graduation-total ratio**, never by the probability ratio, and
 * this is the single most important number in the file.
 *
 * By the odds — uncommon-or-better around 7.16%, rare-or-better around 6.98%,
 * call it 1:2.03 — two uncommon eggs would beat one rare egg on every axis at
 * the same spend: more rare-or-better *and* more legendaries. The higher tier
 * becomes a strictly inferior product that no informed player should ever buy,
 * which is a shop with a trap in it rather than a shop with tiers.
 *
 * By graduation totals (1 : 2.5 : 4) a tier costs what its output is worth, and
 * paying more always buys more.
 *
 * There is no legendary tier. Its floor cannot be expressed as a capture rate,
 * and the top rarity should not be a purchasable certainty — it appears in the
 * upper tiers at its natural weight instead. The type refuses it rather than a
 * runtime check, so the absence is visible where a caller would try.
 */
export function freshEggPrice(tier: GuaranteedTier | null): number {
  if (tier === null) return FRESH_EGG_BASE_PRICE;
  // Refused at runtime as well as in the type. `legendary` has a graduation
  // total like every other rarity, so the arithmetic below would happily price
  // it — and a legendary egg quietly appearing in the shop at 8B is a
  // game-design change that no error would announce.
  if ((tier as Rarity) === "legendary") {
    throw new Error("there is no legendary fresh egg; legendaries come from the upper tiers");
  }
  const multiplier = graduationTotal(tier) / graduationTotal("common");
  return Math.round(FRESH_EGG_BASE_PRICE * multiplier);
}

/** Odds denominators. Rolled against an injected seed, never against live randomness. */
export const ODDS = {
  /**
   * The mainline games use 1/4096, which on a gateway dashboard is a lifetime
   * of never seeing one. 1/64 is often enough to be a story and rare enough to
   * still be one.
   */
  shiny: 64,
  /** Holding the charm. A third better rather than doubled — the charm is a nudge. */
  shinyWithCharm: 48,
  /** Ditto's disguise, on common multi-form hatches only. */
  dittoDisguise: 128,
} as const;

/** Ditto's species id, reachable only by revealing a disguise and never by a roll. */
export const DITTO_SPECIES_ID = 132;

/**
 * The species range with animated sprites.
 *
 * The community sprite set only has Gen-V animations for the first 649. A
 * companion is a small moving thing on a panel, so a species with no animation
 * is not a candidate at all — the alternative is a still image beside moving
 * ones, which reads as broken rather than as variety.
 */
export const ANIMATED_SPECIES_MAX = 649;

export function hasAnimatedSprite(speciesId: number): boolean {
  return speciesId >= 1 && speciesId <= ANIMATED_SPECIES_MAX;
}
