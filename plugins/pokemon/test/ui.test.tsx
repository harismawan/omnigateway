/**
 * The companion panel, rendered.
 *
 * Run by `bun run test:plugins`, not by the root suite — `bunfig.toml` excludes
 * it there. The reason is the DOM: registering one mutates process-wide globals,
 * so a file that registers its own inside the shared root run leaks a document
 * into ~2400 gateway, store and router tests that never asked for one. That is
 * not theoretical; it surfaced as a one-in-several-runs failure before the
 * preload existed. The console's suite is separated for exactly this reason and
 * this follows it.
 *
 * The harness is a local minimum rather than `apps/dashboard/test/helpers`.
 * `renderWithProviders` pulls in the console's `ThemeProvider` and
 * `LiveProvider` from `apps/dashboard/src`, and a plugin may not import an app.
 * What is copied is the *idiom*: a route table over `fetch` that answers a
 * missing route with a loud 501 rather than a hanging socket, and assertions on
 * visible text and accessible names. The API reaches the component through the
 * real `createPluginApi`, so URL construction is exercised too.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createPluginApi } from "@omnigateway/dashboard-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import companionUi, { activityOf } from "../ui/index.tsx";

const Companion = companionUi.mount;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* the harness                                                                 */
/* -------------------------------------------------------------------------- */

type StubResponse = { status?: number; body?: unknown };

type StubHandler = (input: { url: string; body: string | undefined }) => StubResponse;

type FetchStub = {
  calls: Array<{ method: string; url: string; body: string | undefined }>;
};

function stubFetch(routes: Record<string, StubHandler>): FetchStub {
  const table = new Map(Object.entries(routes));
  const calls: FetchStub["calls"] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body });

    const handler = table.get(`${method} ${url}`);
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: `no stub for ${method} ${url}` } }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }

    const result = handler({ url, body });
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { calls };
}

/**
 * Mount the panel the way the host does: `mount` called in render position with
 * the two props the SDK promises, and nothing else in scope.
 */
function renderCompanion(routes: Record<string, StubHandler>): FetchStub {
  const stub = stubFetch(routes);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Companion api={createPluginApi("pokemon")} pluginId="pokemon" />
    </QueryClientProvider>,
  );
  return stub;
}

