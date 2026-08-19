import { expect, test } from "bun:test";
import {
  EGG_HATCH_THRESHOLD,
  FRESH_EGG_BASE_PRICE,
  freshEggPrice,
  graduationTotal,
  ITEM_PRICES,
  phaseThreshold,
  RARE_CANDY_XP,
  RARITIES,
  rarityFromCaptureRate,
  sortRank,
} from "../src/balance.ts";

test("the rarity vocabulary is persisted, so it is a storage contract", () => {
  // These strings go into `rarity` on every companion row and every dex entry.
  // Adding one is free; renaming one loses every row that used it.
  expect(RARITIES).toEqual(["common", "uncommon", "rare", "legendary"]);
});

test("sortRank orders rarity ascending by value", () => {
  // The only consumer is the premium egg's guarantee gate, which refuses a roll
  // whose rarity ranks below the tier that was paid for. Invert this and a
  // guaranteed-rare egg quietly hands back commons.
  const ranks = RARITIES.map(sortRank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(new Set(ranks).size).toBe(RARITIES.length);
});

test("capture rate maps to rarity at the documented ceilings", () => {
  // One source for the thresholds. Written in two places they drift, and the
  // half that drifts is whichever one nobody is looking at.
  expect(rarityFromCaptureRate(3, false, false)).toBe("rare");
  expect(rarityFromCaptureRate(45, false, false)).toBe("rare");
  expect(rarityFromCaptureRate(46, false, false)).toBe("uncommon");
  expect(rarityFromCaptureRate(120, false, false)).toBe("uncommon");
  expect(rarityFromCaptureRate(121, false, false)).toBe("common");
  expect(rarityFromCaptureRate(255, false, false)).toBe("common");
});

test("legendary comes from the flags, never from a capture rate", () => {
  // Legendaries are all capture_rate <= 45, so a rate-only rule would call them
  // rare. The flags are the only thing that distinguishes them, which is also
  // why a legendary-guaranteed egg cannot exist: the hatch candidate index
  // carries capture rates and not flags.
  expect(rarityFromCaptureRate(3, true, false)).toBe("legendary");
  expect(rarityFromCaptureRate(3, false, true)).toBe("legendary");
  expect(rarityFromCaptureRate(255, true, false)).toBe("legendary");
});

test("a line's stage costs sum to its graduation total, whatever the form count", () => {
  // The property the formula exists for: graduating a one-form common and a
  // three-form common cost the same in total. Without it, evolution count
  // silently becomes a difficulty setting.
  for (const rarity of RARITIES) {
    for (const forms of [1, 2, 3, 4]) {
      const total = Array.from({ length: forms }, (_, stage) =>
        phaseThreshold(rarity, forms, stage),
      ).reduce((a, b) => a + b, 0);
      // Rounding per stage, so the sum lands within a form-count of the target.
      expect(Math.abs(total - graduationTotal(rarity))).toBeLessThanOrEqual(forms);
    }
  }
});

test("each stage costs more than the one before it", () => {
  // Growth should decelerate as a Pokémon matures rather than pass evenly.
  for (const forms of [2, 3, 4]) {
    const costs = Array.from({ length: forms }, (_, stage) =>
      phaseThreshold("common", forms, stage),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1] as number);
    }
  }
});

test("a rare candy costs more than the growth it grants", () => {
  // Tokens are both the growth meter and the wallet, so pricing a candy at its
  // own XP makes buying one free growth. At five times, the tokens spent
  // earning it already grew you more than the candy does — which keeps the free
  // grant from hitting a limit strictly better than the purchase.
  expect(ITEM_PRICES.rareCandy).toBeGreaterThan(RARE_CANDY_XP);
  expect(ITEM_PRICES.rareCandy).toBe(RARE_CANDY_XP * 5);
});

test("one candy cannot skip a stage, even the cheapest one", () => {
  // A candy is meant to be a nudge. If its XP cleared a whole stage it would
  // chain through evolutions and graduate a line in a single click.
  const cheapestStage = phaseThreshold("common", 1, 0);
  expect(RARE_CANDY_XP).toBeLessThan(cheapestStage);
});

test("egg incubation is small next to a single stage, so an egg is a prelude", () => {
  expect(EGG_HATCH_THRESHOLD).toBeLessThan(phaseThreshold("common", 1, 0));
});

test("a guaranteed egg is priced by graduation ratio, never by probability", () => {
  // The bug this encodes: priced by the odds ratio (uncommon ~7.16%, rare
  // ~6.98%, about 1:2.03), two uncommon eggs beat one rare egg on every axis —
  // more rare-or-better AND more legendaries for the same spend — making the
  // higher tier a strictly inferior product nobody should ever buy.
  //
  // Priced by graduation totals, a tier costs what its output is worth.
  expect(freshEggPrice(null)).toBe(FRESH_EGG_BASE_PRICE);
  for (const tier of ["uncommon", "rare"] as const) {
    expect(freshEggPrice(tier) / freshEggPrice(null)).toBeCloseTo(
      graduationTotal(tier) / graduationTotal("common"),
      6,
    );
  }
});

test("no cheaper egg tier is a better deal than a dearer one", () => {
  // The general form of the rule above, stated as the property rather than as
  // the arithmetic: paying more must never buy less.
  const tiers = [null, "uncommon", "rare"] as const;
  for (let i = 1; i < tiers.length; i++) {
    expect(freshEggPrice(tiers[i] as "uncommon" | "rare")).toBeGreaterThan(
      freshEggPrice(tiers[i - 1] as null | "uncommon" | "rare"),
    );
  }
});

test("a legendary-guaranteed egg is not for sale", () => {
  // Two reasons, both structural. Its floor cannot be expressed as a capture
  // rate, and the top rarity should not be a purchasable certainty — it turns
  // up in the higher tiers at its natural weight instead.
  // @ts-expect-error the type refuses it; this pins that the type is the guard.
  expect(() => freshEggPrice("legendary")).toThrow();
});
