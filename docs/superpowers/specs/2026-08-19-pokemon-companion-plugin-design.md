# Pokémon Companion Plugin — Design

Date: 2026-08-19
Status: approved

Depends on: [Plugin Host](2026-08-19-plugin-host-design.md)

## Problem

Token usage is a number. `usage_daily` says 4.1 billion tokens this month and
nobody feels anything about it.

PokeTokenBar — a macOS menu-bar app — makes the number felt by attaching it to a
Pokémon that hatches, grows, evolves, and graduates on the tokens you spend. The
mechanic works because the timescales match: a graduation costs 750M to 6B
tokens, which on one laptop is weeks of real work, so the sprite becomes a
record of effort rather than a progress bar.

OmniGateway already has better data than PokeTokenBar can get. It sees every
request across every provider, attributed to the API key that made it, with
exact token classes and cost, in one database — where PokeTokenBar reverse-
engineers JSONL logs and SQLite caches from ten different CLI tools.

This design ports the game onto that data, as the first plugin.

It is a plugin and not a core feature for three reasons, all of which held
before the host existed: almost nobody deploying an AI gateway wants it, it
depends on two external origins, and it carries third-party IP. See *Non-technical
note*.

## Solution

A plugin at `<root>/plugins/pokemon/` that:

- credits each API key's companion from `RequestCompleted` events
- runs the full PokeTokenBar economy — egg, hatch, evolve, graduate, Dex, shop,
  items, shiny, Ditto disguise, natures, candy grants
- keeps a **per-key** companion and a **per-key** Dex
- proxies and caches PokéAPI data and sprites server-side, so the browser never
  contacts a third-party origin
- ships PokeTokenBar's balance constants as defaults with one operator-tunable
  multiplier

### Decisions carried from the port

| Decision | Choice | Why not the alternative |
|---|---|---|
| Scope | Full economy | A growth-only port loses the shop, which is where accumulated tokens acquire a use |
| Ownership | One companion per API key | The gateway is multi-key; a per-install pet wastes the attribution the gateway already has |
| Dex | Per key | A key is a full save file; rotating one is starting over, which is a real cost the operator controls |
| Assets | Gateway proxies and caches | The dashboard must never add a third-party origin |
| Balance | PokeTokenBar constants + a multiplier | A throughput-derived multiplier makes numbers incomparable across installs and adds a feedback loop |

## Host amendments this plugin requires

Writing this spec against the approved host surface found two gaps. Both are
narrow, both mirror an existing pattern, and both must land in the host before
this plugin can be built.

### `net:outbound` capability

The plugin declares the origins it will contact, in its manifest:

```json
"capabilities": ["storage", "files", "net:outbound", "events:request", "events:limit"],
"origins": ["https://pokeapi.co", "https://raw.githubusercontent.com"]
```

The host hands it a `fetch` bound to that allowlist; a request to any other
origin is refused by the host, not by convention.

This is worth having independently of this plugin. A self-hosted gateway whose
selling point is that prompts do not leave the operator's machine should be able
to state, from one readable file, exactly which outside hosts each installed
plugin talks to. As with every other capability, it constrains honest code and
not hostile code — a plugin sharing the process can call global `fetch`. It is
an auditable declaration of intent.

### `files` capability

The host hands the plugin a scoped directory, `<root>/plugins/<id>/data/`, with
read and write confined to it.

That directory is **excluded from database snapshots**, exactly as
`request_bodies/` is and for exactly the same reason: a snapshot is the database
alone, and a downloaded snapshot's size should not track how many sprites got
cached. After a restore, cached assets and the plugin's rows disagree until the
cache refills, which is expected and self-healing — a missing sprite is
re-fetched.

The alternative — sprite bytes as BLOBs in `plugin_pokemon_*` tables — needs no
new capability and is wrong: it would put tens of megabytes of Nintendo artwork
into every snapshot an operator downloads.

## Storage

Four tables on the plugin's own migration track, named by the host as
`plugin_pokemon_<name>`:

```sql
-- companion: one row per API key
api_key_id    TEXT PRIMARY KEY,
state         TEXT    NOT NULL,   -- JSON: egg or active mon, inventory, eggTier, pendingHatchId
tokens_total  INTEGER NOT NULL DEFAULT 0,   -- monotonic; never recomputed
tokens_spent  INTEGER NOT NULL DEFAULT 0,   -- shop ledger; wallet = total - spent
created_at    INTEGER NOT NULL,
updated_at    INTEGER NOT NULL

-- dex: one row per graduation
id, api_key_id, base_id, final_id, chain_order, rarity, is_shiny, nature, caught_at

-- grants: candy edge-trigger state, keyed on a stable window identity
api_key_id, window_key, granted_tier, PRIMARY KEY (api_key_id, window_key)

-- species: the local PokéAPI index
species_id PRIMARY KEY, capture_rate, is_legendary, chain TEXT, names TEXT, fetched_at
```

The active Pokémon is **JSON**: one row, read and written whole, and its shape
churns with every balance change. The same call `api_keys.limits` already makes.

