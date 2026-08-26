import { expect, test } from "bun:test";
import {
  CAPABILITIES,
  PLUGIN_API_VERSION,
  parseManifest,
  safeParseManifest,
} from "../src/manifest.ts";

/** The smallest manifest that is still a plugin, reused as a base by most cases. */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pokemon",
    name: "Pokémon Companion",
    version: "1.0.0",
    api: PLUGIN_API_VERSION,
    server: "server/index.js",
    ...over,
  };
}

test("the capability vocabulary is the full set the host can construct", () => {
  // A manifest is authored outside this repo, so this list is a compatibility
  // contract rather than an internal enum. Adding a capability is free; renaming
  // one silently strips it from every plugin that declared it.
  expect(CAPABILITIES).toEqual([
    "storage",
    "files",
    "net:outbound",
    "events:request",
    "events:limit",
    "channels",
  ]);
});

test("a full manifest round-trips", () => {
  const manifest = base({
    ui: "ui/index.js",
    sdk: "^1.0.0",
    nav: { label: "Companion" },
    capabilities: [
      "storage",
      "files",
      "net:outbound",
      "events:request",
      "events:limit",
      "channels",
    ],
    origins: ["https://pokeapi.co", "https://raw.githubusercontent.com"],
  });
  expect(parseManifest(manifest)).toMatchObject({
    id: "pokemon",
    api: 1,
    capabilities: expect.arrayContaining(["storage"]),
    origins: ["https://pokeapi.co", "https://raw.githubusercontent.com"],
  });
});

test("a manifest declaring nothing gets no capabilities rather than all of them", () => {
  // The default has to be the empty set. A missing key meaning "everything"
  // would make the least-attentive plugin the most privileged one.
  expect(parseManifest(base()).capabilities).toEqual([]);
});

test("an unknown capability is a parse failure, not a silent drop", () => {
  // Failing closed, like `limits` and unlike `isRtkFilterId`. Dropping an
  // unrecognised capability would hand the plugin a context missing a surface it
  // believes it has, and the resulting crash names the wrong thing entirely.
  expect(safeParseManifest(base({ capabilities: ["storage", "spawn:process"] })).ok).toBe(false);
});

test("an id that is not a safe path, table prefix and log value is refused", () => {
  // This string becomes a URL segment, a SQL table name prefix and a log field
  // value. Each rejection below is one of those three going wrong.
  for (const id of [
    "../escape",
    "Pokemon",
    "poke_mon",
    "1pokemon",
    "",
    "a".repeat(33),
    "poke mon",
  ]) {
    expect(safeParseManifest(base({ id })).ok).toBe(false);
  }
  expect(safeParseManifest(base({ id: "a" })).ok).toBe(true);
  expect(safeParseManifest(base({ id: "poke-mon-2" })).ok).toBe(true);
});

test("origins are required with net:outbound and forbidden without it", () => {
  // Both directions matter. Without the first, a plugin gets an unbounded fetch
  // by omitting a field; without the second, a manifest lists origins that
  // nothing enforces, which reads to an operator as a promise.
  expect(safeParseManifest(base({ capabilities: ["net:outbound"] })).ok).toBe(false);
  expect(safeParseManifest(base({ origins: ["https://pokeapi.co"] })).ok).toBe(false);
  expect(
    safeParseManifest(base({ capabilities: ["net:outbound"], origins: ["https://pokeapi.co"] })).ok,
  ).toBe(true);
});

test("an origin carrying a path, or no host at all, is refused rather than trimmed", () => {
  // Coercing "https://pokeapi.co/api/v2" down to its origin would silently widen
  // the allowlist past what the author wrote and an operator read.
  for (const origins of [
    ["https://pokeapi.co/api/v2"],
    ["pokeapi.co"],
    ["*"],
    ["https://"],
    ["file:///etc/passwd"],
  ]) {
    expect(safeParseManifest(base({ capabilities: ["net:outbound"], origins })).ok).toBe(false);
  }
});

test("a manifest with neither a server nor a ui entry is refused", () => {
  // It would load successfully and do nothing, which is a typo rather than a
  // plugin, and the silence is the expensive part.
  expect(safeParseManifest({ ...base(), server: undefined }).ok).toBe(false);
});

test("a ui entry without an sdk range is refused", () => {
  // The host has no way to decide compatibility, and the failure without this
  // check is a white screen at render time rather than a message at load.
  expect(safeParseManifest(base({ ui: "ui/index.js" })).ok).toBe(false);
});

test("an unknown top-level key is refused rather than ignored", () => {
  // A misspelled key is otherwise a capability or entry point that silently does
  // not exist. `.strict()` throughout, for the same reason `limits` uses it.
  expect(safeParseManifest(base({ capabilties: ["storage"] })).ok).toBe(false);
});

test("safeParseManifest reports why rather than throwing", () => {
  // The loader turns every rejection into one startup line and a `doctor` entry,
  // so the reason has to survive as data.
  const result = safeParseManifest(base({ id: "../escape" }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("id");
});

test("a nav icon is refused, because nothing renders one", () => {
  // The field existed, validated, travelled to the console and was ignored:
  // every plugin got the same glyph. `.strict()` refusing it is the honest
  // state — a manifest key that silently does nothing reads as supported and
  // produces a bug report. Re-adding it once an icon set exists breaks no
  // manifest, because nothing can be relying on it today.
  expect(safeParseManifest(base({ nav: { label: "Companion", icon: "sparkles" } })).ok).toBe(false);
  expect(safeParseManifest(base({ nav: { label: "Companion" } })).ok).toBe(true);
});
