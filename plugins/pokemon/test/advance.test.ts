import { expect, test } from "bun:test";
import { advance } from "../src/advance.ts";
import { EGG_HATCH_THRESHOLD, graduationTotal, phaseThreshold } from "../src/balance.ts";
import { type CompanionState, freshState, parseState, serialiseState } from "../src/state.ts";

/** An egg with a species already rolled, which is the normal steady state. */
function readyEgg(over: Partial<CompanionState> = {}): CompanionState {
  return {
    ...freshState(),
    pendingHatch: {
      speciesId: 1,
      path: [1, 2, 3],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      ditto: false,
    },
    ...over,
  };
}

test("advancing twice with the same total changes nothing the second time", () => {
  // The property everything else rests on. `advance` runs on every read as well
  // as every credit, and the console polls — so a version that credited what it
  // was handed rather than the difference would double-count on every refresh.
  const once = advance(readyEgg(), 4_000_000);
  const twice = advance(once.state, 4_000_000);

  expect(twice.state).toEqual(once.state);
  expect(twice.events).toEqual([]);
});

test("a total that went backwards credits nothing rather than un-growing", () => {
  // Should not happen — the counter is monotonic — but if it ever did, the
  // answer is to do nothing, not to reverse an evolution.
  const grown = advance(readyEgg(), 4_000_000);
  const backwards = advance(grown.state, 1_000);

  expect(backwards.state.eggUsage).toBe(grown.state.eggUsage);
  expect(backwards.events).toEqual([]);
});

test("an egg hatches at its threshold and carries the excess into the hatchling", () => {
  const result = advance(readyEgg(), EGG_HATCH_THRESHOLD + 250_000);

  expect(result.events).toEqual([{ kind: "hatched", speciesId: 1, isShiny: false, ditto: false }]);
  expect(result.state.active?.usedAtStage).toBe(250_000);
  expect(result.state.eggUsage).toBe(0);
});

test("an egg with no rolled species holds at its threshold instead of opening", () => {
  // The offline case. The species is rolled ahead of time, so with no roll there
  // is nothing to become — and the progress has to wait rather than drain, or an
  // outage would silently cost a player their incubation.
  const result = advance(freshState(), EGG_HATCH_THRESHOLD * 3);

  expect(result.events).toEqual([]);
  expect(result.state.active).toBeNull();
  expect(result.state.eggUsage).toBe(EGG_HATCH_THRESHOLD * 3);

  // And it opens the moment a roll lands, needing no further tokens.
  //
  // This assertion used to read the other way — that nothing moves without a new
  // credit — and that was the bug: a state already past its threshold sat there
  // until the next request happened to arrive, which on a quiet or revoked key
  // is never. Transitions are driven by the state now, not by the arrival of
  // tokens.
  const withRoll = advance({ ...result.state, pendingHatch: readyEgg().pendingHatch }, 0);
  expect(withRoll.events[0]?.kind).toBe("hatched");
  expect(withRoll.state.active?.usedAtStage).toBe(EGG_HATCH_THRESHOLD * 2);
});

test("a stage completes into an evolution, and the overflow carries", () => {
  const hatched = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const firstStage = phaseThreshold("common", 3, 0);

  const result = advance(hatched, hatched.consumedTotal + firstStage + 1_000);

  expect(result.events).toEqual([{ kind: "evolved", from: 1, to: 2 }]);
  expect(result.state.active?.stageIndex).toBe(1);
  expect(result.state.active?.usedAtStage).toBe(1_000);
});

test("a whole line graduates and returns to an egg", () => {
  // The full arc in one credit, which also exercises the carry between stages:
  // the graduation total is by definition enough for every stage of the line.
  const start = readyEgg();
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("common"));

  const kinds = result.events.map((e) => e.kind);
  expect(kinds).toEqual(["hatched", "evolved", "evolved", "graduated"]);

  const graduation = result.events.at(-1);
  expect(graduation).toMatchObject({ kind: "graduated", baseId: 1, finalId: 3, rarity: "common" });
  expect(result.state.active).toBeNull();
});