The Dex is **rows**: it grows without bound, the UI filters and sorts it, and
one corrupt entry must not take the save. PokeTokenBar needs a `Lossy<T>`
decoding wrapper precisely because its Dex is a JSON array; rows give that
isolation for free.

### Failure directions are split on purpose

- **Dex entries fail open.** An unknown `rarity` or `nature` on a historical row
  drops that row from the listing and logs it. A trophy case must not be hidden
  by one bad entry. This is the `isRtkFilterId` precedent.
- **The active Pokémon fails closed.** An unknown `rarity` there selects a
  graduation total — silently changing the game. The companion reads back
  `null`, distinct from "no companion yet", and the UI says the save is
  unreadable. Nothing may collapse that `null` into a default. This is the
  `limits` precedent, including its reason: refuse where a wrong guess is
  invisible.

`rarity` and `nature` rawValues are persisted, so they are a **storage
contract**. Rename or remove only with a migration.

## Growth

`RequestCompleted` carries `apiKeyId` and the four disjoint token classes. On
each event the plugin adds `(input + output + cacheRead + cacheWrite) ×
multiplier` to that key's `tokens_total`, in one statement, and applies the pure
state machine to the result.

Four properties, and the reasons they are properties rather than accidents:

- **Monotonic.** `tokens_total` only ever increases and is never recomputed from
  `request_logs`. `usage.prune(olderThan)` deletes logs, so any design that
  recomputed growth from them would run the meter *backwards* after a retention
  sweep — a Pokémon de-evolving because an operator tidied their database.
- **At most once per request.** `RequestCompleted` is emitted from `finishLog`,
  which already runs at most once per request id. The companion inherits that
  guarantee rather than building a weaker one.
- **From install forward.** A companion is created lazily on the first event for
  its key and starts at zero. There is no backfill, so there is nothing to
  reconcile and no watermark to drift. PokeTokenBar's `installBaselineSet` rule,
  and the reason this plugin needs no read access to `usage`.
- **Loss on crash is acceptable and bounded.** Host events are at-most-once, not
  durable. A crash loses at most a queue's worth of tokens against a 750M
  graduation. Stated so nobody later mistakes this meter for a ledger.

### The multiplier

`config.multiplier`, default `1.0`, applied at credit time.

PokeTokenBar's constants were tuned against roughly 253M tokens/day on one
laptop. A gateway fronting several clients can move that in an afternoon, and
cache reads — which the gateway counts and which are enormous and cheap — push
it further. At `1.0` a busy install graduates Pokémon in days instead of months.

The multiplier is the operator's knob for that, applied to credits and never
retroactive, so changing it never rewrites history or de-evolves anything.
Deliberately not derived from observed throughput: that makes two installs'
numbers incomparable and introduces a feedback loop between playing and pacing.

## The pure core

Game rules live in the plugin's own pure module — no I/O, no clock, no ambient
randomness:

```ts
advance(state, tokensTotal, seed, now) -> { state, events[] }
roll(speciesIndex, seed, constraints) -> speciesId
price(entry) / thresholds(rarity, forms, stage)
```

`now` is a parameter and **the seed is a parameter**. PokeTokenBar rolls against
live randomness, which makes a 1-in-64 shiny and a 1-in-128 Ditto disguise
effectively untestable. Injecting the seed makes every roll reproducible and is
the single largest correctness win available in this port.

The state machine is applied on each credit and on read, so a companion whose
key went quiet still renders correctly without a tick having fired.

### Balance constants

Ported verbatim, with PokeTokenBar's reasoning preserved in comments, because
several of the numbers encode a fixed bug:

- Egg hatches at 5M tokens; the excess carries into the hatchling.
- Graduation totals: common 750M, uncommon 1.875B, rare 3B, legendary 6B.
- Stage cost for form *i* of *k*: `T·i / (k(k+1)/2)`, so total is `T` regardless
  of how many forms a line has, and later stages cost more.
- Rare candy 500M (five times the 100M XP it grants — at parity, buying is free
  growth). Mint 100M. Shiny charm 3B. Fresh egg 1B, with guarantee tiers priced
  by the **graduation-total ratio** (1B / 2.5B / 4B), not the probability ratio.
- Shiny 1/64, 1/48 holding the charm. Ditto disguise 1/128 on common multi-form
  hatches.

The fresh-egg pricing comment is the one to preserve most carefully: priced by
probability ratio instead, two uncommon eggs beat one rare egg on *every* axis,
making the higher tier a strictly inferior product. `sortRank` ordering has a
test for the same class of bug, and it ports too.

## Species data and sprites

The plugin owns two proxy routes under its own mount, both inheriting the host's
`requireAdmin` wrapper:

- `GET /api/plugins/pokemon/species/:id` — JSON from the local `species` table,
  fetched from PokéAPI on miss.
- `GET /api/plugins/pokemon/sprite/:id` — bytes from `data/sprites/`, fetched
  from the sprite repo on miss.

`:id` is validated as an integer in range and the sprite variant is an enum, so
no caller can construct an arbitrary outbound URL. Combined with the manifest
origin allowlist, this is not an open proxy.

Assets are fetched once and cached indefinitely — the sprite for #25 does not
change. The species index is prefetched in the background after install so a
roll needs no network at the moment it happens.

