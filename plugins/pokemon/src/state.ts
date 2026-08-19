import {
  type GuaranteedTier,
  ITEM_KINDS,
  type ItemKind,
  RARITIES,
  type Rarity,
} from "./balance.ts";
import { NATURES, type Nature } from "./roll.ts";

/**
 * The Pokémon currently being raised.
 *
 * `plannedPath` is fixed at hatch from the species' evolution chain, so
 * `advance` never needs the network to know what comes next. That is what keeps
 * the state machine pure and what lets a companion keep growing while PokéAPI is
 * unreachable.
 */
export type MonState = {
  baseId: number;
  /** Species ids from first form to last, decided at hatch. */
  plannedPath: readonly number[];
  stageIndex: number;
  /** Tokens accumulated into the current stage. */
  usedAtStage: number;
  rarity: Rarity;
  isShiny: boolean;
  nature: Nature;
  /** Set when this is a Ditto wearing another species; null for an ordinary hatch. */
  dittoDisguise: number | null;
  dittoRevealed: boolean;
};

export type CompanionState = {
  /**
   * Every token ever credited that this state has already absorbed.
   *
   * The reason `advance` is idempotent. It is called on every read as well as on
   * every credit, so it must be safe to call twice with the same total — and it
   * is, because it works from the difference against this rather than from
   * whatever it was handed.
   */
  consumedTotal: number;
  /** Null while an egg is incubating. */
  active: MonState | null;
  /** Tokens into the current egg. Reset at every hatch. */
  eggUsage: number;
  /**
   * The rarity floor this egg was bought with.
   *
   * Persisted rather than held in memory, because the purchase happens before
   * the roll: buying a guaranteed egg cannot pick a species on the spot, since
   * that needs the candidate index. Writing the guarantee down is what makes the
   * purchase survive a restart and an offline stretch.
   */
  eggTier: GuaranteedTier | null;
  /**
   * The species this egg will hatch into, rolled in advance.
   *
   * Prefetched while the egg is still incubating so the hatch itself is a local
   * transition. Without it, hatching would need the network at the exact moment
   * it happens, and an offline gateway would hold an egg that has met its
   * threshold and cannot open.
   */
  pendingHatch: {
    speciesId: number;
    path: readonly number[];
    rarity: Rarity;
    /**
     * The rest of the roll, carried with it.
     *
     * Shininess and the Ditto disguise are decided when the roll happens, not
     * when the egg opens — so they are written down here alongside the species.
     * Deciding them at hatch would need randomness inside `advance`, and that
     * one dependency would make every transition in the state machine
     * irreproducible.
     */
    isShiny: boolean;
    nature: Nature;
    ditto: boolean;
  } | null;
  inventory: Record<ItemKind, number>;
  /**
   * Whether the first-run seeding of limit-window grants has happened.
   *
   * Without it, installing the plugin against an account already at its ceiling
   * pays out retroactively for windows it never watched fill.
   */
};

export function freshState(): CompanionState {
  return {
    consumedTotal: 0,
    active: null,
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: { rareCandy: 0, mint: 0, shinyCharm: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asRarity(value: unknown): Rarity | null {
  return RARITIES.includes(value as Rarity) ? (value as Rarity) : null;
}

/**
 * Parses a stored companion, or returns null.
 *
 * **Fails closed, deliberately, and this is the opposite of how the Dex reads.**
 *
 * An unreadable field here is not recoverable by guessing. A rarity that does
 * not parse decides the graduation total, so defaulting it silently changes how
 * much work the Pokémon costs — a change nothing would report and nobody would
 * notice. The row reads back as null, which the UI renders as "this save cannot
 * be read" rather than as a fresh egg, so an operator sees a problem instead of
 * silently losing months of growth.
 *
 * That is the `api_keys.limits` precedent: refuse where a wrong guess is
 * invisible. The Dex takes the other precedent (`isRtkFilterId`) because a bad
 * entry there costs one row of history and hiding the other two hundred would
 * be worse.
 */
export function parseState(raw: string): CompanionState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const inventory: Record<ItemKind, number> = { rareCandy: 0, mint: 0, shinyCharm: 0 };
  const storedInventory = parsed.inventory;
  if (isRecord(storedInventory)) {
    for (const kind of ITEM_KINDS) {
      inventory[kind] = Math.max(0, asInt(storedInventory[kind], 0));
    }
  }

  let active: MonState | null = null;
  const storedActive = parsed.active;
  if (storedActive !== null && storedActive !== undefined) {
    if (!isRecord(storedActive)) return null;

    const rarity = asRarity(storedActive.rarity);
    // The field that decides the cost of everything ahead. Unreadable means
    // unreadable, not "assume common".
    if (rarity === null) return null;

    const path = Array.isArray(storedActive.plannedPath)
      ? storedActive.plannedPath.filter((id): id is number => typeof id === "number" && id > 0)
      : [];
    // An empty path cannot render a sprite or decide what comes next, and there
    // is nothing to fall back to.
    if (path.length === 0) return null;

    const nature = NATURES.includes(storedActive.nature as Nature)
      ? (storedActive.nature as Nature)
      : null;
    // Nature is cosmetic, so an unknown one is the one field here that degrades
    // rather than refuses — it costs an adjective, not a number.
    active = {
      baseId: asInt(storedActive.baseId, path[0] as number),
      plannedPath: path,
      // Clamped rather than refused: a stage index past the end is recoverable
      // by pinning it to the last form, and the alternative is discarding a save
      // over an off-by-one.
      stageIndex: Math.min(Math.max(0, asInt(storedActive.stageIndex, 0)), path.length - 1),
      usedAtStage: Math.max(0, asInt(storedActive.usedAtStage, 0)),
      rarity,
      isShiny: storedActive.isShiny === true,
      nature: nature ?? "hardy",
      dittoDisguise:
        typeof storedActive.dittoDisguise === "number" ? storedActive.dittoDisguise : null,
      dittoRevealed: storedActive.dittoRevealed === true,
    };
  }

  const storedPending = parsed.pendingHatch;
  let pendingHatch: CompanionState["pendingHatch"] = null;
  if (isRecord(storedPending)) {
    const rarity = asRarity(storedPending.rarity);
    const path = Array.isArray(storedPending.path)
      ? storedPending.path.filter((id): id is number => typeof id === "number" && id > 0)
      : [];
    // A prefetch is an optimisation. An unreadable one is dropped and re-rolled
    // rather than refusing the save — nothing is lost but a network round trip.
    if (rarity !== null && path.length > 0) {
      const nature = NATURES.includes(storedPending.nature as Nature)
        ? (storedPending.nature as Nature)
        : "hardy";
      pendingHatch = {
        speciesId: asInt(storedPending.speciesId, path[0] as number),
        path,
        rarity,
        isShiny: storedPending.isShiny === true,
        nature,
        ditto: storedPending.ditto === true,
      };
    }
  }

  const eggTier = asRarity(parsed.eggTier);

  return {
    consumedTotal: Math.max(0, asInt(parsed.consumedTotal, 0)),
    active,
    eggUsage: Math.max(0, asInt(parsed.eggUsage, 0)),
    // A tier that does not parse becomes no guarantee, which is the safe
    // direction: it declines to invent a promise nobody paid for.
    eggTier: eggTier === null || eggTier === "legendary" ? null : eggTier,
    pendingHatch,
    inventory,
  };
}

export function serialiseState(state: CompanionState): string {
  return JSON.stringify(state);
}

/** Whether the charm's permanent effect is in force. Held, never consumed. */
export function hasShinyCharm(state: CompanionState): boolean {
  return (state.inventory.shinyCharm ?? 0) > 0;
}