test("a graduation carries the whole line and the nature, not just its ends", () => {
  // The Dex stores `chain_order`, and `advance` is the only thing that knows the
  // line. Rebuilding `[baseId, finalId]` at the call site lost every middle form
  // and wrote `[50, 50]` for a one-form line — with the column, the reader and
  // the spec all expecting a chain.
  // A nature that is NOT the parser's fallback, deliberately. An earlier version
  // of this used "hardy" — which is also the default — so replacing the field
  // with a hard-coded default was invisible and the mutation survived.
  const start = readyEgg({
    pendingHatch: {
      speciesId: 1,
      path: [1, 2, 3],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      ditto: false,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("common"));
  const graduation = result.events.at(-1);

  expect(graduation).toMatchObject({
    kind: "graduated",
    chainOrder: [1, 2, 3],
    nature: "sassy",
  });
});

test("a one-form line graduates without ever evolving", () => {
  const start = readyEgg({
    pendingHatch: {
      speciesId: 50,
      path: [50],
      rarity: "rare",
      isShiny: true,
      nature: "brave",
      ditto: false,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("rare"));

  expect(result.events.map((e) => e.kind)).toEqual(["hatched", "graduated"]);
  expect(result.events.at(-1)).toMatchObject({ finalId: 50, isShiny: true });
});

test("a hatch carries the shininess and disguise that were rolled with it", () => {
  // Decided at roll time, not at hatch time — otherwise `advance` would need
  // randomness and every transition here would stop being reproducible.
  const start = readyEgg({
    pendingHatch: {
      speciesId: 10,
      path: [10, 11],
      rarity: "common",
      isShiny: true,
      nature: "jolly",
      ditto: true,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD);

  expect(result.events[0]).toMatchObject({ kind: "hatched", isShiny: true, ditto: true });
  expect(result.state.active?.isShiny).toBe(true);
  expect(result.state.active?.dittoDisguise).toBe(10);
  expect(result.state.active?.nature).toBe("jolly");
});

test("consumed total always matches what was credited, whatever happened", () => {
  // The meter and the ledger cannot drift. A transition that blocks — a missing
  // roll — must still consume, or the gap grows every time it happens.
  for (const total of [1, EGG_HATCH_THRESHOLD - 1, EGG_HATCH_THRESHOLD * 2, 10_000_000_000]) {
    expect(advance(readyEgg(), total).state.consumedTotal).toBe(total);
    expect(advance(freshState(), total).state.consumedTotal).toBe(total);
  }
});

test("growth never runs backwards across a long random walk", () => {
  // Monotonicity stated as a property rather than as a single case. Nothing in
  // the arc — hatching, evolving, graduating back to an egg — may reduce the
  // total consumed.
  let state = readyEgg();
  let total = 0;
  let previous = 0;
  for (let i = 1; i <= 200; i++) {
    total += i * 137_000;
    // A graduation clears `pendingHatch`, so top it up the way the caller does.
    if (state.active === null && state.pendingHatch === null) {
      state = { ...state, pendingHatch: readyEgg().pendingHatch };
    }
    state = advance(state, total).state;
    expect(state.consumedTotal).toBeGreaterThanOrEqual(previous);
    previous = state.consumedTotal;
  }
});

// -------------------------------------------------------------- persistence

test("a companion round-trips through storage", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD + 400_000).state;
  expect(parseState(serialiseState(grown))).toEqual(grown);
});

test("an unreadable rarity refuses the whole save rather than guessing", () => {
  // Fails closed. A defaulted rarity silently changes the graduation total —
  // how much work the Pokémon costs — and nothing would report it.
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).rarity = "mythic-ultra";

  expect(parseState(JSON.stringify(corrupted))).toBeNull();
});

test("an empty evolution path refuses the save", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).plannedPath = [];

  expect(parseState(JSON.stringify(corrupted))).toBeNull();
});

test("an unknown nature degrades instead of refusing, because it costs an adjective", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).nature = "grumpy";

  const parsed = parseState(JSON.stringify(corrupted));
  expect(parsed).not.toBeNull();
  expect(parsed?.active?.nature).toBe("hardy");
});

test("a stage index past the end is clamped rather than discarding the save", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).stageIndex = 99;

  expect(parseState(JSON.stringify(corrupted))?.active?.stageIndex).toBe(2);
});

test("a legendary egg tier read back from storage becomes no guarantee", () => {
  // Nothing can sell one, so a stored one is corruption or a downgrade. Reading
  // it as "no guarantee" declines to invent a promise nobody paid for.
  const state = { ...freshState(), eggTier: "legendary" } as unknown as CompanionState;
  expect(parseState(JSON.stringify(state))?.eggTier).toBeNull();
});

test("garbage is null, not a fresh companion", () => {
  // The distinction the UI needs: "cannot be read" and "has not started" look
  // identical if both come back as a fresh egg, and only one of them is a
  // reason to stop and look.
  expect(parseState("not json")).toBeNull();
  expect(parseState("[1,2,3]")).toBeNull();
  expect(parseState("null")).toBeNull();
});
