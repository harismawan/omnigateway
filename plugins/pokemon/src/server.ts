// The `./define` subpath rather than the package root, deliberately. The root
// re-exports the manifest schema and with it zod, which a plugin never needs at
// runtime — importing it bundled half a megabyte of validator into every plugin
// that only wanted an identity function and some types.
import { definePlugin, type PluginContext, type PluginRoute } from "@omni/plugins/define";
import type { CompanionEvent } from "./advance.ts";
import {
  freshEggPrice,
  ITEM_KINDS,
  ITEM_PRICES,
  type ItemKind,
  RARE_CANDY_XP,
  rarityFromCaptureRate,
} from "./balance.ts";
import { decideGrant, windowKey } from "./grants.ts";
import { speciesDetail, speciesIndex, spriteBytes } from "./pokeapi.ts";
import { roll } from "./roll.ts";
import type { CompanionState } from "./state.ts";
import { hasShinyCharm } from "./state.ts";
import {
  creditTokens,
  grantedTier,
  MIGRATIONS,
  purchase,
  readCompanion,
  readDex,
  recordGraduation,
  type ShopEntry,
  setGrantedTier,
  settle,
  wallet,
} from "./store.ts";

/**
 * How much of a request's tokens count toward growth.
 *
 * Operator-tunable, because the balance was tuned against one laptop and a
 * gateway fronting several clients moves that in an afternoon. Applied at credit
 * time and never retroactively, so changing it never rewrites history or
 * de-evolves anything.
 */