/** Type a key id into the selector and ask for it, as an operator would. */
async function lookUp(keyId: string): Promise<void> {
  await userEvent.type(await screen.findByRole("textbox", { name: "API key id" }), keyId);
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

type Rarity = "common" | "uncommon" | "rare" | "legendary";

type Active = {
  plannedPath: number[];
  stageIndex: number;
  usedAtStage: number;
  rarity: Rarity;
  isShiny: boolean;
  nature: string;
  dittoDisguise: number | null;
};

type CompanionState = {
  active: Active | null;
  eggUsage: number;
  eggTier: Rarity | null;
  inventory: Record<string, number>;
};

type ShopEntry = { kind: "item"; item: string } | { kind: "egg"; tier: Rarity | null };

/** Mirrors what `GET /keys/:id` actually sends, field for field. */
type DexEntry = {
  id: string;
  baseId: number;
  finalId: number;
  chainOrder: number[];
  rarity: Rarity;
  isShiny: boolean;
  nature: string | null;
  caughtAt: number;
};

type CompanionView = {
  state: CompanionState | null;
  tokensTotal: number;
  wallet: number;
  lastCreditAt: number | null;
  dex: DexEntry[];
  shop: Array<{ entry: ShopEntry; price: number }>;
  nextThreshold: number;
  progress: number;
};

function active(patch: Partial<Active> = {}): Active {
  return {
    plannedPath: [172, 25, 26],
    stageIndex: 1,
    usedAtStage: 4_000,
    rarity: "rare",
    isShiny: false,
    nature: "brave",
    dittoDisguise: null,
    ...patch,
  };
}

function dexEntry(patch: Partial<DexEntry> = {}): DexEntry {
  return {
    id: "d0",
    baseId: 10,
    finalId: 12,
    chainOrder: [10, 11, 12],
    rarity: "common",
    isShiny: false,
    nature: "timid",
    // Distinct from every id and species number in the fixture, so a cell that
    // renders the wrong field is visible rather than coincidentally right.
    caughtAt: 1_700_000_000_777,
    ...patch,
  };
}

function view(patch: Partial<CompanionView> = {}): CompanionView {
  return {
    state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
    tokensTotal: 0,
    wallet: 0,
    // Null rather than an instant: the default fixture has no active companion,
    // and a companion is what an activity state describes.
    lastCreditAt: null,
    dex: [],
    shop: [],
    // Distinct from every other number in the fixture, so a component that
    // renders the wrong one is visible rather than coincidentally right.
    nextThreshold: 5_000_000,
    progress: 1_240_000,
    ...patch,
  };
}

const KEY = "key_7f3a";
const GET_KEY = `GET /api/plugins/pokemon/keys/${KEY}`;
const POST_PURCHASE = `POST /api/plugins/pokemon/keys/${KEY}/purchase`;
const POST_USE = `POST /api/plugins/pokemon/keys/${KEY}/use`;

/** The whole panel for one key, served from a single fixture. */
function serving(body: CompanionView): Record<string, StubHandler> {
  return { [GET_KEY]: () => ({ body }) };
}

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("the key selector", () => {
  test("asks for a key before it asks the gateway for anything", async () => {
    const stub = renderCompanion(serving(view()));

    expect(await screen.findByRole("textbox", { name: "API key id" })).toBeTruthy();
    expect(screen.getByText(/Each API key raises its own Pokémon/)).toBeTruthy();
    expect(stub.calls).toEqual([]);
  });

  test("keeps the field usable for a key id longer than one character", async () => {
    // The regression this guards: the field committed on every keystroke, so the
    // first character replaced the field with a lookup of a one-character key
    // and the id could never be finished. Typing the whole id is the only way to
    // see it — a single `change` event with the final value passes either way.
    const stub = renderCompanion(serving(view({ tokensTotal: 12 })));
    await lookUp(KEY);

    expect(await screen.findByRole("heading", { name: "Companion" })).toBeTruthy();
    expect(stub.calls.map((call) => call.url)).toEqual([`/api/plugins/pokemon/keys/${KEY}`]);
  });
});

describe("a save that could not be read", () => {
  test("says so, and does not offer a fresh egg in its place", async () => {
    // The most load-bearing test in the file. "Unreadable" and "not started yet"
    // are different facts all the way down the plugin, and this panel is the last
    // place the distinction can be lost — silently, and in the direction that
    // tells an operator everything is fine.
    renderCompanion(serving(view({ state: null, tokensTotal: 900_000, wallet: 40 })));
    await lookUp(KEY);

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/left untouched rather than replaced/)).toBeTruthy();

    // Nothing that would read as a companion that simply has not hatched.
    expect(screen.queryByRole("img", { name: "An egg, not yet hatched" })).toBeNull();
    expect(screen.queryByText(/tokens incubated/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Shop" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Pokédex" })).toBeNull();
  });
});

