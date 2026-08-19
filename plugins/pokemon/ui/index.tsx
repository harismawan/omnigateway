import { definePluginUI, type PluginUiProps } from "@omni/dashboard-sdk";
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
  dex: Array<{
    id: string;
    baseId: number;
    finalId: number;
    rarity: Rarity;
    isShiny: boolean;
    caughtAt: number;
  }>;
  shop: Array<{ entry: ShopEntry; price: number }>;
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

function spriteUrl(pluginId: string, speciesId: number, shiny: boolean): string {
  return `/api/plugins/${pluginId}/sprite/${speciesId}${shiny ? "?shiny=1" : ""}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value.toLocaleString();
}

function shopLabel(entry: ShopEntry): string {
  if (entry.kind === "item") return entry.item.replace(/([A-Z])/g, " $1").toLowerCase();
  return entry.tier === null ? "fresh egg" : `fresh egg (${entry.tier}+)`;
}

function Companion({ pluginId, api }: PluginUiProps) {
  const [keyId, setKeyId] = useState("");
  const client = useQueryClient();

  const companion = useQuery({
    queryKey: ["companion", keyId],
    queryFn: () => api.get<CompanionView>(`keys/${keyId}`),
    enabled: keyId !== "",
  });

  const buy = useMutation({
    mutationFn: (entry: ShopEntry) => api.post(`keys/${keyId}/purchase`, entry),
    onSuccess: () => client.invalidateQueries({ queryKey: ["companion", keyId] }),
  });

  if (keyId === "") {
    return (
      <Panel>
        <h2>Companion</h2>
        <p>
          <Dim>Each API key raises its own Pokémon. Enter a key id to see it.</Dim>
        </p>
        <input
          aria-label="API key id"
          onChange={(event) => setKeyId(event.target.value)}
          placeholder="key id"
        />
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

  return (
    <Panel>
      <h2>Companion</h2>
      <Row>
        {species === undefined || species === null ? (
          <Sprite alt="An egg, not yet hatched" src={`/api/plugins/${pluginId}/sprite/egg`} />
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
              <Dim>{formatTokens(view.state.eggUsage)} tokens incubated</Dim>
            </>
          ) : (
            <>
              <div>
                Stage {active.stageIndex + 1} of {active.plannedPath.length} · {active.rarity}
                {active.isShiny ? " · shiny" : ""}
                {active.dittoDisguise === null ? "" : " · ?"}
              </div>
              <Dim>{active.nature}</Dim>
              <Meter>
                <Fill $pct={(active.usedAtStage / Math.max(1, active.usedAtStage + 1)) * 100} />
              </Meter>
            </>
          )}
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

      <h3>Pokédex</h3>
      {view.dex.length === 0 ? (
        <Dim>Nothing graduated yet.</Dim>
      ) : (
        <Grid>
          {view.dex.map((entry) => (
            <img
              alt={`${entry.rarity}${entry.isShiny ? " shiny" : ""} species ${entry.finalId}`}
              key={entry.id}
              src={spriteUrl(pluginId, entry.finalId, entry.isShiny)}
              style={{ width: "64px", height: "64px", imageRendering: "pixelated" }}
            />
          ))}
        </Grid>
      )}
    </Panel>
  );
}

export default definePluginUI({ mount: Companion });