function multiplierFrom(config: Readonly<Record<string, unknown>>): number {
  const raw = config.multiplier;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

/** A stable id for a Dex row, from the facts of the graduation rather than a clock. */
function dexId(apiKeyId: string, event: Extract<CompanionEvent, { kind: "graduated" }>): string {
  return `${apiKeyId}:${event.baseId}:${event.finalId}:${event.isShiny ? "s" : "n"}:${Date.now()}`;
}

export default definePlugin({
  migrations: MIGRATIONS,

  setup(ctx: PluginContext) {
    const storage = ctx.storage;
    const events = ctx.events;
    const net = ctx.net;
    const files = ctx.files;
    // Declared in the manifest, so their absence is a broken install rather than
    // a supported configuration. Failing here is reported by the loader and
    // skips this plugin, which is the right outcome: a companion with no storage
    // is not a degraded companion, it is none.
    if (storage === undefined) throw new Error("the companion needs the storage capability");

    const multiplier = multiplierFrom(ctx.config);

    /**
     * Applies whatever the credited total has earned, and writes any graduation
     * into the Dex.
     *
     * Called on read as well as after a credit. `settle` is idempotent, so the
     * repetition costs a comparison rather than a second helping of growth.
     */
    const settleAndRecord = (apiKeyId: string): void => {
      const result = settle(storage, apiKeyId, ctx.now());
      if (result === null) return;
      for (const event of result.events) {
        if (event.kind !== "graduated") continue;
        recordGraduation(
          storage,
          apiKeyId,
          {
            baseId: event.baseId,
            finalId: event.finalId,
            chainOrder: [event.baseId, event.finalId],
            rarity: event.rarity,
            isShiny: event.isShiny,
            nature: null,
            caughtAt: ctx.now(),
          },
          dexId(apiKeyId, event),
        );
        ctx.logger.info("companion graduated", { event: "companion.graduated", count: 1 });
      }
    };

    /**
     * Rolls the next species for an egg that has none.
     *
     * Prefetched while the egg is still incubating, so the hatch itself needs no
     * network. Everything here is best effort: with no index yet the egg simply
     * keeps its progress and tries again later.
     */
    const prefetchHatch = async (apiKeyId: string, state: CompanionState): Promise<void> => {
      if (state.active !== null || state.pendingHatch !== null) return;
      if (net === undefined || files === undefined) return;

      const candidates = await speciesIndex({ net, files });
      if (candidates.length === 0) return;

      const collected = new Set(readDex(storage, apiKeyId).map((entry) => entry.finalId));
      const rolled = roll({
        candidates,
        // Seeded from facts rather than from a clock, so a retried prefetch
        // produces the same Pokémon instead of rerolling until it likes one.
        seed: hashSeed(`${apiKeyId}:${state.consumedTotal}`),
        guarantee: state.eggTier,
        hasShinyCharm: hasShinyCharm(state),
        collectedFinals: collected,
      });
      if (rolled === null) return;

      const detail = await speciesDetail({ net, files }, rolled.speciesId);
      const path = detail?.chain ?? [rolled.speciesId];
      // Derived here rather than at roll time, and that is what lets a legendary
      // ever be hatched. The candidate index carries capture rates only, so the
      // roll cannot see the legendary flags — the detail can, so a legendary
      // that came through the rare band is recorded as legendary and costs a
      // legendary's graduation rather than a rare's.
      const rarity =
        detail === null
          ? "common"
          : rarityFromCaptureRate(detail.captureRate, detail.isLegendary, detail.isMythical);

      const current = readCompanion(storage, apiKeyId);
      // Re-read rather than trusting the state this started from: an await
      // happened in between, and a credit may have landed.
      if (current?.state == null || current.state.pendingHatch !== null) return;

      storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
        JSON.stringify({
          ...current.state,
          pendingHatch: {
            speciesId: rolled.speciesId,
            path,
            rarity,
            isShiny: rolled.isShiny,
            nature: rolled.nature,
            ditto: rolled.ditto,
          },
        }),
        ctx.now(),
        apiKeyId,
      ]);
    };

    if (events?.onRequestCompleted !== undefined) {
      events.onRequestCompleted((event) => {
        const tokens =
          event.tokens.input +
          event.tokens.output +
          event.tokens.cacheRead +
          event.tokens.cacheWrite;
        creditTokens(storage, event.apiKeyId, Math.round(tokens * multiplier), ctx.now());
        settleAndRecord(event.apiKeyId);
      });
    }

    if (events?.onLimitReached !== undefined) {
      events.onLimitReached((event) => {
        const key = windowKey(event);
        const row = readCompanion(storage, event.apiKeyId);
        if (row?.state == null) return;

        const decision = decideGrant({
          window: event.window,
          grantedTier: grantedTier(storage, event.apiKeyId, key),
          seeded: row.state.grantSeeded,
        });

        if (!decision.grant) {
          if (decision.seedTo !== undefined) {
            setGrantedTier(storage, event.apiKeyId, key, decision.seedTo);
            storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
              JSON.stringify({ ...row.state, grantSeeded: true }),
              event.apiKeyId,
            ]);
          }
          return;
        }

        setGrantedTier(storage, event.apiKeyId, key, decision.tier);
        storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
          JSON.stringify({
            ...row.state,
            inventory: {
              ...row.state.inventory,
              rareCandy: row.state.inventory.rareCandy + decision.count,
            },
          }),
          event.apiKeyId,
        ]);
        ctx.logger.info("companion candy granted", {
          event: "companion.candy",
          count: decision.count,
        });
      });
    }

    const routes: PluginRoute[] = [
      {
        method: "GET",
        path: "/keys/:id",
        handler: (request) => {
          const apiKeyId = request.params.id ?? "";
          settleAndRecord(apiKeyId);
          const row = readCompanion(storage, apiKeyId);
          if (row === null) return { status: 404, json: { error: "no companion for that key" } };

          // Best effort and deliberately not awaited: a prefetch is an
          // optimisation for the next hatch, and the panel should render now.
          if (row.state !== null) void prefetchHatch(apiKeyId, row.state).catch(() => {});

          return {
            json: {
              // Null rather than a fresh companion, so "cannot be read" and "has
              // not started" stay distinguishable in the UI.
              state: row.state,
              tokensTotal: row.tokensTotal,
              wallet: wallet(row),
              dex: readDex(storage, apiKeyId),
              shop: shopCatalogue(),
            },
          };
        },
      },
      {
        method: "GET",
        path: "/sprite/:species",
        handler: async (request) => {
          // The one route that answers with bytes. Ids are parsed as integers
          // here and validated again inside `spriteBytes`, so nothing a caller
          // types reaches a URL or a cache path.
          const raw = request.params.species ?? "";
          const speciesId = Number.parseInt(raw, 10);
          if (!Number.isInteger(speciesId)) return { status: 400, json: { error: "bad species" } };
          if (net === undefined || files === undefined) {
            return { status: 503, json: { error: "sprites need the net and files capabilities" } };
          }

          const shiny = request.query.shiny === "1";
          const bytes = await spriteBytes({ net, files }, speciesId, shiny);
          // A miss is ordinary — offline, or simply not fetched yet — so this is
          // a 404 the panel renders as a placeholder rather than an error state.
          if (bytes === null) return { status: 404, json: { error: "no sprite" } };
          return {
            bytes,
            contentType: "image/gif",
            // Sprites never change. This is the one thing in the plugin worth
            // caching hard, and it is why the panel stays responsive offline.
            cacheControl: "public, max-age=31536000, immutable",
          };
        },
      },
      {
        method: "POST",
        path: "/keys/:id/purchase",
        handler: (request) => {
          const apiKeyId = request.params.id ?? "";
          const entry = parseShopEntry(request.body);
          if (entry === null) return { status: 400, json: { error: "unknown shop entry" } };

          const result = purchase(
            storage,
            apiKeyId,
            entry,
            (state) => applyPurchase(state, entry),
            ctx.now(),
          );
          if (!result.ok) return { status: 409, json: { error: result.reason } };
          return { json: { ok: true, wallet: wallet(result.row) } };
        },
      },
    ];

    return { routes };
  },
});

