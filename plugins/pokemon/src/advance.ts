import { EGG_HATCH_THRESHOLD, phaseThreshold, type Rarity } from "./balance.ts";
import type { CompanionState, MonState } from "./state.ts";

/**
 * Something worth telling the player about, produced by `advance` rather than
 * inferred by comparing states.
 *
 * A caller needs these to write a Dex row and to notify; deriving them by
 * diffing before and after would mean re-implementing the rules that produced
 * them, in a second place, from less information.
 */
export type CompanionEvent =
  | { kind: "hatched"; speciesId: number; isShiny: boolean; ditto: boolean }
  | { kind: "evolved"; from: number; to: number }
  | { kind: "graduated"; baseId: number; finalId: number; rarity: Rarity; isShiny: boolean };

export type AdvanceResult = {
  state: CompanionState;
  events: readonly CompanionEvent[];
};

/**
 * A stage that cannot be left however many tokens arrive, so a corrupt or
 * hostile path cannot spin here.
 */
const MAX_TRANSITIONS_PER_ADVANCE = 64;

/**
 * Applies everything `tokensTotal` has earned since this state last looked.
 *
 * **Idempotent by construction.** It is called on every read as well as on every
 * credit, so calling it twice with the same total must be a no-op — and it is,
 * because it works from `tokensTotal - state.consumedTotal` rather than from the
 * number it was handed. A version that took a delta would double-credit the
 * moment anything retried, and the retry is the normal case here: the console
 * polls.
 *
 * Pure. No clock, no randomness, no I/O. The species a hatch produces was rolled
 * earlier and written to `pendingHatch`, which is what lets this run offline and
 * what makes every transition below reproducible in a test.
 */
export function advance(state: CompanionState, tokensTotal: number): AdvanceResult {
  const gained = Math.max(0, Math.trunc(tokensTotal) - state.consumedTotal);
  if (gained === 0) return { state, events: [] };

  const events: CompanionEvent[] = [];
  let next: CompanionState = { ...state, consumedTotal: Math.trunc(tokensTotal) };
  let carry = gained;

  for (let step = 0; step < MAX_TRANSITIONS_PER_ADVANCE && carry > 0; step++) {
    if (next.active === null) {
      const total = next.eggUsage + carry;
      if (total < EGG_HATCH_THRESHOLD) {
        next = { ...next, eggUsage: total };
        carry = 0;
        break;
      }
      // The egg has met its threshold. Whether it can open is a different
      // question: the species is rolled ahead of time, and without that roll
      // there is nothing to become. The tokens are held at the threshold rather
      // than spent, so the moment a roll lands the hatch happens with its
      // progress intact.
      if (next.pendingHatch === null) {
        next = { ...next, eggUsage: total };
        carry = 0;
        break;
      }

      const hatch = next.pendingHatch;
      const active: MonState = {
        baseId: hatch.speciesId,
        plannedPath: hatch.path,
        stageIndex: 0,
        usedAtStage: 0,
        rarity: hatch.rarity,
        isShiny: hatch.isShiny,
        nature: hatch.nature,
        dittoDisguise: hatch.ditto ? hatch.speciesId : null,
        dittoRevealed: false,
      };
      events.push({
        kind: "hatched",
        speciesId: hatch.speciesId,
        isShiny: active.isShiny,
        ditto: active.dittoDisguise !== null,
      });
      // Everything past the threshold carries into the hatchling rather than
      // being lost, so a burst that overshoots is not punished.
      carry = total - EGG_HATCH_THRESHOLD;
      next = { ...next, active, eggUsage: 0, eggTier: null, pendingHatch: null };
      continue;
    }

    const mon = next.active;
    const needed = phaseThreshold(mon.rarity, mon.plannedPath.length, mon.stageIndex);
    const atStage = mon.usedAtStage + carry;
    if (atStage < needed) {
      next = { ...next, active: { ...mon, usedAtStage: atStage } };
      carry = 0;
      break;
    }

    carry = atStage - needed;
    const isFinalStage = mon.stageIndex >= mon.plannedPath.length - 1;

    if (!isFinalStage) {
      const from = mon.plannedPath[mon.stageIndex] as number;
      const to = mon.plannedPath[mon.stageIndex + 1] as number;
      events.push({ kind: "evolved", from, to });
      next = { ...next, active: { ...mon, stageIndex: mon.stageIndex + 1, usedAtStage: 0 } };
      continue;
    }

    events.push({
      kind: "graduated",
      baseId: mon.baseId,
      finalId: mon.plannedPath[mon.plannedPath.length - 1] as number,
      rarity: mon.rarity,
      isShiny: mon.isShiny,
    });
    // Graduating returns to an egg, carrying the overflow. The Dex row is the
    // caller's to write from the event: this function owns no storage.
    next = { ...next, active: null, eggUsage: 0, eggTier: null, pendingHatch: null };
  }

  // Whatever could not be spent still counts as consumed. Holding it back would
  // make the meter disagree with the credited total, and the disagreement would
  // grow every time a transition was blocked on a missing roll.
  if (carry > 0 && next.active !== null) {
    next = { ...next, active: { ...next.active, usedAtStage: next.active.usedAtStage + carry } };
  } else if (carry > 0) {
    next = { ...next, eggUsage: next.eggUsage + carry };
  }

  return { state: next, events };
}
