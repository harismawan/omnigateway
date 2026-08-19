import type { PluginMigration, PluginStorage } from "@omni/plugins/define";
import type { CompanionEvent } from "./advance.ts";
import { advance } from "./advance.ts";
import { freshEggPrice, type GuaranteedTier, ITEM_PRICES, type ItemKind } from "./balance.ts";
import { type CompanionState, freshState, parseState, serialiseState } from "./state.ts";

/**
 * Three tables, not the four the design sketched.
 *
 * The species index lives in the `files` capability instead of a table, because
 * it is derived cache data fetched from a third party: `files` is already
 * excluded from database snapshots, which is exactly the property a cache wants
 * and exactly the property a snapshot wants. Putting it in a table would grow
 * every snapshot an operator downloads with data that re-fetches itself.
 */
export const MIGRATIONS: readonly PluginMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE {{companion}} (
        api_key_id   TEXT PRIMARY KEY,
        state        TEXT NOT NULL,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE {{dex}} (
        id          TEXT PRIMARY KEY,
        api_key_id  TEXT NOT NULL,
        base_id     INTEGER NOT NULL,
        final_id    INTEGER NOT NULL,
        chain_order TEXT NOT NULL,
        rarity      TEXT NOT NULL,
        is_shiny    INTEGER NOT NULL DEFAULT 0,
        nature      TEXT,
        caught_at   INTEGER NOT NULL
      )
    `,
  },
  {
    version: 3,
    // Newest first is the only order this is ever read in.
    sql: `CREATE INDEX {{dex_by_key}} ON {{dex}} (api_key_id, caught_at DESC)`,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE {{grants}} (
        api_key_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        -- An instant, not a tier. A grant is rate-limited by the window's own
        -- duration, because nothing tells this plugin when a window empties.
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (api_key_id, window_key)
      )
    `,
  },
];

/**
 * One graduated Pokémon.
 *
 * Rows rather than a JSON array inside the companion, and the reason is the
 * failure direction: a Dex grows without bound, the UI filters and sorts it, and
 * one corrupt entry must not take the save with it. As an array, a single bad
 * element would fail the parse of everything.
 */
export type DexEntry = {
  id: string;
  baseId: number;
  finalId: number;
  chainOrder: readonly number[];
  rarity: string;
  isShiny: boolean;
  nature: string | null;
  caughtAt: number;
};

export type CompanionRow = {
  apiKeyId: string;
  /** Null when the stored save could not be read — never a fresh companion. */
  state: CompanionState | null;
  tokensTotal: number;
  tokensSpent: number;
};

/** Spendable balance. Growth is never rewound by a purchase; only this shrinks. */
export function wallet(row: CompanionRow): number {
  return Math.max(0, row.tokensTotal - row.tokensSpent);
}

type StoredCompanion = {
  api_key_id: string;
  state: string;
  tokens_total: number;
  tokens_spent: number;
};

export function readCompanion(storage: PluginStorage, apiKeyId: string): CompanionRow | null {
  const row = storage.get<StoredCompanion>(
    "SELECT api_key_id, state, tokens_total, tokens_spent FROM {{companion}} WHERE api_key_id = ?",
    [apiKeyId],
  );
  if (row === null) return null;
  return {
    apiKeyId: row.api_key_id,
    state: parseState(row.state),
    tokensTotal: row.tokens_total,
    tokensSpent: row.tokens_spent,
  };
}

/**
 * Credits tokens to a key, creating its companion on first sight.
 *
 * Created lazily rather than when a key is minted: a companion measures from
 * install forward, so a key that has never been used has nothing to show and
 * nothing to store. That is also why there is no backfill anywhere in this
 * plugin — see the growth notes in the design.
 *
 * The counter only ever increases. It is never recomputed from `request_logs`,
 * because retention prunes that table and a recomputed meter would run backwards
 * after a sweep — a Pokémon de-evolving because an operator tidied a database.
 */