/** A deterministic 32-bit seed from a string, so a retried roll is the same roll. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shopCatalogue(): Array<{ entry: ShopEntry; price: number }> {
  return [
    ...ITEM_KINDS.map((item) => ({
      entry: { kind: "item" as const, item },
      price: ITEM_PRICES[item],
    })),
    { entry: { kind: "egg" as const, tier: null }, price: freshEggPrice(null) },
    {
      entry: { kind: "egg" as const, tier: "uncommon" as const },
      price: freshEggPrice("uncommon"),
    },
    { entry: { kind: "egg" as const, tier: "rare" as const }, price: freshEggPrice("rare") },
  ];
}

function parseShopEntry(body: unknown): ShopEntry | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.kind === "item") {
    const item = record.item;
    return ITEM_KINDS.includes(item as ItemKind) ? { kind: "item", item: item as ItemKind } : null;
  }
  if (record.kind === "egg") {
    const tier = record.tier;
    if (tier === null || tier === undefined) return { kind: "egg", tier: null };
    // `legendary` is refused here as well as by the price function: an unknown
    // tier must not become "no guarantee" and quietly sell a cheap egg.
    if (tier === "uncommon" || tier === "rare") return { kind: "egg", tier };
    return null;
  }
  return null;
}

/**
 * What owning the thing does.
 *
 * A fresh egg discards the current Pokémon outright — it is a reroll, and the
 * discarded one is not a graduation, so it never reaches the Dex. That is what
 * keeps rerolling from being a way to farm the collection.
 */
function applyPurchase(state: CompanionState, entry: ShopEntry): CompanionState {
  if (entry.kind === "egg") {
    return { ...state, active: null, eggUsage: 0, eggTier: entry.tier, pendingHatch: null };
  }
  if (entry.item === "rareCandy") {
    // Injected as growth through the same path everything else uses, so a candy
    // can carry a stage and evolve exactly as earned tokens would.
    return state.active === null
      ? { ...state, eggUsage: state.eggUsage + RARE_CANDY_XP }
      : {
          ...state,
          active: { ...state.active, usedAtStage: state.active.usedAtStage + RARE_CANDY_XP },
        };
  }
  return {
    ...state,
    inventory: { ...state.inventory, [entry.item]: (state.inventory[entry.item] ?? 0) + 1 },
  };
}
