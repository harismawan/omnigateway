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
import { createPluginApi } from "@omni/dashboard-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import companionUi from "../ui/index.tsx";

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

type CompanionView = {
  state: CompanionState | null;
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

function view(patch: Partial<CompanionView> = {}): CompanionView {
  return {
    state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
    tokensTotal: 0,
    wallet: 0,
    dex: [],
    shop: [],
    ...patch,
  };
}

const KEY = "key_7f3a";
const GET_KEY = `GET /api/plugins/pokemon/keys/${KEY}`;
const POST_PURCHASE = `POST /api/plugins/pokemon/keys/${KEY}/purchase`;

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
          state: { active: null, eggUsage: 1_240_000, eggTier: null, inventory: {} },
          tokensTotal: 9_000_000,
          wallet: 2_500,
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "An egg, not yet hatched" })).toBeTruthy();
    expect(screen.getByText("1.2M tokens incubated")).toBeTruthy();
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
            {
              id: "d1",
              baseId: 133,
              finalId: 134,
              rarity: "legendary",
              isShiny: true,
              caughtAt: 1,
            },
            { id: "d2", baseId: 1, finalId: 3, rarity: "common", isShiny: false, caughtAt: 2 },
          ],
        }),
      ),
    );
    await lookUp(KEY);

    expect(await screen.findByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("Nothing graduated yet.")).toBeNull();
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
