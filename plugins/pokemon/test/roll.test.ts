import { expect, test } from "bun:test";
import {
  ANIMATED_SPECIES_MAX,
  DITTO_SPECIES_ID,
  ODDS,
  rarityFromCaptureRate,
} from "../src/balance.ts";
import { NATURES, type Roll, roll, type SpeciesCandidate } from "../src/roll.ts";

/** A spread of candidates across every rarity band, all with animations. */
const CANDIDATES: SpeciesCandidate[] = [
  { id: 1, captureRate: 45, forms: 3 }, // rare band
  { id: 10, captureRate: 255, forms: 3 }, // common, multi-form → ditto-eligible
  { id: 19, captureRate: 255, forms: 2 }, // common, multi-form
  { id: 100, captureRate: 190, forms: 1 }, // common, single form
  { id: 144, captureRate: 3, forms: 1 }, // rare band (a legendary in practice)
  { id: 200, captureRate: 90, forms: 2 }, // uncommon
];

function rollWith(seed: number, over: Partial<Parameters<typeof roll>[0]> = {}): Roll | null {
  return roll({
    candidates: CANDIDATES,
    seed,
    guarantee: null,
    hasShinyCharm: false,
    collectedFinals: new Set(),
    ...over,
  });
}

/** Rolls many seeds and counts how often a predicate holds. */
function rate(predicate: (r: Roll) => boolean, count: number, over = {}): number {
  let hits = 0;
  for (let seed = 1; seed <= count; seed++) {
    const result = rollWith(seed, over);
    if (result !== null && predicate(result)) hits++;
  }
  return hits / count;
}

test("the same seed always produces the same Pokémon", () => {
  // The property the whole design turns on. Without it neither of the rare
  // events below could be asserted at all, which is why the source app has no
  // test for either of them.
  for (const seed of [1, 42, 9999]) {
    expect(rollWith(seed)).toEqual(rollWith(seed));
  }
});

test("different seeds do not all produce the same Pokémon", () => {
  // Guards the degenerate implementation that satisfies determinism by ignoring
  // the seed entirely.
  const species = new Set(
    Array.from({ length: 50 }, (_, i) => rollWith(i + 1)?.speciesId).filter((x) => x !== undefined),
  );
  expect(species.size).toBeGreaterThan(1);
});

test("a guaranteed tier never rolls below itself", () => {
  // The premium egg's whole promise. A single leak here is a paid guarantee
  // silently not honoured, which is the one bug in this file a player would
  // notice and could not prove.
  for (let seed = 1; seed <= 300; seed++) {
    const result = rollWith(seed, { guarantee: "rare" as const });
    if (result === null) continue;
    const candidate = CANDIDATES.find((c) => c.id === result.speciesId);
    expect(candidate).toBeDefined();
    expect(rarityFromCaptureRate(candidate?.captureRate ?? 255, false, false)).toBe("rare");
  }
});

test("an unsatisfiable guarantee hatches nothing rather than throwing", () => {
  // The candidate index is fetched from a third party. "Not arrived yet" has to
  // read as an egg that has not hatched, not as a crash on the request path.
  const result = roll({
    candidates: [{ id: 10, captureRate: 255, forms: 1 }],
    seed: 1,
    guarantee: "rare",
    hasShinyCharm: false,
    collectedFinals: new Set(),
  });
  expect(result).toBeNull();
});

test("no candidates at all hatches nothing", () => {
  expect(rollWith(1, { candidates: [] })).toBeNull();
});

test("shiny lands near its declared odds, and the charm improves them", () => {
  // Asserted as a band rather than an exact count: this pins that the odds are
  // roughly what the constant says without freezing the PRNG's exact output,
  // which would make the test a change-detector for the algorithm.
  const plain = rate((r) => r.isShiny, 4000);
  const charmed = rate((r) => r.isShiny, 4000, { hasShinyCharm: true });

  expect(plain).toBeGreaterThan(1 / ODDS.shiny / 2);
  expect(plain).toBeLessThan((1 / ODDS.shiny) * 2);
  expect(charmed).toBeGreaterThan(plain);
});

test("a Ditto only ever disguises itself as a common multi-form species", () => {
  // A rare species turning out to be a Ditto would read as the game taking
  // something away rather than as a surprise.
  for (let seed = 1; seed <= 4000; seed++) {
    const result = rollWith(seed);
    if (result === null || !result.ditto) continue;
    const candidate = CANDIDATES.find((c) => c.id === result.speciesId);
    expect(rarityFromCaptureRate(candidate?.captureRate ?? 0, false, false)).toBe("common");
    expect(candidate?.forms ?? 0).toBeGreaterThanOrEqual(2);
  }
});

test("a Ditto is rarer than a shiny, and both actually occur", () => {
  // Both events are asserted to happen at all. A roll that never produces one
  // passes every other test in this file.
  const shinies = rate((r) => r.isShiny, 6000);
  const dittos = rate((r) => r.ditto, 6000);
  expect(shinies).toBeGreaterThan(0);
  expect(dittos).toBeGreaterThan(0);
  expect(dittos).toBeLessThan(shinies);
});

test("Ditto is never hatched directly", () => {
  // It is reachable only by revealing a disguise. In the candidate pool it
  // would otherwise be an ordinary common.
  const withDitto = [...CANDIDATES, { id: DITTO_SPECIES_ID, captureRate: 255, forms: 1 }];
  for (let seed = 1; seed <= 500; seed++) {
    expect(rollWith(seed, { candidates: withDitto })?.speciesId).not.toBe(DITTO_SPECIES_ID);
  }
});

test("a species with no animated sprite is never chosen", () => {
  // A still sprite beside moving ones reads as broken rather than as variety.
  const withUnanimated = [
    ...CANDIDATES,
    { id: ANIMATED_SPECIES_MAX + 1, captureRate: 255, forms: 1 },
    { id: 900, captureRate: 255, forms: 1 },
  ];
  for (let seed = 1; seed <= 500; seed++) {
    const id = rollWith(seed, { candidates: withUnanimated })?.speciesId ?? 0;
    expect(id).toBeLessThanOrEqual(ANIMATED_SPECIES_MAX);
  }
});

test("an already-collected species is less likely, but not impossible", () => {
  // Weighted down rather than excluded: excluding outright makes the last few
  // species unreachable once everything else is collected.
  const target = 100;
  const freely = rate((r) => r.speciesId === target, 2000);
  const collected = rate((r) => r.speciesId === target, 2000, {
    collectedFinals: new Set([target]),
  });

  expect(collected).toBeLessThan(freely);
  expect(collected).toBeGreaterThan(0);
});

test("every roll carries one of the 25 natures", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const nature = rollWith(seed)?.nature;
    expect(nature).toBeDefined();
    expect(NATURES).toContain(nature as (typeof NATURES)[number]);
  }
});