describe("an egg", () => {
  test("renders as an egg with the tokens incubated so far", async () => {
    // Every number here is distinct on purpose. Incubated, earned and spendable
    // are three different quantities the panel reads from three different
    // fields, and a fixture that gives them one value passes whichever two the
    // component confuses.
    renderCompanion(
      serving(
        view({
          // `eggUsage` and `progress` are deliberately different. The panel reads
          // the server-computed `progress`, and with both set to the same number
          // a component that read the wrong one would look correct.
          state: { active: null, eggUsage: 7_777_777, eggTier: null, inventory: {} },
          progress: 1_240_000,
          nextThreshold: 5_000_000,
          tokensTotal: 9_000_000,
          wallet: 2_500,
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "An egg, not yet hatched" })).toBeTruthy();
    expect(screen.getByText("1.2M / 5.0M tokens incubated")).toBeTruthy();
    expect(screen.getByText("9.0M tokens earned · 2,500 to spend")).toBeTruthy();
    expect(screen.getByText("Egg")).toBeTruthy();
  });

  test("names the tier a guaranteed egg was bought at", async () => {
    renderCompanion(
      serving(view({ state: { active: null, eggUsage: 0, eggTier: "rare", inventory: {} } })),
    );
    await lookUp(KEY);

    expect(await screen.findByText("Egg (rare+ guaranteed)")).toBeTruthy();
  });
});

describe("an active companion", () => {
  test("shows its stage, its rarity and a sprite that names the species", async () => {
    renderCompanion(
      serving(
        view({
          state: {
            active: active(),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await lookUp(KEY);

    // The sprite is the current stage of the planned path, not its first or last.
    const sprite = await screen.findByRole("img", { name: "Species 25" });
    expect(sprite.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/25");

    expect(screen.getByText("Stage 2 of 3 · rare")).toBeTruthy();
    expect(screen.getByText("brave")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "An egg, not yet hatched" })).toBeNull();
  });

  test("says a shiny is shiny, in the sprite's name as well as the line", async () => {
    renderCompanion(
      serving(
        view({
          state: {
            active: active({ isShiny: true }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await lookUp(KEY);

    const sprite = await screen.findByRole("img", { name: "Species 25, shiny" });
    expect(sprite.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/25?shiny=1");
    expect(screen.getByText("Stage 2 of 3 · rare · shiny")).toBeTruthy();
  });
});

describe("the shop", () => {
  const shop = [
    { entry: { kind: "item", item: "rareCandy" } as const, price: 100 },
    { entry: { kind: "egg", tier: "rare" } as const, price: 101 },
  ];

  test("disables an offer the wallet cannot afford and enables one it exactly can", async () => {
    renderCompanion(serving(view({ wallet: 100, shop })));
    await lookUp(KEY);

    // The label is derived, so the accessible name is the assertion: an operator
    // reads "rare candy", not the field name it was stored under.
    const affordable = await screen.findByRole("button", { name: "rare candy · 100" });
    const tooDear = screen.getByRole("button", { name: "fresh egg (rare+) · 101" });

    // Exactly affordable is affordable — the boundary, not a round number.
    expect((affordable as HTMLButtonElement).disabled).toBe(false);
    expect((tooDear as HTMLButtonElement).disabled).toBe(true);
  });

  test("posts the entry itself when an affordable offer is bought", async () => {
    const stub = renderCompanion({
      ...serving(view({ wallet: 100, shop })),
      [POST_PURCHASE]: () => ({ body: {} }),
    });
    await lookUp(KEY);

    await userEvent.click(await screen.findByRole("button", { name: "rare candy · 100" }));

    const posted = stub.calls.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`/api/plugins/pokemon/keys/${KEY}/purchase`);
    expect(JSON.parse(posted[0]?.body ?? "null")).toEqual({ kind: "item", item: "rareCandy" });
  });

  test("does not post when the offer the wallet cannot afford is clicked", async () => {
    const stub = renderCompanion({
      ...serving(view({ wallet: 100, shop })),
      [POST_PURCHASE]: () => ({ body: {} }),
    });
    await lookUp(KEY);

    await userEvent.click(await screen.findByRole("button", { name: "fresh egg (rare+) · 101" }));

    expect(stub.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("the Pokédex", () => {
  test("says it is empty rather than drawing an empty grid", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await lookUp(KEY);

    expect(await screen.findByText("Nothing graduated yet.")).toBeTruthy();
    // The egg is the only image on the panel: no stray cells, no placeholders.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("names each graduate by rarity, shininess and species", async () => {
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({
              id: "d1",
              baseId: 133,
              finalId: 134,
              chainOrder: [133, 134],
              rarity: "legendary",
              isShiny: true,
              nature: "modest",
            }),
            dexEntry({
              id: "d2",
              baseId: 1,
              finalId: 3,
              chainOrder: [1, 2, 3],
              rarity: "common",
              nature: "adamant",
            }),
          ],
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("Nothing graduated yet.")).toBeNull();
  });

  test("shows the nature the server records, which the sprite cannot say", async () => {
    // Two different natures, because one would pass against a component that
    // rendered the same entry twice.
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({ id: "d1", finalId: 134, nature: "modest" }),
            dexEntry({ id: "d2", finalId: 3, nature: "adamant" }),
          ],
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByText("modest")).toBeTruthy();
    expect(screen.getByText("adamant")).toBeTruthy();
  });

  test("omits the nature of an entry recorded before natures were stored", async () => {
    // Nullable in the store, so the cell has to survive it without printing
    // "null" under a sprite.
    renderCompanion(serving(view({ dex: [dexEntry({ id: "d1", finalId: 3, nature: null })] })));
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });
});

describe("the Dex rarity filter", () => {
  /** One of each rarity, each with a species number found nowhere else. */
  const mixed = [
    dexEntry({ id: "d1", finalId: 3, rarity: "common", nature: "adamant" }),
    dexEntry({ id: "d2", finalId: 26, rarity: "rare", nature: "brave" }),
    dexEntry({ id: "d3", finalId: 134, rarity: "legendary", isShiny: true, nature: "modest" }),
  ];

  test("shows every graduate until a rarity is chosen", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "rare species 26" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
  });

  test("filtering to common excludes uncommon, which contains the word", async () => {
    // The one pair of rarities that no other fixture holds at the same time, and
    // the reason this test exists: `"uncommon".includes("common")` is true, so a
    // predicate written with `includes` instead of `===` passes every other test
    // in this file — `mixed` has no uncommon entry, and nothing else ever filters
    // to `common`. That mutation survived a full run before this was added.
    //
    // Its own fixture rather than an entry appended to `mixed`, because the
    // filtered-empty test below depends on `uncommon` being absent from that one.
    const pair = [
      dexEntry({ id: "p1", finalId: 3, rarity: "common", nature: "adamant" }),
      dexEntry({ id: "p2", finalId: 12, rarity: "uncommon", nature: "timid" }),
    ];
    renderCompanion(serving(view({ dex: pair })));
    await lookUp(KEY);
    await userEvent.click(await screen.findByRole("button", { name: "common" }));

    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "uncommon species 12" })).toBeNull();
  });

  test("narrows to the chosen rarity and hides the rest", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await lookUp(KEY);
    await userEvent.click(await screen.findByRole("button", { name: "legendary" }));

    expect(screen.getByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "common species 3" })).toBeNull();
    expect(screen.queryByRole("img", { name: "rare species 26" })).toBeNull();
  });

  test("says which filter is on, rather than only showing it", async () => {
    // The grid alone cannot answer "why am I seeing three of two hundred" for
    // somebody who arrived at the panel after the click.
    renderCompanion(serving(view({ dex: mixed })));
    await lookUp(KEY);
    await userEvent.click(await screen.findByRole("button", { name: "rare" }));

    expect(screen.getByRole("button", { name: "rare", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "all", pressed: false })).toBeTruthy();
  });

  test("goes back to everything when the filter is cleared", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await lookUp(KEY);
    await userEvent.click(await screen.findByRole("button", { name: "legendary" }));
    await userEvent.click(screen.getByRole("button", { name: "all" }));

    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "rare species 26" })).toBeTruthy();
  });

  test("says the filter is empty rather than claiming nothing has graduated", async () => {
    // The two facts a shared empty state would merge. An operator who has 200
    // graduates and filters to a rarity they have never caught must not be told
    // their collection is empty — that reads as a bug in the panel.
    renderCompanion(serving(view({ dex: mixed })));
    await lookUp(KEY);
    await userEvent.click(await screen.findByRole("button", { name: "uncommon" }));

    expect(screen.getByText("No uncommon graduates yet.")).toBeTruthy();
    expect(screen.queryByText("Nothing graduated yet.")).toBeNull();
    // The egg is the only image left: the grid is gone, not merely emptied of
    // matches while keeping placeholder cells.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("offers no filter at all when nothing has graduated", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await lookUp(KEY);

    expect(await screen.findByText("Nothing graduated yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "legendary" })).toBeNull();
  });
});

describe("the bag", () => {
  /** A state with an inventory, and a companion for a candy to grow. */
  function withInventory(inventory: Record<string, number>): CompanionView {
    return view({
      state: { active: active(), eggUsage: 0, eggTier: null, inventory },
      lastCreditAt: null,
    });
  }

  test("lists what is held, with its count", async () => {
    // Distinct counts. Two items sharing one would pass against a component
    // that printed the first item's count beside every name.
    renderCompanion(serving(withInventory({ rareCandy: 3, mint: 7 })));
    await lookUp(KEY);

    expect(await screen.findByText("rare candy · 3")).toBeTruthy();
    expect(screen.getByText("mint · 7")).toBeTruthy();
  });

  test("spends a held item through the route that was written for it", async () => {
    // The dead end this closes: `POST keys/:id/use` existed and nothing in the
    // console called it, so a candy granted at a rate-limit ceiling could be
    // counted and never spent.
    const stub = renderCompanion({
      ...serving(withInventory({ rareCandy: 2 })),
      [POST_USE]: () => ({ body: { ok: true } }),
    });
    await lookUp(KEY);

    await userEvent.click(await screen.findByRole("button", { name: "Use rare candy" }));

    const posted = stub.calls.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`/api/plugins/pokemon/keys/${KEY}/use`);
    expect(JSON.parse(posted[0]?.body ?? "null")).toEqual({ item: "rareCandy" });
  });

  test("refetches the panel after a use, so the count it shows is the new one", async () => {
    let candies = 2;
    const stub = renderCompanion({
      [GET_KEY]: () => ({ body: withInventory({ rareCandy: candies }) }),
      [POST_USE]: () => {
        candies -= 1;
        return { body: { ok: true } };
      },
    });
    await lookUp(KEY);

    expect(await screen.findByText("rare candy · 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use rare candy" }));

    expect(await screen.findByText("rare candy · 1")).toBeTruthy();
    expect(stub.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  test("shows a refusal rather than a panel that silently looks unchanged", async () => {
    const stub = renderCompanion({
      ...serving(withInventory({ rareCandy: 1 })),
      [POST_USE]: () => ({
        status: 409,
        body: { error: { code: "CONFLICT", message: "none-held" } },
      }),
    });
    await lookUp(KEY);

    await userEvent.click(await screen.findByRole("button", { name: "Use rare candy" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("none-held")).toBeTruthy();
    // Refused, so nothing was refetched: the alert is the whole outcome.
    expect(stub.calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  test("offers no way to spend the charm, which the server would refuse anyway", async () => {
    // `parseHeldItem` admits `rareCandy` and `mint` only, so a POST of
    // `shinyCharm` is a 400. A button here would be a button whose only
    // possible outcome is an error.
    renderCompanion(serving(withInventory({ shinyCharm: 1, mint: 4 })));
    await lookUp(KEY);

    expect(await screen.findByText("shiny charm · 1")).toBeTruthy();
    expect(screen.getByText("held")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use shiny charm" })).toBeNull();
    // And the consumable beside it still has one, so this is not a bag with no
    // buttons at all.
    expect(screen.getByRole("button", { name: "Use mint" })).toBeTruthy();
  });

  test("does not offer an item held zero times", async () => {
    // `freshState` writes every item at zero, so an unfiltered bag lists the
    // whole catalogue as if it were owned.
    renderCompanion(serving(withInventory({ rareCandy: 0, mint: 5, shinyCharm: 0 })));
    await lookUp(KEY);

    expect(await screen.findByText("mint · 5")).toBeTruthy();
    expect(screen.queryByText(/rare candy/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use rare candy" })).toBeNull();
  });

  test("says the bag is empty when nothing is held", async () => {
    renderCompanion(serving(withInventory({ rareCandy: 0, mint: 0, shinyCharm: 0 })));
    await lookUp(KEY);

    expect(await screen.findByText("Nothing in the bag.")).toBeTruthy();
  });
});

describe("the activity state", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  /** A companion that last earned `ago` milliseconds before now. */
  function earning(ago: number | null): CompanionView {
    return view({
      state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
      lastCreditAt: ago === null ? null : Date.now() - ago,
    });
  }

  test("puts each boundary on the side the spec names", async () => {
    // Asserted against the derivation rather than through a render, and that is
    // deliberate. The panel reads the wall clock, so a fixture pinned one
    // millisecond inside a band has already left it by the time React has
    // painted — the earlier version of this table failed about half the time
    // for that reason alone. Here `now` is a parameter, so the edges are exact.
    const NOW = 1_700_000_000_000;
    const at = (ago: number): string => activityOf(true, NOW - ago, NOW);

    expect(at(0)).toBe("working");
    expect(at(5 * MINUTE - 1)).toBe("working");
    expect(at(5 * MINUTE)).toBe("idle");
    expect(at(HOUR - 1)).toBe("idle");
    expect(at(HOUR)).toBe("tired");
    expect(at(8 * HOUR - 1)).toBe("tired");
    expect(at(8 * HOUR)).toBe("sleep");

    // Never observed earning, and no companion at all. Both are ordering rules
    // rather than bands, so neither has an edge to sample.
    expect(activityOf(true, null, NOW)).toBe("sleep");
    expect(activityOf(false, NOW, NOW)).toBe("egg");
  });

  const cases: ReadonlyArray<{ ago: number | null; state: string }> = [
    // Mid-band, one per state: what the rendered panel has to say. The edges
    // are the pure test above; these prove the derivation reaches the DOM.
    { ago: 0, state: "working" },
    { ago: 30 * MINUTE, state: "idle" },
    { ago: 3 * HOUR, state: "tired" },
    { ago: 40 * HOUR, state: "sleep" },
    // A save written before the column existed.
    { ago: null, state: "sleep" },
  ];

  for (const { ago, state } of cases) {
    test(`reads ${ago === null ? "never" : `${ago}ms`} since the last credit as ${state}`, async () => {
      renderCompanion(serving(earning(ago)));
      await lookUp(KEY);

      // The name and the visible text both, because the rule is that the state
      // is legible without colour — not merely announced.
      expect(await screen.findByRole("status", { name: `Activity: ${state}` })).toBeTruthy();
      expect(screen.getByText(state)).toBeTruthy();

      // The spec lists six states. `focus` would have to mean a burst of recent
      // requests, and the plugin keeps one instant per key rather than any
      // per-request history, so there is nothing here that could tell a burst
      // from a trickle. Asserted in every band so that inventing it later fails
      // wherever it was made to fire.
      expect(screen.queryByText("focus")).toBeNull();
    });
  }

  test("an unhatched companion is an egg however recently the key earned", async () => {
    // Ordering, not a band: an egg has no activity to describe, so the freshest
    // possible credit must not make one "working".
    renderCompanion(
      serving(
        view({
          state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
          lastCreditAt: Date.now(),
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByRole("status", { name: "Activity: egg" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Activity: working" })).toBeNull();
  });
});

describe("a request that fails", () => {
  test("renders a message instead of throwing into the host's error boundary", async () => {
    renderCompanion({
      [GET_KEY]: () => ({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "no such key" } },
      }),
    });
    await lookUp(KEY);

    expect(await screen.findByText("No companion for that key yet.")).toBeTruthy();
  });

  test("survives a route the gateway does not serve at all", async () => {
    // The stub's 501, which is what a mistyped prefix or a half-registered
    // plugin backend looks like from the panel's side.
    renderCompanion({});
    await lookUp(KEY);

    expect(await screen.findByText("No companion for that key yet.")).toBeTruthy();
  });
});
