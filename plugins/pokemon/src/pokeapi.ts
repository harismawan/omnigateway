/**
 * The plugin's only outbound dependency, and the only part of the game that can
 * be offline.
 *
 * Two rules shape everything below, and both come from the spec rather than
 * from convenience:
 *
 * **Cache first, always.** The sprite for #25 does not change and neither does
 * its capture rate, so an asset is fetched once and kept. A cached asset is
 * never refetched, which is also what makes a busy install polite to a free
 * public API it does not pay for.
 *
 * **A miss is normal, never an error.** `data/` is excluded from database
 * snapshots, so after a restore *every* cached file is gone, and an air-gapped
 * install never had any. Every function here returns `null` (or an empty index)
 * on failure instead of throwing: the caller renders an unhatched egg and says
 * species data could not be fetched. This module is reached from a request
 * path, and a cosmetic feature must not be able to take one down.
 *
 * Capabilities arrive as arguments. Nothing here reaches for `fetch`, `process`,
 * or a filesystem module, so a test supplies a stub pair and no test can touch
 * the network or a real directory by accident.
 */

import type { PluginFetch, PluginFiles } from "@omni/plugins";
import { ANIMATED_SPECIES_MAX, hasAnimatedSprite } from "./balance.ts";
import type { SpeciesCandidate } from "./roll.ts";

export type PokeApiDeps = { net: PluginFetch; files: PluginFiles };

/**
 * The two origins the manifest declares.
 *
 * The `net` the host hands us is already bound to this allowlist, so a request
 * elsewhere is refused by the host rather than by convention. These constants
 * exist for the *other* half of the guarantee: every URL below is built from a
 * literal origin plus a literal path plus an integer this module validated. No
 * value from a caller, and no value from a response body, is ever spliced into
 * a URL as a string — see `chainIdFromUrl` for the one place that is tempting.
 */
const POKEAPI_ORIGIN = "https://pokeapi.co";
const SPRITE_ORIGIN = "https://raw.githubusercontent.com";

/** The animated Gen-V set, the only sprites this plugin uses. See `ANIMATED_SPECIES_MAX`. */
const SPRITE_DIR =
  "/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated";

/**
 * A ceiling on an evolution-chain id, which is the one id we learn from a
 * response rather than from a caller.
 *
 * PokéAPI has fewer than 600 chains and the ids of old ones do not move, so this
 * is generous. It is here to bound what a malformed or hostile body can talk us
 * into: the id becomes both a URL segment and a filename, and "an integer under
 * a known ceiling" is a much smaller space to reason about than "an integer".
 */
const MAX_EVOLUTION_CHAIN_ID = 2000;

/**
 * How many species documents to fetch at once while building the index.
 *
 * The first build is 649 species plus their chains against an unpaid public API.
 * Unbounded `Promise.all` over that list is a small burst of abuse; one at a
 * time turns a background prefetch into something measured in minutes.
 */
const INDEX_FETCH_CONCURRENCY = 8;

/**
 * One species, as the Dex and the evolution path need it.
 *
 * `isLegendary` and `isMythical` stay separate rather than being folded into one
 * flag because `rarityFromCaptureRate` takes them separately, and the two mean
 * different things to PokéAPI. Folding them here would be a lossy translation
 * performed for nobody's benefit.
 */
export type SpeciesDetail = {
  id: number;
  /** Localised names by language code, e.g. `{ en: "Pikachu", ja: "ピカチュウ" }`. */
  names: Readonly<Record<string, string>>;
  captureRate: number;
  isLegendary: boolean;
  isMythical: boolean;
  /**
   * The evolution line containing this species, base first.
   *
   * A *line*, not the whole chain: PokéAPI's chain for Eevee branches nine ways,
   * and a Vaporeon's line is `[133, 134]`, not a nine-element list. The line is
   * the path from the base down to this species, continued along the first
   * branch to a leaf — so `chain.length` is the number of stages this Pokémon
   * grows through, `chain[0]` is the Dex's `base_id`, the last entry is its
   * `final_id`, and `chain.indexOf(id)` is its `chain_order`. One array answers
   * all four questions consistently, which is the point of returning it whole.
   */
  chain: readonly number[];
};