export function creditTokens(
  storage: PluginStorage,
  apiKeyId: string,
  tokens: number,
  now: number,
): void {
  if (tokens <= 0) return;
  storage.run(
    `INSERT INTO {{companion}} (api_key_id, state, tokens_total, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(api_key_id) DO UPDATE SET
       tokens_total = tokens_total + excluded.tokens_total,
       updated_at = excluded.updated_at`,
    [apiKeyId, serialiseState(freshState()), Math.trunc(tokens), now, now],
  );
}

/**
 * Applies everything the credited total has earned and writes the result back.
 *
 * Safe to call on every read: `advance` works from the difference against what
 * the state already absorbed, so a second call with an unchanged total is a
 * no-op rather than a second helping of growth.
 *
 * A save that cannot be read is left exactly as it is. Overwriting it with a
 * fresh companion would be the one irreversible thing this plugin could do to
 * somebody's months of growth, and it would do it silently.
 */
export function settle(
  storage: PluginStorage,
  apiKeyId: string,
  now: number,
): { row: CompanionRow; events: readonly CompanionEvent[] } | null {
  const row = readCompanion(storage, apiKeyId);
  if (row === null) return null;
  if (row.state === null) return { row, events: [] };

  const result = advance(row.state, row.tokensTotal);
  if (result.events.length === 0 && result.state === row.state) return { row, events: [] };

  storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
    serialiseState(result.state),
    now,
    apiKeyId,
  ]);
  return { row: { ...row, state: result.state }, events: result.events };
}

