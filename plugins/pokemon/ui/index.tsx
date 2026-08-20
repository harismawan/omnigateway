import { definePluginUI, type PluginUiProps } from "@omnigateway/dashboard-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import styled from "styled-components";

/**
 * The companion panel.
 *
 * Styled entirely with the console's CSS custom properties rather than an
 * imported token object. They are the real contract: the light and dark palettes
 * swap underneath without this component re-rendering, and a plugin that hard-
 * coded a hex would be the one thing on the page that did not follow the theme.
 */

type Rarity = "common" | "uncommon" | "rare" | "legendary";

type CompanionView = {
  state: {
    active: {
      plannedPath: number[];
      stageIndex: number;
      usedAtStage: number;
      rarity: Rarity;
      isShiny: boolean;
      nature: string;
      dittoDisguise: number | null;
    } | null;
    eggUsage: number;
    eggTier: Rarity | null;
    inventory: Record<string, number>;
  } | null;
  tokensTotal: number;
  wallet: number;
  /**
   * When this key last earned, or null for a save that predates the column.
   *
   * Distinct from anything derived from `updated_at`: a purchase moves that and
   * not this, which is the whole reason the column exists.
   */
  lastCreditAt: number | null;
  dex: Array<{
    id: string;
    baseId: number;
    finalId: number;
    /** The full evolution line, as `readDex` returns it. */
    chainOrder: number[];
    rarity: Rarity;
    isShiny: boolean;
    /** Null for a graduation recorded before natures were stored. */
    nature: string | null;
    caughtAt: number;
  }>;
  shop: Array<{ entry: ShopEntry; price: number }>;
  /** What the current stage or incubation costs. */
  nextThreshold: number;
  /** How far into it this companion is. */
  progress: number;
};

type ShopEntry = { kind: "item"; item: string } | { kind: "egg"; tier: Rarity | null };

const Panel = styled.section`
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 16px;
  color: var(--ink);
`;

const Row = styled.div`
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
`;

const Sprite = styled.img`
  width: 96px;
  height: 96px;
  image-rendering: pixelated;
  background: var(--panel-sunk);
  border-radius: 4px;
`;

const Meter = styled.div`
  background: var(--panel-sunk);
  border-radius: 3px;
  height: 8px;
  overflow: hidden;
  min-width: 200px;
`;

/**
 * Colour carries state here and nothing else, which is the console's rule.
 * Rarity is a state of the thing being shown, not decoration.
 */
const Fill = styled.div<{ $pct: number }>`
  background: var(--accent);
  height: 100%;
  width: ${(p) => Math.min(100, Math.max(0, p.$pct))}%;
`;

const Dim = styled.span`
  color: var(--ink-dim);
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
  margin-top: 12px;
`;

const Button = styled.button`
  background: var(--panel-raised);
  border: 1px solid var(--rule);
  border-radius: 4px;
  color: var(--ink);
  padding: 6px 10px;
  cursor: pointer;
  &:disabled {
    color: var(--ink-faint);
    cursor: not-allowed;
  }
`;

const Notice = styled.p`
  color: var(--warn);
`;

/** One Dex cell: the sprite plus what the sprite alone cannot say. */
const Cell = styled.figure`
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
`;

const Caption = styled.figcaption`
  color: var(--ink-dim);
  font-size: 11px;
  text-align: center;
`;

/** One bag entry: what is held, how many, and what can be done with it. */
const BagItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

/** An egg, drawn rather than fetched — there is no sprite for one. */
const EggMark = styled.div`
  width: 96px;
  height: 96px;
  border-radius: 50% 50% 45% 45%;
  background: var(--panel-raised);
  border: 2px solid var(--rule-strong);
`;

