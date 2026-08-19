import { expect, test } from "bun:test";
import type { PluginFetch, PluginFiles } from "@omni/plugins";
import { ANIMATED_SPECIES_MAX } from "../src/balance.ts";
import { type PokeApiDeps, speciesDetail, speciesIndex, spriteBytes } from "../src/pokeapi.ts";

/**
 * Both capabilities are stubs, and that is the point of taking them as
 * arguments: nothing in this file can reach the network or a real directory even
 * by mistake, so a broken test fails rather than hammering a free public API.
 */

function memoryFiles(): { files: PluginFiles; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const files: PluginFiles = {
    read: async (path) => store.get(path) ?? null,
    write: async (path, data) => {
      store.set(path, data);
    },
    exists: async (path) => store.has(path),
  };
  return { files, store };
}

/** A handler returning null stands for an unreachable host, which throws like a real one. */
function stubNet(handler: (url: string) => Response | null): { net: PluginFetch; calls: string[] } {
  const calls: string[] = [];
  const net: PluginFetch = async (url) => {
    calls.push(url);
    const response = handler(url);
    if (response === null) throw new Error("network unreachable");
    return response;
  };
  return { net, calls };
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const notFound = (): Response => new Response("not found", { status: 404 });

const SPRITE_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated";

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

type ChainDoc = { species: { url: string }; evolves_to: ChainDoc[] };

function node(id: number, ...children: ChainDoc[]): ChainDoc {
  return {
    species: { url: `https://pokeapi.co/api/v2/pokemon-species/${id}/` },
    evolves_to: children,
  };
}

function speciesDoc(id: number, over: Record<string, unknown> = {}): unknown {
  return {
    capture_rate: 45,
    is_legendary: false,
    is_mythical: false,
    names: [{ language: { name: "en" }, name: `species-${id}` }],
    evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${id}/` },
    ...over,
  };
}

/** Every species is its own single-node chain unless a test says otherwise. */
function wholeApi(url: string): Response | null {
  const species = /\/pokemon-species\/(\d+)$/.exec(url);
  if (species !== null) return json(speciesDoc(Number(species[1])));
  const chain = /\/evolution-chain\/(\d+)$/.exec(url);
  if (chain !== null) return json({ chain: node(Number(chain[1])) });
  return notFound();
}

function deps(net: PluginFetch, files: PluginFiles): PokeApiDeps {
  return { net, files };
}

// --- sprites -----------------------------------------------------------------

test("a cached sprite is served without any fetch", async () => {
  // The whole cache-first rule in one assertion. A sprite does not change, so a
  // second look at #25 must cost nothing — and after a restore the same code
  // path is the one that refills the cache.
  const { files, store } = memoryFiles();
  store.set("sprites/25.gif", GIF);
  const { net, calls } = stubNet(() => {
    throw new Error("the cache should have answered this");
  });

  expect(await spriteBytes(deps(net, files), 25, false)).toEqual(GIF);
  expect(calls).toEqual([]);
});

test("a fetched sprite is cached, and the shiny variant is a separate asset", async () => {
  const { files, store } = memoryFiles();
  const shinyBytes = new Uint8Array([1, 2, 3]);
  const { net, calls } = stubNet((url) =>
    url.endsWith("/shiny/25.gif") ? new Response(shinyBytes) : new Response(GIF),
  );
  const api = deps(net, files);

  expect(await spriteBytes(api, 25, false)).toEqual(GIF);
  expect(await spriteBytes(api, 25, true)).toEqual(shinyBytes);
  // The exact URLs the spec names. A typo in either path is a permanent 404 that
  // reads as "this species has no sprite", so the strings are asserted whole.
  expect(calls).toEqual([`${SPRITE_BASE}/25.gif`, `${SPRITE_BASE}/shiny/25.gif`]);
  expect(store.get("sprites/25.gif")).toEqual(GIF);
  expect(store.get("sprites/shiny/25.gif")).toEqual(shinyBytes);

  // Both are now cached; neither is asked for again.
  calls.length = 0;
  expect(await spriteBytes(api, 25, false)).toEqual(GIF);
  expect(await spriteBytes(api, 25, true)).toEqual(shinyBytes);
  expect(calls).toEqual([]);
});

test("an offline sprite fetch returns null and does not throw", async () => {
  const { files, store } = memoryFiles();
  const { net } = stubNet(() => null); // the host is unreachable
  expect(await spriteBytes(deps(net, files), 25, false)).toBeNull();
  expect(store.size).toBe(0); // and nothing bogus was cached
});

test("a 404 sprite returns null rather than caching an error page", async () => {
  const { files, store } = memoryFiles();
  const { net } = stubNet(() => notFound());
  expect(await spriteBytes(deps(net, files), 25, false)).toBeNull();
  expect(store.size).toBe(0);
});

test("a species outside the animated range is refused before any fetch", async () => {
  const { files, store } = memoryFiles();
  const { net, calls } = stubNet(() => new Response(GIF));
  const api = deps(net, files);

  for (const id of [0, -1, ANIMATED_SPECIES_MAX + 1, 10_000]) {
    expect(await spriteBytes(api, id, false)).toBeNull();
    expect(await speciesDetail(api, id)).toBeNull();
  }
  // Not "fetched and discarded": refused. A species with no animation is not a
  // candidate at all, so the request is never made and no file is written.
  expect(calls).toEqual([]);
  expect(store.size).toBe(0);
});

test("a non-integer id can produce neither a URL nor a cache path", async () => {
  // `hasAnimatedSprite` is a range check, so 2.5 and 648.9 pass it. Without the
  // integer check they would reach `sprites/2.5.gif` — a writable filename that
  // no lookup ever matches, and a URL segment nobody validated.
  const { files, store } = memoryFiles();
  const { net, calls } = stubNet(() => new Response(GIF));
  const api = deps(net, files);

  for (const id of [2.5, 648.9, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
    expect(await spriteBytes(api, id, false)).toBeNull();
    expect(await speciesDetail(api, id)).toBeNull();
  }
  expect(calls).toEqual([]);
  expect(store.size).toBe(0);
});

test("a sprite whose cache write fails is still returned", async () => {
  // A full disk costs the cache and nothing else. The fetch already succeeded.
  const { files } = memoryFiles();
  const failing: PluginFiles = {
    ...files,
    write: async () => {
      throw new Error("ENOSPC");
    },
  };
  const { net } = stubNet(() => new Response(GIF));
  expect(await spriteBytes(deps(net, failing), 25, false)).toEqual(GIF);
});

// --- species detail ----------------------------------------------------------

test("a species detail carries its names and its evolution line, base first", async () => {
  const { files } = memoryFiles();
  const { net, calls } = stubNet((url) => {
    if (url.endsWith("/pokemon-species/5")) {
      return json(
        speciesDoc(5, {
          capture_rate: 45,
          names: [
            { language: { name: "en" }, name: "Charmeleon" },
            { language: { name: "ja" }, name: "リザード" },
          ],
          evolution_chain: { url: "https://pokeapi.co/api/v2/evolution-chain/2/" },
        }),
      );
    }
    if (url.endsWith("/evolution-chain/2")) {
      return json({ chain: node(4, node(5, node(6))) });
    }
    return notFound();
  });

  const detail = await speciesDetail(deps(net, files), 5);
  // The line runs base → this species → on to the leaf, so a mid-stage Pokémon
  // still reports all three stages and not just the two behind it.
  expect(detail?.chain).toEqual([4, 5, 6]);
  expect(detail?.names.en).toBe("Charmeleon");
  expect(detail?.names.ja).toBe("リザード");
  expect(detail?.captureRate).toBe(45);
  expect(calls[0]).toBe("https://pokeapi.co/api/v2/pokemon-species/5");
});

test("a branching chain yields one line, not the whole tree", async () => {
  // Eevee branches nine ways. A Vaporeon grows through two stages, and a
  // nine-element chain would tell the economy otherwise.
  const { files } = memoryFiles();
  const { net } = stubNet((url) => {
    if (url.endsWith("/pokemon-species/134")) {
      return json(
        speciesDoc(134, {
          evolution_chain: { url: "https://pokeapi.co/api/v2/evolution-chain/67/" },
        }),
      );
    }
    if (url.endsWith("/evolution-chain/67")) {
      return json({ chain: node(133, node(134), node(135), node(136)) });
    }
    return notFound();
  });

  expect((await speciesDetail(deps(net, files), 134))?.chain).toEqual([133, 134]);
});

test("a chain member outside the animated range is dropped from the line", async () => {
  // Bisharp's chain ends at Kingambit (#983), which has no Gen-V animation. A
  // three-stage line would promise a stage that renders as a blank box.
  const { files } = memoryFiles();
  const { net } = stubNet((url) => {
    if (url.endsWith("/pokemon-species/624")) {
      return json(
        speciesDoc(624, {
          evolution_chain: { url: "https://pokeapi.co/api/v2/evolution-chain/1/" },
        }),
      );
    }
    if (url.endsWith("/evolution-chain/1")) return json({ chain: node(624, node(625, node(983))) });
    return notFound();
  });

  expect((await speciesDetail(deps(net, files), 624))?.chain).toEqual([624, 625]);
});

test("a chain that does not contain the species yields null, not a one-stage guess", async () => {
  // The other half of failing closed. A line of `[id]` would look reasonable and
  // would quietly set the species' graduation cost to a single stage.
  const { files } = memoryFiles();
  const { net } = stubNet((url) => {
    if (url.endsWith("/pokemon-species/25")) {
      return json(
        speciesDoc(25, {
          evolution_chain: { url: "https://pokeapi.co/api/v2/evolution-chain/1/" },
        }),
      );
    }
    if (url.endsWith("/evolution-chain/1")) return json({ chain: node(1, node(2)) });
    return notFound();
  });

  expect(await speciesDetail(deps(net, files), 25)).toBeNull();
});

test("a malformed species response degrades to null rather than throwing", async () => {
  const { files, store } = memoryFiles();
  const bodies: unknown[] = [
    null,
    "not an object",
    [],
    {},
    { capture_rate: "many" },
    { capture_rate: 45 }, // no evolution_chain
    { capture_rate: 45, evolution_chain: { url: "not a url" } },
    { capture_rate: 45, evolution_chain: 7 },
  ];
  for (const body of bodies) {
    const { net } = stubNet(() => json(body));
    expect(await speciesDetail(deps(net, files), 1)).toBeNull();
  }

  // Invalid JSON is the same class of failure and must not escape as a throw.
  const { net } = stubNet(() => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
  expect(await speciesDetail(deps(net, files), 1)).toBeNull();
  expect(store.size).toBe(0);
});

test("a malformed chain response degrades rather than guessing the line", async () => {
  // Fails closed on purpose: `chain.length` picks a stage threshold, so a guess
  // here silently changes how much growth the player owes.
  const { files } = memoryFiles();
  const { net } = stubNet((url) =>
    url.includes("/evolution-chain/") ? json({ chain: { species: {} } }) : json(speciesDoc(1)),
  );
  expect(await speciesDetail(deps(net, files), 1)).toBeNull();
});

test("an evolution_chain URL cannot redirect the fetch off PokéAPI", async () => {
  // The only id in the module that comes from a response body. The body picks a
  // number inside a checked range and nothing else: not the host, not the path,
  // not the filename.
  const { files, store } = memoryFiles();
  const { net, calls } = stubNet((url) => {
    if (url.endsWith("/pokemon-species/1")) {
      return json(
        speciesDoc(1, {
          evolution_chain: { url: "https://evil.example/api/v2/evolution-chain/7/" },
        }),
      );
    }
    if (url.endsWith("/evolution-chain/7")) return json({ chain: node(1) });
    return notFound();
  });

  expect((await speciesDetail(deps(net, files), 1))?.chain).toEqual([1]);
  expect(calls).toEqual([
    "https://pokeapi.co/api/v2/pokemon-species/1",
    "https://pokeapi.co/api/v2/evolution-chain/7",
  ]);
  expect([...store.keys()]).toEqual(["species/chain-7.json", "species/1.json"]);
});

test("an evolution_chain URL with a non-numeric or oversized id is refused", async () => {
  const { files } = memoryFiles();
  for (const url of [
    "https://pokeapi.co/api/v2/evolution-chain/../../etc/passwd",
    "https://pokeapi.co/api/v2/evolution-chain/9999999/",
    "https://pokeapi.co/api/v2/evolution-chain/0/",
  ]) {
    const { net, calls } = stubNet(() => json(speciesDoc(1, { evolution_chain: { url } })));
    expect(await speciesDetail(deps(net, files), 1)).toBeNull();
    expect(calls).toEqual(["https://pokeapi.co/api/v2/pokemon-species/1"]);
  }
});

test("a cached species detail is served without any fetch", async () => {
  const { files } = memoryFiles();
  const { net, calls } = stubNet(wholeApi);
  const api = deps(net, files);

  const first = await speciesDetail(api, 1);
  expect(first).not.toBeNull();
  calls.length = 0;
  expect(await speciesDetail(api, 1)).toEqual(first);
  expect(calls).toEqual([]);
});

// --- the candidate index -----------------------------------------------------

test("the index covers the animated range and is not refetched", async () => {
  const { files, store } = memoryFiles();
  const { net, calls } = stubNet(wholeApi);
  const api = deps(net, files);

  const index = await speciesIndex(api);
  expect(index.length).toBe(ANIMATED_SPECIES_MAX);
  expect(index[0]).toEqual({ id: 1, captureRate: 45, forms: 1 });
  expect(index[index.length - 1]?.id).toBe(ANIMATED_SPECIES_MAX);
  expect(calls.length).toBeGreaterThan(0);
  expect(store.has("species/index.json")).toBe(true);

  calls.length = 0;
  expect(await speciesIndex(api)).toEqual(index);
  expect(calls).toEqual([]);
});

test("a cached index answers on its own, without touching the species cache", async () => {
  // The index cache has to be load-bearing by itself. Asserting only "the second
  // call makes no request" would pass against an index that was rebuilt from 649
  // cached species files — same answer, 649 disk reads, and the index cache doing
  // nothing. Seeding the index alone is what tells the two apart.
  const { files, store } = memoryFiles();
  store.set(
    "species/index.json",
    new TextEncoder().encode(JSON.stringify([{ id: 25, captureRate: 190, forms: 2 }])),
  );
  const { net, calls } = stubNet(() => {
    throw new Error("the cached index should have answered this");
  });

  expect(await speciesIndex(deps(net, files))).toEqual([{ id: 25, captureRate: 190, forms: 2 }]);
  expect(calls).toEqual([]);
  expect(store.size).toBe(1); // nothing else was read into existence or written
});

test("a partial index is returned but never cached", async () => {
  // 648 candidates still make a fine roll, so the roll gets them. Caching them
  // would make one bad afternoon permanent — a cached asset is never refetched.
  const { files, store } = memoryFiles();
  const { net } = stubNet((url) => (url.endsWith("/pokemon-species/7") ? null : wholeApi(url)));

  const index = await speciesIndex(deps(net, files));
  expect(index.length).toBe(ANIMATED_SPECIES_MAX - 1);
  expect(index.some((candidate) => candidate.id === 7)).toBe(false);
  expect(store.has("species/index.json")).toBe(false);
});

test("an offline index build returns empty rather than throwing", async () => {
  const { files, store } = memoryFiles();
  const { net } = stubNet(() => null);
  expect(await speciesIndex(deps(net, files))).toEqual([]);
  expect(store.has("species/index.json")).toBe(false);
});

test("a corrupt cached index is rebuilt rather than served", async () => {
  const encoder = new TextEncoder();
  for (const body of ['{"not":"an array"}', "[{}]", '[{"id":2.5,"captureRate":1,"forms":1}]', ""]) {
    // A fresh cache each time: a rebuild that only worked because the previous
    // iteration left 649 species documents behind would prove nothing.
    const { files, store } = memoryFiles();
    store.set("species/index.json", encoder.encode(body));
    const { net, calls } = stubNet(wholeApi);
    const index = await speciesIndex(deps(net, files));
    expect(index.length).toBe(ANIMATED_SPECIES_MAX);
    expect(calls.length).toBeGreaterThan(0);
  }
});

test("the index reports the line length as forms, deduplicating shared chains", async () => {
  // `forms` drives the Ditto-disguise condition and the stage thresholds, so it
  // is the line's length and not the number of chain members.
  const { files } = memoryFiles();
  const chainFetches: string[] = [];
  const { net } = stubNet((url) => {
    const species = /\/pokemon-species\/(\d+)$/.exec(url);
    if (species !== null) {
      const id = Number(species[1]);
      const chainId = id >= 1 && id <= 3 ? 1 : id;
      return json(
        speciesDoc(id, {
          evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${chainId}/` },
        }),
      );
    }
    const chain = /\/evolution-chain\/(\d+)$/.exec(url);
    if (chain !== null) {
      chainFetches.push(url);
      const id = Number(chain[1]);
      return json({ chain: id === 1 ? node(1, node(2, node(3))) : node(id) });
    }
    return notFound();
  });

  const index = await speciesIndex(deps(net, files));
  expect(index.slice(0, 3).map((candidate) => candidate.forms)).toEqual([3, 3, 3]);
  // Bulbasaur, Ivysaur and Venusaur share one chain, which is fetched once.
  expect(chainFetches.filter((url) => url.endsWith("/evolution-chain/1")).length).toBe(1);
});