**Hatching must work offline.** PokeTokenBar pre-rolls the next species into
`pendingHatchId` while the egg is still incubating, so the hatch itself is a
local state transition. That ports, and it is what makes the game survive a
gateway with no outbound access.

An air-gapped install degrades **visibly**: the egg stays an egg, the UI says
species data could not be fetched, and no sprite silently renders as a blank
box. A cosmetic feature failing quietly is worse than failing loudly, because
quiet failure gets diagnosed as a bug in the gateway.

## Candy grants

`LimitReached` fires when a key hits one of its own configured rate limits. That
grants candy to that key's companion: one for a session-class window, five for a
weekly-class one.

Rewarding a refusal reads oddly for about a second and then reads correctly —
the key hit its ceiling, which means it worked. It is also the only signal in
the gateway that means "this key ran as hard as it is allowed to."

Two rules, both of which are already-shipped regressions in the source app:

- The edge key is `dimension:window`, which is stable. Never `resets_at` or
  anything else that changes on each evaluation; a rolling weekly window whose
  reset instant moves re-granted at 80, 81, 84… on every refresh.
- Grant state is **persisted** and **seeded on first run**. In memory only, a
  restart re-grants forever. Unseeded, installing the plugin retroactively pays
  out for every window already at its ceiling.

## Key lifecycle

- A companion is created lazily on the first `RequestCompleted` for a key.
- `revoke` is soft — the key row persists — so a revoked key's companion
  **freezes**: visible, no longer growing, Dex intact. It is a finished save,
  not a deleted one.
- Hard deletion cascades, via the host's `ON DELETE CASCADE`.
- `omni plugin remove` leaves every table intact. `--purge` drops them, after
  confirming, because that is irreversible and someone's Dex is in there.

## Shop

`POST /api/plugins/pokemon/keys/:id/purchase` with an entry id.

Wallet is `tokens_total - tokens_spent`. Every purchase does the balance check
and the debit **in one transaction**; checking the balance and then writing lets
two concurrent clicks both pass a pre-purchase snapshot and overspend. This is
the same shape as the rate limiter's synchronous claim, and it fails the same
way if split.

Growth is never rewound. A purchase raises `tokens_spent` only, so the growth
meter is unaffected and no evolution is ever undone by shopping.

`state` mutations from a purchase — a fresh egg discarding the active Pokémon, a
mint rerolling nature, a charm becoming passive inventory — are applied by the
same pure `advance` in the same transaction.

## UI

An ESM bundle built against `packages/dashboard-sdk`, rendered inline under a
"Companion" nav entry, themed with the real dashboard tokens.

- A key selector; each key is a save file.
- The active sprite with its state — egg, idle, working, focus, tired, sleep —
  derived from recent traffic on that key.
- Growth to next evolution, wallet, and current form.
- Dex, filterable by rarity, showing shiny and nature.
- Shop and bag.

All sprite and species requests go to the plugin's own routes. The browser never
contacts `pokeapi.co` or `raw.githubusercontent.com`.

Per the host design, this mount sits inside a React error boundary. A rendering
bug here must not black out the console — the dashboard is what an operator
needs during an incident, and a Pokémon is not.

## Testing

Ported balance tests come first, because each one encodes a fixed bug:
`sortRank` ordering, `phaseThreshold` summing to the graduation total regardless
of form count, and fresh-egg tier pricing never making a higher tier inferior.

Seeded-roll tests assert shiny, Ditto, and rarity-weighted selection against
fixed seeds — impossible in the source app and the reason the seed is injected.

Growth tests: monotonic under a simulated retention prune; exactly one credit
per request id across streaming and non-streaming; multiplier applied to credits
and not retroactively.

Persistence tests: a corrupt Dex row degrades to a shorter list, a corrupt
active Pokémon degrades to `null` and never to a default rarity.

Candy tests: a restart does not re-grant, and installing against windows already
at their ceiling grants nothing.

Concurrency test: two simultaneous purchases against a balance sufficient for
one — exactly one succeeds.

Offline test: with the outbound fetch stubbed to fail, an egg with a
`pendingHatchId` still hatches, and one without reports rather than hangs.

UI tests under happy-dom against a stub plugin module, covering the error
boundary and the unreadable-save state.

## Out of scope

- Save transfer between PokeTokenBar and this plugin. The state shapes are
  deliberately close enough to make it possible later; it is not a goal now.
- A shared install-wide Dex. Per-key was chosen; a union view can be added
  without a migration.
- Companion state influencing routing, limits, or anything a request depends on.
  This plugin is strictly an observer. Nothing it stores may ever affect what
  the gateway serves.

## Non-technical note

The sprites, names, and evolution data are Nintendo and Game Freak intellectual
property, fetched at runtime from PokéAPI and the community sprite repository.

PokeTokenBar is a personal menu-bar application. Infrastructure that other
people deploy is a different exposure profile. Two choices follow from that and
are load-bearing rather than incidental: this ships as a separately-installed
plugin the operator chooses to fetch, and no asset is vendored into the
OmniGateway npm package or Docker image. Recorded here so the decision stays a
knowing one.