function spriteUrl(pluginId: string, speciesId: number, shiny: boolean): string {
  return `/api/plugins/${pluginId}/sprite/${speciesId}${shiny ? "?shiny=1" : ""}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value.toLocaleString();
}

/**
 * A stored item name as a person reads it: `rareCandy` becomes "rare candy".
 *
 * Split out of `shopLabel` rather than copied into the bag. The two surfaces
 * name the same things, and two derivations of one label is how "rare candy" in
 * the shop ends up next to "rareCandy" in the bag.
 */
function itemLabel(item: string): string {
  return item.replace(/([A-Z])/g, " $1").toLowerCase();
}

function shopLabel(entry: ShopEntry): string {
  if (entry.kind === "item") return itemLabel(entry.item);
  return entry.tier === null ? "fresh egg" : `fresh egg (${entry.tier}+)`;
}

/**
 * Items the `use` route will accept.
 *
 * A mirror of `parseHeldItem`'s allowlist on the server, and deliberately a
 * mirror rather than a fetched fact: `shinyCharm` is passive, so posting it is a
 * 400 and offering the button would be offering a guaranteed error. The server
 * stays the enforcement — this only keeps the panel from asking.
 */
const CONSUMABLE_ITEMS: readonly string[] = ["rareCandy", "mint"];

/** Rarity filters, with `null` meaning no filter at all. */
const RARITY_FILTERS: ReadonlyArray<Rarity | null> = [
  null,
  "common",
  "uncommon",
  "rare",
  "legendary",
];

/**
 * How the sprite is behaving, from how long ago this key last earned.
 *
 * Five states, not the spec's six. `focus` is **absent on purpose**: it would
 * have to mean a burst of recent requests, and the plugin stores one instant per
 * key rather than any per-request history, so there is nothing here that could
 * tell a burst from a trickle. A state that never fires is dead code and one
 * that fires arbitrarily is a lie about the key's traffic; either is worse than
 * five honest ones. It arrives the day something records request times.
 */
type Activity = "egg" | "working" | "idle" | "tired" | "sleep";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function activityOf(hasActive: boolean, lastCreditAt: number | null, now: number): Activity {
  if (!hasActive) return "egg";
  // Null is "never observed earning", which reads as asleep rather than as
  // busy. A save from before the column existed lands here, and so does a key
  // that has only ever been shopped at.
  if (lastCreditAt === null) return "sleep";
  const elapsed = now - lastCreditAt;
  if (elapsed < 5 * MINUTE_MS) return "working";
  if (elapsed < HOUR_MS) return "idle";
  if (elapsed < 8 * HOUR_MS) return "tired";
  return "sleep";
}

function Companion({ pluginId, api }: PluginUiProps) {
  // Two states, not one. The field has to keep what is being typed, and the
  // panel has to keep what was asked for, because the moment those are the same
  // value the first keystroke commits: the field is replaced by a lookup of a
  // one-character key id and the rest of the id has nowhere to go. Committing on
  // submit also means one request per key rather than one per keystroke.
  const [draft, setDraft] = useState("");
  const [keyId, setKeyId] = useState("");
  const [rarityFilter, setRarityFilter] = useState<Rarity | null>(null);
  const client = useQueryClient();

  const companion = useQuery({
    queryKey: ["companion", keyId],
    queryFn: () => api.get<CompanionView>(`keys/${keyId}`),
    enabled: keyId !== "",
  });

  // A money surface that fails silently is worse than one that fails loudly.
  // A 409 carries the reason — insufficient, unreadable, missing — and the
  // operator gets it rather than a panel that refetches and looks unchanged.
  const [refusal, setRefusal] = useState<string | null>(null);
  const buy = useMutation({
    mutationFn: (entry: ShopEntry) => api.post(`keys/${keyId}/purchase`, entry),
    onMutate: () => setRefusal(null),
    onError: (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : "the purchase was refused"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["companion", keyId] }),
  });

  // The other half of a grant, and the reason the bag exists at all: the `use`
  // route was written so a granted candy could be spent, and until this
  // mutation nothing in the console ever called it. Same shape as `buy` on
  // purpose — one refusal surface, one invalidation.
  const use = useMutation({
    mutationFn: (item: string) => api.post(`keys/${keyId}/use`, { item }),
    onMutate: () => setRefusal(null),
    onError: (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : "the item could not be used"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["companion", keyId] }),
  });

  if (keyId === "") {
    return (
      <Panel>
        <h2>Companion</h2>
        <p>
          <Dim>Each API key raises its own Pokémon. Enter a key id to see it.</Dim>
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setKeyId(draft.trim());
          }}
        >
          <input
            aria-label="API key id"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="key id"
            value={draft}
          />
          <Button type="submit">Show</Button>
        </form>
      </Panel>
    );
  }

  if (companion.isPending) return <Panel>Loading…</Panel>;
  if (companion.isError) return <Panel>No companion for that key yet.</Panel>;

  const view = companion.data;

  // Null and "no companion yet" are different facts, and the host is careful to
  // keep them apart — so this must too. A save that cannot be read is a reason
  // to look at the database, not a reason to start again.
  if (view.state === null) {
    return (
      <Panel>
        <h2>Companion</h2>
        <Notice>
          This key's save could not be read. It has been left untouched rather than replaced —
          nothing has been lost, but it needs looking at.
        </Notice>
      </Panel>
    );
  }

  const { active } = view.state;
  const species = active === null ? null : active.plannedPath[active.stageIndex];
  // Read at render rather than held in state: the panel repaints on every
  // refetch, and a clock kept in state would need a timer whose only job is to
  // make the word "idle" appear a few seconds earlier.
  const activity = activityOf(active !== null, view.lastCreditAt, Date.now());

  // Zero-count entries are not held, so they are not shown — a bag listing
  // something it does not contain is the same lie in the other direction.
  const held = Object.entries(view.state.inventory).filter(([, count]) => count > 0);

  const dex = rarityFilter === null ? view.dex : view.dex.filter((e) => e.rarity === rarityFilter);

  return (
    <Panel>
      <h2>Companion</h2>
      <Row>
        {/*
          An egg is drawn, never fetched. The sprite route parses its parameter
          as an integer, so the old `/sprite/egg` was a guaranteed 400 and a
          broken-image icon on every unhatched companion.
        */}
        {species === undefined || species === null ? (
          <EggMark aria-label="An egg, not yet hatched" role="img" />
        ) : (
          <Sprite
            alt={`Species ${species}${active?.isShiny === true ? ", shiny" : ""}`}
            src={spriteUrl(pluginId, species, active?.isShiny === true)}
          />
        )}
        <div>
          {active === null ? (
            <>
              <div>
                Egg{view.state.eggTier === null ? "" : ` (${view.state.eggTier}+ guaranteed)`}
              </div>
              <Dim>
                {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} tokens incubated
              </Dim>
              <Meter aria-label="Incubation">
                <Fill $pct={(view.progress / Math.max(1, view.nextThreshold)) * 100} />
              </Meter>
            </>
          ) : (
            <>
              <div>
                Stage {active.stageIndex + 1} of {active.plannedPath.length} · {active.rarity}
                {active.isShiny ? " · shiny" : ""}
                {active.dittoDisguise === null ? "" : " · ?"}
              </div>
              <Dim>{active.nature}</Dim>
              <Meter aria-label="Growth to the next evolution">
                <Fill $pct={(view.progress / Math.max(1, view.nextThreshold)) * 100} />
              </Meter>
              <Dim>
                {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} to the next stage
              </Dim>
            </>
          )}
          {/*
            Text, not a tint. The console's rule is that colour means provider
            identity or state, and even where a state may be coloured it may not
            be the *only* way the state is legible.
          */}
          <div aria-label={`Activity: ${activity}`} role="status">
            {activity}
          </div>
        </div>
      </Row>

      <p>
        <Dim>
          {formatTokens(view.tokensTotal)} tokens earned · {formatTokens(view.wallet)} to spend
        </Dim>
      </p>

      <h3>Shop</h3>
      <Row>
        {view.shop.map((offer) => (
          <Button
            disabled={view.wallet < offer.price || buy.isPending}
            key={`${offer.entry.kind}:${shopLabel(offer.entry)}`}
            onClick={() => buy.mutate(offer.entry)}
            type="button"
          >
            {shopLabel(offer.entry)} · {formatTokens(offer.price)}
          </Button>
        ))}
      </Row>

      <h3>Bag</h3>
      {held.length === 0 ? (
        <Dim>Nothing in the bag.</Dim>
      ) : (
        <Row>
          {held.map(([item, count]) => (
            <BagItem key={item}>
              <span>
                {itemLabel(item)} · {count}
              </span>
              {CONSUMABLE_ITEMS.includes(item) ? (
                <Button disabled={use.isPending} onClick={() => use.mutate(item)} type="button">
                  Use {itemLabel(item)}
                </Button>
              ) : (
                // No button, and not a disabled one either: a disabled button
                // says "not right now", and this is never spendable at all.
                <Dim>held</Dim>
              )}
            </BagItem>
          ))}
        </Row>
      )}

      {refusal === null ? null : <Notice role="alert">{refusal}</Notice>}

      <h3>Pokédex</h3>
      {view.dex.length === 0 ? (
        <Dim>Nothing graduated yet.</Dim>
      ) : (
        <>
          <Row>
            {RARITY_FILTERS.map((rarity) => (
              // Pressed, not disabled. Disabling the active filter takes the
              // one control that says which filter is active out of the tab
              // order, and `aria-pressed` already says it — to a screen reader
              // as well as to the eye.
              <Button
                aria-pressed={rarityFilter === rarity}
                key={rarity ?? "all"}
                onClick={() => setRarityFilter(rarity)}
                type="button"
              >
                {rarity ?? "all"}
              </Button>
            ))}
          </Row>
          {dex.length === 0 ? (
            // Not "Nothing graduated yet." A filter that hides everything and an
            // empty collection are different facts, and showing the second in
            // place of the first reads as a bug in the filter.
            <Dim>No {rarityFilter} graduates yet.</Dim>
          ) : (
            <Grid>
              {dex.map((entry) => (
                <Cell key={entry.id}>
                  <img
                    alt={`${entry.rarity}${entry.isShiny ? " shiny" : ""} species ${entry.finalId}`}
                    src={spriteUrl(pluginId, entry.finalId, entry.isShiny)}
                    style={{ width: "64px", height: "64px", imageRendering: "pixelated" }}
                  />
                  {/*
                    Nature is captioned rather than folded into the sprite's alt
                    text: the alt text names the thing, and a nullable field
                    inside an accessible name makes the name of an old entry
                    differ from the name of a new one for no reason a reader
                    could guess.
                  */}
                  {entry.nature === null ? null : <Caption>{entry.nature}</Caption>}
                </Cell>
              ))}
            </Grid>
          )}
        </>
      )}
    </Panel>
  );
}

export default definePluginUI({ mount: Companion });