export function recordGraduation(
  storage: PluginStorage,
  apiKeyId: string,
  entry: Omit<DexEntry, "id">,
  id: string,
): void {
  storage.run(
    `INSERT INTO {{dex}} (id, api_key_id, base_id, final_id, chain_order, rarity, is_shiny, nature, caught_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      apiKeyId,
      entry.baseId,
      entry.finalId,
      JSON.stringify(entry.chainOrder),
      entry.rarity,
      entry.isShiny ? 1 : 0,
      entry.nature,
      entry.caughtAt,
    ],
  );
}

type StoredDex = {
  id: string;
  base_id: number;
  final_id: number;
  chain_order: string;
  rarity: string;
  is_shiny: number;
  nature: string | null;
  caught_at: number;
};

/**
 * The Dex, newest first.
 *
 * **Fails open, the opposite of the active companion.** An entry whose chain
 * will not parse is dropped from the listing and the rest are returned. A trophy
 * case is history: losing one row is a gap, and hiding the other two hundred
 * because of it would be the worse outcome. This is the `isRtkFilterId`
 * precedent, and the contrast with `parseState` is deliberate rather than
 * inconsistent.
 */
export function readDex(storage: PluginStorage, apiKeyId: string): DexEntry[] {
  const rows = storage.all<StoredDex>(
    `SELECT id, base_id, final_id, chain_order, rarity, is_shiny, nature, caught_at
     FROM {{dex}} WHERE api_key_id = ? ORDER BY caught_at DESC`,
    [apiKeyId],
  );

  const entries: DexEntry[] = [];
  for (const row of rows) {
    let chainOrder: unknown;
    try {
      chainOrder = JSON.parse(row.chain_order);
    } catch {
      continue;
    }
    if (!Array.isArray(chainOrder)) continue;
    const chain = chainOrder.filter((id): id is number => typeof id === "number");
    if (chain.length === 0) continue;

    entries.push({
      id: row.id,
      baseId: row.base_id,
      finalId: row.final_id,
      chainOrder: chain,
      rarity: row.rarity,
      isShiny: row.is_shiny === 1,
      nature: row.nature,
      caughtAt: row.caught_at,
    });
  }
  return entries;
}

/** When this window last paid, or null for never. */
export function lastGrantedAt(
  storage: PluginStorage,
  apiKeyId: string,
  windowKey: string,
): number | null {
  const row = storage.get<{ granted_at: number }>(
    "SELECT granted_at FROM {{grants}} WHERE api_key_id = ? AND window_key = ?",
    [apiKeyId, windowKey],
  );
  return row?.granted_at ?? null;
}

export function setGrantedAt(
  storage: PluginStorage,
  apiKeyId: string,
  windowKey: string,
  at: number,
): void {
  storage.run(
    `INSERT INTO {{grants}} (api_key_id, window_key, granted_at) VALUES (?, ?, ?)
     ON CONFLICT(api_key_id, window_key) DO UPDATE SET granted_at = excluded.granted_at`,
    [apiKeyId, windowKey, at],
  );
}

export type ShopEntry =
  | { kind: "item"; item: ItemKind }
  | { kind: "egg"; tier: GuaranteedTier | null };

export function shopPrice(entry: ShopEntry): number {
  return entry.kind === "item" ? ITEM_PRICES[entry.item] : freshEggPrice(entry.tier);
}

export type ConsumeResult =
  | { ok: true; row: CompanionRow }
  | { ok: false; reason: "none-held" | "unreadable" | "missing" };

/**
 * Spends one held item.
 *
 * The counterpart to `purchase`, and separate from it because the two take from
 * different places: a purchase debits the wallet, this decrements inventory. A
 * granted candy was never bought, so charging for it would be charging twice.
 *
 * Refuses on an unreadable save for the same reason `purchase` does — the state
 * an effect mutates cannot be read, and writing a fresh one over it would
 * destroy what could not be read.
 */
export function consume(
  storage: PluginStorage,
  apiKeyId: string,
  item: ItemKind,
  applyToState: (state: CompanionState) => CompanionState,
  now: number,
): ConsumeResult {
  const row = readCompanion(storage, apiKeyId);
  if (row === null) return { ok: false, reason: "missing" };
  if (row.state === null) return { ok: false, reason: "unreadable" };
  if ((row.state.inventory[item] ?? 0) <= 0) return { ok: false, reason: "none-held" };

  const nextState = applyToState({
    ...row.state,
    inventory: { ...row.state.inventory, [item]: (row.state.inventory[item] ?? 0) - 1 },
  });
  storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
    serialiseState(nextState),
    now,
    apiKeyId,
  ]);
  return { ok: true, row: { ...row, state: nextState } };
}

export type PurchaseResult =
  | { ok: true; row: CompanionRow }
  | { ok: false; reason: "insufficient" | "unreadable" | "missing" };

/**
 * Buys one shop entry.
 *
 * There is deliberately no transaction here, and the reasoning is worth keeping
 * because the instinct to add one is strong and was acted on before being
 * checked.
 *
 * It would not protect against two concurrent clicks: `bun:sqlite` is
 * synchronous and this process single-threaded, so nothing can interleave
 * between the read and the write. (The rate limiter's synchronous claim exists
 * for a genuinely different reason — it awaits.) And it would not protect
 * against a throw from the caller-supplied `applyToState`, because that runs
 * before any write happens, so there is nothing yet to roll back. The state and
 * the spent counter move in a single UPDATE, which SQLite already applies
 * atomically.
 *
 * Wrapping it changed no observable behaviour and no test could fail on its
 * removal, which is the definition of decoration — and decoration around money
 * is worse than none, because it invites the belief that something is being
 * guarded. Add one the day a purchase needs a second write.
 *
 * Growth is never rewound. A purchase raises `tokens_spent` only, so no
 * evolution is ever undone by shopping.
 */
export function purchase(
  storage: PluginStorage,
  apiKeyId: string,
  entry: ShopEntry,
  applyToState: (state: CompanionState) => CompanionState,
  now: number,
): PurchaseResult {
  const price = shopPrice(entry);

  {
    const row = readCompanion(storage, apiKeyId);
    if (row === null) return { ok: false, reason: "missing" };
    // A save that will not parse cannot be spent against: the balance is
    // readable but the state a purchase mutates is not, and writing a fresh one
    // over it would destroy what could not be read.
    if (row.state === null) return { ok: false, reason: "unreadable" };
    if (wallet(row) < price) return { ok: false, reason: "insufficient" };

    const nextState = applyToState(row.state);
    storage.run(
      "UPDATE {{companion}} SET state = ?, tokens_spent = tokens_spent + ?, updated_at = ? WHERE api_key_id = ?",
      [serialiseState(nextState), price, now, apiKeyId],
    );
    return {
      ok: true,
      row: { ...row, state: nextState, tokensSpent: row.tokensSpent + price },
    };
  }
}