/** Cache paths. Every one is built from an integer this module already validated. */
const INDEX_PATH = "species/index.json";
const speciesPath = (id: number): string => `species/${id}.json`;
const chainPath = (chainId: number): string => `species/chain-${chainId}.json`;
const spritePath = (id: number, shiny: boolean): string =>
  shiny ? `sprites/shiny/${id}.gif` : `sprites/${id}.gif`;

/**
 * The gate every public function passes through before an id reaches a URL or a
 * path.
 *
 * `hasAnimatedSprite` alone is not enough, and the gap is the entire reason this
 * wrapper exists: it is a range check, so `2.5` and `1e3 - 351` satisfy it, and
 * `` `species/${2.5}.json` `` is a perfectly writable filename that no later
 * lookup will ever match. `Number.isInteger` is what makes "derived from the
 * validated integer id" true rather than approximately true.
 */
function isFetchableSpeciesId(id: number): boolean {
  return Number.isInteger(id) && hasAnimatedSprite(id);
}

// --- narrowing helpers -------------------------------------------------------
// Everything below crosses a trust boundary: a third party's JSON, reached over
// a network, cached to disk, and read back after a restore. It is `unknown` at
// every step and is narrowed by hand. A malformed document must produce `null`,
// never an exception and never a half-built object.

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- byte and JSON plumbing --------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cached JSON, or null for absent, unreadable, or unparseable. All three mean "refetch". */
async function readJson(deps: PokeApiDeps, path: string): Promise<unknown> {
  try {
    const bytes = await deps.files.read(path);
    if (bytes === null) return null;
    // A truncated write needs no branch of its own: an empty or partial document
    // fails to parse, and the `catch` below already means "refetch".
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Best effort, deliberately.
 *
 * A full disk or a missing parent directory costs us the cache and nothing else;
 * the fetch already succeeded and the caller already has its answer. Letting the
 * write throw would turn a degraded cache into a failed request.
 */
async function writeCache(deps: PokeApiDeps, path: string, bytes: Uint8Array): Promise<void> {
  try {
    await deps.files.write(path, bytes);
  } catch {
    // Intentionally swallowed; see above.
  }
}

async function writeJson(deps: PokeApiDeps, path: string, value: unknown): Promise<void> {
  await writeCache(deps, path, encoder.encode(JSON.stringify(value)));
}

/** Parsed JSON from the network, or null for offline, refused, non-2xx, or malformed. */
async function fetchJson(deps: PokeApiDeps, url: string): Promise<unknown> {
  try {
    const response = await deps.net(url);
    if (!response.ok) return null;
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

/** Response bytes, or null on the same set of failures. */
async function fetchBytes(deps: PokeApiDeps, url: string): Promise<Uint8Array | null> {
  try {
    const response = await deps.net(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

// --- evolution chains --------------------------------------------------------

/** A chain node reduced to what a line needs: a species id and its successors. */
type ChainNode = { id: number; evolvesTo: readonly ChainNode[] };

/**
 * Chain documents resolved during one call, so a build that walks 649 species
 * fetches Bulbasaur's chain once rather than three times.
 *
 * Holds the in-flight promise, not the result, so two species that share a chain
 * and are being resolved concurrently still produce one request.
 */
type ChainCache = Map<number, Promise<ChainNode | null>>;

/**
 * The chain id out of a species document's `evolution_chain.url`.
 *
 * This is the only id in the module that comes from a response body, and it is
 * why the URL is rebuilt from `POKEAPI_ORIGIN` rather than followed. A body that
 * said `https://evil.example/api/v2/evolution-chain/7/` would match this pattern
 * and yield `7` — and we would then fetch *our* chain 7, from PokéAPI, and cache
 * it under `chain-7.json`. The response chooses no host, no path, and no
 * filename; it chooses at most a number, inside a checked range.
 */
const CHAIN_URL_ID = /\/evolution-chain\/(\d+)\/?$/;

function chainIdFromUrl(url: unknown): number | null {
  if (typeof url !== "string") return null;
  const match = CHAIN_URL_ID.exec(url);
  if (match === null) return null;
  const id = Number(match[1]);
  if (!Number.isInteger(id) || id < 1 || id > MAX_EVOLUTION_CHAIN_ID) return null;
  return id;
}

const SPECIES_URL_ID = /\/pokemon-species\/(\d+)\/?$/;

function speciesIdFromUrl(url: unknown): number | null {
  if (typeof url !== "string") return null;
  const match = SPECIES_URL_ID.exec(url);
  if (match === null) return null;
  const id = Number(match[1]);
  return isFetchableSpeciesId(id) ? id : null;
}

/**
 * A chain document's tree, keeping only species this plugin can render.
 *
 * Out-of-range members are dropped rather than carried, and the example that
 * settles it is Bisharp: PokéAPI puts Kingambit (#983) at the end of its chain,
 * and a line of `[624, 625, 983]` would tell the economy a Pawniard grows
 * through three stages, the third of which has no animated sprite and would
 * render as a blank box at the exact moment the player finished paying for it.
 * The whole plugin is scoped to the first 649 by `ANIMATED_SPECIES_MAX`; the
 * chains it stores are scoped the same way, so every stage it promises exists.
 */
function parseChainNode(raw: unknown): ChainNode | null {
  const node = asRecord(raw);
  if (node === null) return null;
  const species = asRecord(node.species);
  const id = speciesIdFromUrl(species?.url);
  if (id === null) return null;
  const children = asArray(node.evolves_to) ?? [];
  const evolvesTo: ChainNode[] = [];
  for (const child of children) {
    const parsed = parseChainNode(child);
    if (parsed !== null) evolvesTo.push(parsed);
  }
  return { id, evolvesTo };
}

/** The path from the chain's base down to `id`, or null when the chain omits it. */
function pathTo(node: ChainNode, id: number): number[] | null {
  if (node.id === id) return [id];
  for (const child of node.evolvesTo) {
    const tail = pathTo(child, id);
    if (tail !== null) return [node.id, ...tail];
  }
  return null;
}

/** From `node` down the first branch to a leaf, excluding `node` itself. */
function descendFirstBranch(node: ChainNode): number[] {
  const rest: number[] = [];
  let current = node;
  while (current.evolvesTo.length > 0) {
    const next = current.evolvesTo[0] as ChainNode;
    rest.push(next.id);
    current = next;
  }
  return rest;
}

/** See `SpeciesDetail.chain` for why a line and not the whole tree. */
function lineThrough(root: ChainNode, id: number): number[] | null {
  const prefix = pathTo(root, id);
  if (prefix === null) return null;
  const self = prefix[prefix.length - 1] as number;
  // `prefix` already ends at `id`; the descent continues past it to the leaf, so
  // Charmeleon's line is [4, 5, 6] rather than the [4, 5] the path alone gives.
  const node = nodeFor(root, self);
  return node === null ? prefix : [...prefix, ...descendFirstBranch(node)];
}

function nodeFor(node: ChainNode, id: number): ChainNode | null {
  if (node.id === id) return node;
  for (const child of node.evolvesTo) {
    const found = nodeFor(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** Cache-first chain document, shared across every species in one call. */
function loadChain(
  deps: PokeApiDeps,
  chainId: number,
  cache: ChainCache,
): Promise<ChainNode | null> {
  const inFlight = cache.get(chainId);
  if (inFlight !== undefined) return inFlight;

  const pending = (async (): Promise<ChainNode | null> => {
    const path = chainPath(chainId);
    const cached = await readJson(deps, path);
    if (cached !== null) {
      const parsed = parseChainNode(cached);
      if (parsed !== null) return parsed;
      // Cached but unparseable: the file predates a shape change or was
      // truncated. Fall through and refetch rather than serve nothing forever.
    }
    const fetched = await fetchJson(deps, `${POKEAPI_ORIGIN}/api/v2/evolution-chain/${chainId}`);
    if (fetched === null) return null;
    const root = asRecord(fetched)?.chain;
    const parsed = parseChainNode(root);
    if (parsed === null) return null;
    await writeJson(deps, path, { chain: root });
    return parsed;
  })();

  cache.set(chainId, pending);
  return pending;
}

// --- species detail ----------------------------------------------------------

function parseNames(raw: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  for (const entry of asArray(raw) ?? []) {
    const record = asRecord(entry);
    if (record === null) continue;
    const language = asRecord(record.language)?.name;
    const name = record.name;
    if (typeof language === "string" && typeof name === "string") names[language] = name;
  }
  return names;
}

/** A cached `SpeciesDetail`, re-narrowed. Disk is a trust boundary too — see `readJson`. */
function parseCachedDetail(raw: unknown, id: number): SpeciesDetail | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const captureRate = asFiniteNumber(record.captureRate);
  if (captureRate === null) return null;
  const chainRaw = asArray(record.chain);
  if (chainRaw === null || chainRaw.length === 0) return null;
  const chain: number[] = [];
  for (const entry of chainRaw) {
    if (typeof entry !== "number" || !isFetchableSpeciesId(entry)) return null;
    chain.push(entry);
  }
  return {
    id,
    names: parseNames(record.names),
    captureRate,
    isLegendary: record.isLegendary === true,
    isMythical: record.isMythical === true,
    chain,
  };
}

/** The `names` of a cached detail are stored in PokéAPI's own shape, so one parser serves both. */
function detailToCache(detail: SpeciesDetail): unknown {
  return {
    captureRate: detail.captureRate,
    isLegendary: detail.isLegendary,
    isMythical: detail.isMythical,
    chain: detail.chain,
    names: Object.entries(detail.names).map(([language, name]) => ({
      language: { name: language },
      name,
    })),
  };
}

async function loadDetail(
  deps: PokeApiDeps,
  id: number,
  chains: ChainCache,
): Promise<SpeciesDetail | null> {
  // The gate. Nothing past this line may build a URL or a path from an id that
  // has not been through it.
  if (!isFetchableSpeciesId(id)) return null;

  const path = speciesPath(id);
  const cached = parseCachedDetail(await readJson(deps, path), id);
  if (cached !== null) return cached;

  const raw = asRecord(await fetchJson(deps, `${POKEAPI_ORIGIN}/api/v2/pokemon-species/${id}`));
  if (raw === null) return null;

  const captureRate = asFiniteNumber(raw.capture_rate);
  if (captureRate === null) return null;

  const chainId = chainIdFromUrl(asRecord(raw.evolution_chain)?.url);
  if (chainId === null) return null;
  const root = await loadChain(deps, chainId, chains);
  if (root === null) return null;
  const chain = lineThrough(root, id);
  // Fail closed on the chain, matching the active Pokémon's rule rather than the
  // Dex's: `chain.length` picks a stage threshold, so guessing it wrong silently
  // changes how much growth the player owes. A `null` here shows as "species data
  // unavailable", which is the visible degradation the spec asks for.
  if (chain === null || chain.length === 0) return null;

  const detail: SpeciesDetail = {
    id,
    names: parseNames(raw.names),
    captureRate,
    isLegendary: raw.is_legendary === true,
    isMythical: raw.is_mythical === true,
    chain,
  };
  await writeJson(deps, path, detailToCache(detail));
  return detail;
}

/**
 * One species' evolution line and names, for the Dex and the evolution path.
 *
 * Null for an id outside the animated range, for a non-integer id, and for every
 * flavour of fetch or parse failure. The caller cannot tell those apart on
 * purpose: all of them mean "no species data", and all of them render the same.
 */
export function speciesDetail(deps: PokeApiDeps, id: number): Promise<SpeciesDetail | null> {
  return loadDetail(deps, id, new Map());
}

// --- the candidate index -----------------------------------------------------

function parseCachedIndex(raw: unknown): SpeciesCandidate[] | null {
  const entries = asArray(raw);
  if (entries === null) return null;
  const candidates: SpeciesCandidate[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === null) return null;
    const id = asFiniteNumber(record.id);
    const captureRate = asFiniteNumber(record.captureRate);
    const forms = asFiniteNumber(record.forms);
    const finalId = asFiniteNumber(record.finalId);
    // `finalId` is newer than the first cache format. A cache without it is
    // rejected whole rather than defaulted, so the rebuild happens once instead
    // of the diversity weighting silently comparing against undefined forever.
    if (id === null || captureRate === null || forms === null || finalId === null) return null;
    if (!isFetchableSpeciesId(id)) return null;
    candidates.push({ id, captureRate, forms, finalId });
  }
  return candidates.length === 0 ? null : candidates;
}

async function mapWithConcurrency<T>(
  ids: readonly number[],
  limit: number,
  worker: (id: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(ids.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await worker(ids[index] as number);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * The candidate index the roll needs, cached whole.
 *
 * Built by walking the animated range rather than by reading PokéAPI's list
 * endpoint, because the list carries names and URLs and not the capture rate the
 * weighting turns on — and because a range this module already validated is a
 * better source of ids than a response body.
 *
 * Two degradation rules, and they pull in opposite directions on purpose:
 *
 * A partial build is **returned** — 600 candidates still make a fine roll, and
 * refusing to hatch because six species timed out would be the quiet failure the
 * spec warns about.
 *
 * A partial build is **not cached**. "A cached asset is never refetched" means a
 * cache written today is the answer forever, so caching a half-built index would
 * make one bad afternoon permanent. Only a complete index is written; anything
 * less is rebuilt on the next call, when the network may be back.
 */
export async function speciesIndex(deps: PokeApiDeps): Promise<readonly SpeciesCandidate[]> {
  const cached = parseCachedIndex(await readJson(deps, INDEX_PATH));
  if (cached !== null) return cached;

  const ids = Array.from({ length: ANIMATED_SPECIES_MAX }, (_, i) => i + 1);
  const chains: ChainCache = new Map();
  const details = await mapWithConcurrency(ids, INDEX_FETCH_CONCURRENCY, (id) =>
    loadDetail(deps, id, chains),
  );

  const candidates: SpeciesCandidate[] = [];
  for (const detail of details) {
    if (detail === null) continue;
    // Base forms only. `chain` is the line from its base, so a species that is
    // not its own first entry is a mid-chain form — rollable, it would give its
    // line a second price, because rarity comes from the rolled species' own
    // capture rate. Free to determine here: the details are already loaded.
    if (detail.chain[0] !== detail.id) continue;
    candidates.push({
      id: detail.id,
      captureRate: detail.captureRate,
      forms: detail.chain.length,
      finalId: detail.chain[detail.chain.length - 1] ?? detail.id,
    });
  }

  // Cached only when every species answered. A partial index still rolls fine —
  // 600 candidates is a game — but caching one makes a bad afternoon permanent,
  // since a cached asset is never refetched. Completeness is measured against
  // the details fetched, not the candidates kept: most species are not bases.
  if (details.every((detail) => detail !== null)) await writeJson(deps, INDEX_PATH, candidates);
  return candidates;
}

// --- sprites -----------------------------------------------------------------

/**
 * Sprite bytes, cached on disk forever.
 *
 * `shiny` is a boolean rather than a variant string because a boolean cannot
 * carry a path segment. It selects between two literal paths; there is no
 * interpolation of a caller's value anywhere in either URL.
 *
 * Null means "no sprite": out of range, not an integer, offline, or a 404. The
 * caller must render that as a stated absence — the spec is explicit that a
 * missing sprite silently becoming a blank box is worse than an error, because
 * quiet failure gets diagnosed as a bug in the gateway.
 */
export async function spriteBytes(
  deps: PokeApiDeps,
  id: number,
  shiny: boolean,
): Promise<Uint8Array | null> {
  // Refused before any I/O: a species outside the animated set has no sprite in
  // this repository, so fetching one is a guaranteed 404 we can skip, and
  // caching one is a file that can never be a valid hit.
  if (!isFetchableSpeciesId(id)) return null;

  const path = spritePath(id, shiny);
  try {
    const cached = await deps.files.read(path);
    if (cached !== null && cached.length > 0) return cached;
  } catch {
    // An unreadable cache is a miss, not a failure.
  }

  const url = shiny
    ? `${SPRITE_ORIGIN}${SPRITE_DIR}/shiny/${id}.gif`
    : `${SPRITE_ORIGIN}${SPRITE_DIR}/${id}.gif`;
  const bytes = await fetchBytes(deps, url);
  if (bytes === null) return null;
  await writeCache(deps, path, bytes);
  return bytes;
}
