# OmniGateway Repository Guidance

Agent guidance for repo work: architecture, boundaries, conventions, durable traps.
`README.md` serve operators; `ARCHITECTURE.md` explain how system fit together; this file serve
contributors. Update all that change touch.

**This file is loaded every session; keep it lean.** Add here only an invariant a contributor
break by not knowing it, in the fewest lines that name the file, symbol and test that pin it. Anything
else go where its subject already live: how a subsystem work → `ARCHITECTURE.md`; operator-facing
behaviour → `README.md` / `docs/*.md`; procedure → `docs/adding-a-provider.md`,
`docs/writing-a-plugin.md`; design rationale → `docs/superpowers/specs/`; forensic history behind
rule — how found, what measured, earlier wrong drafts — under `## History` in matching spec. One
line here with a pointer beat a paragraph. Never restate what a test already pin, and never
narrate a fix: state the rule that survive it.

## Scope

OmniGateway = Bun/TypeScript monorepo for self-hosted AI gateway:

- `apps/gateway`: Elysia gateway + long-lived process loops
- `apps/dashboard`: admin console served by gateway
- `apps/cli`: local `omni` CLI
- `packages/control`: admin ops shared by gateway routes + CLI
- `packages/dashboard-sdk`: what plugin UI bundle build against
- `packages/ir`: provider-neutral domain model
- `packages/plugin-api`: pure plugin manifest schema, context + event types
- `packages/providers`: provider adapters + catalog
- `packages/router`: pure routing
- `packages/ratelimit`: pure API-key limit eval + sliding-window counting
- `packages/coord`: pure coordination interface (window, gauge, mutex) + in-memory impl; every
  counter fleet must share live behind it
- `packages/rtk`: tool-result filters, applied in dispatch before routing
- `packages/ponytail`: vendored lazy-senior-dev ruleset, appended to system prompt in dispatch
- `packages/store`: persistence + encryption; two `Store` impls, `sqlite/` (default) and
  `postgres/` (cluster), one contract suite in `test/contract/` run against both
- `packages/testkit`: shared test fixtures

Approved designs in `docs/superpowers/specs/`; matching plans in `docs/superpowers/plans/`. Read
spec before change, but verify current code — plans record past intent.

## Commands

Use Bun from repo root:

```bash
bun install
bun run dev              # gateway with file watching
bun run start
bun test                 # excludes dashboard tests
bun run test:all         # both suites; what CI runs
bun run typecheck        # core and dashboard
bun run lint
bun run fmt
```

Dashboard:

```bash
bun run dev:dashboard              # Vite on 5173, proxies /api and /health to 9000
bun run build:dashboard            # writes apps/dashboard/dist
bun run --cwd apps/dashboard test  # happy-dom suite excluded from root tests
```

CLI + release:

```bash
bun apps/cli/src/index.ts --help
cd apps/cli && bun link
omni doctor --root <install>
bun run build:npm v1.2.3
```

Push `v*` tag run `.github/workflows/release.yml`; tag = sole version source. Before claim done: run
focused changed-behavior tests, full `bun test`, dashboard suite, `bun run typecheck`, `bun run lint`,
`bun run check:claims`, `bun run check:dead`. Last two once missing from this line while CI ran
them; branch passed every command here, still failed `verify`. Set here = what
`.github/workflows/ci.yml` run; that file gain step, this line gain one.

## Architectural boundaries

**Single-copy rules.** Four helpers in `@omni/store/types` and `@omni/control` are only copy of
their question; each exist because several sites once asked separately and disagreed. Never
re-derive locally, however small local question look: `servesTarget` / `resolvePin` ("can
this account serve this target" — provider, custom `endpointId`, pin are one question; router,
`putModel`, `resolveModelLimits`, `omni doctor`, console picker all route through it;
`ServingCredential` carry `providerData` so it see custom endpoints), `scopeOf` (principal to
read filter), `quotaRolledOver` ("has this window already ended"). `servesTarget` consult no
descriptor, name no provider: rule = "target naming endpoint served only by account at
it", which cover `custom` without saying so.

1. `packages/ir` stay provider-independent + side-effect-free. Inject clocks + logger sinks; never
   import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, model catalogs stay in
   `packages/providers`. Inside, adapter never import from other provider's directory —
   shared helpers at package root (`http.ts`, `sse.ts`, `types.ts`); codecs provider
   need forked into own directory even when near-identical, so each provider can become
   standalone plugin later; `custom/` is worked example.
3. `packages/router` stay pure: no network, database, token refresh, timers.
4. Dispatch own side effects, retries, refresh, deadlines, failover, stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` know nothing about caller type: no Elysia, cookies, argv, terminal, timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows + secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
   Repo method added to `types.ts` added to **both** `sqlite/` and `postgres/` and to
   sqlite forwarder, plus test in `test/contract/` — only place behaviour proven on one
   backend proven on other. Plugin SQL passthrough dialect-specific by design. Postgres
   `routing.version()` read-behind (interface sync, read async), so cross-process routing writes
   reach replica through `routing` pubsub topic wired in `app.ts`, filtered to other nodes so
   own writes still patch, not rebuild.
8. All outbound provider HTTP use `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` and `/descriptors` must stay leaves: pure `packages/router` import
   `descriptors`; leaf property is what allow it. `packages/providers/test/leafSubpaths.test.ts`
   pin both.
10. Catalog pricing give defaults. Router price from saved targets; catalog edits hit new targets
    only.
11. CLI administer local installs through `@omni/control`, never `/api/*`. Inject every side effect
    so tests never start processes or write outside temp dirs.
12. Dashboard call `/api/*` only — including one WebSocket, `/api/stream`. One exception:
    `/health`, polled to watch gateway leave and return across restart when no session exist to
    probe. May import `@omni/store/types`, `@omni/ir`, `@omnigateway/dashboard-sdk`, but **not**
    `@omni/providers` — no subpath, not even leaf: provider loaded from `<root>/plugins/`
    exist only at runtime, so console importing providers can route to plugin provider while
    showing it nowhere. Mirror wire shape in `api/types.ts` like `PluginCatalogEntry`; never import
    it back. `ProviderId` come from `@omni/ir`, but provider list, order, label, colour, models all
    come from `GET /api/catalog`; `theme/tokens.ts` hold no provider list. Shell gate in
    `routes/_app.tsx` resolve catalog in `beforeLoad` **after** session check, before any screen
    mount, so `--p-<id>` exist at first paint. Gate all-or-nothing, so its `errorComponent`
    render error **with retry** — never spinner, never blank — and must not swallow `redirect`
    expired session throw. Pinned by `apps/dashboard/test/routes/appGate.test.tsx`.
    SDK permitted: it hold one copy of plugin API-prefix rule, LIVE switch, `usePluginChannel`
    (ergonomics, not boundary). SDK in `SHARED_IMPORTS` — bundled per plugin it duplicate
    `LiveContext` and panel pause forever silently. Internals + pins:
    `docs/writing-a-plugin.md#how-the-sdk-is-wired-for-anyone-changing-it`.
13. `packages/rtk` stay pure like `ir` and `router`: no I/O, clocks, randomness. Rewrite tool-result
    content only, preserve errors + non-tool-result blocks. `@omni/rtk/catalog` leaf holding
    filter-id union; `@omni/store` import that subpath alone. `packages/ponytail` sit beside it
    under same rule — other pure dispatch-time request transform — and **return new
    request**, not edit one handed. `@omni/ponytail/catalog` leaf holding mode
    union; `@omni/store` import it alone, re-export `PonytailMode` from `@omni/store/types`.
    Ruleset text **vendored and pinned**, never fetched: prompt that change under installation
    = one no operator can reproduce bill from.
14. `packages/coord` stay pure same way: interface + memory impl, `now` parameter, one timer
    it own is mutex wait. Invariant every impl must hold: claim visible to every concurrent
    claimant **at call time, before promise settle** — memory impl mutate then return
    `Promise.resolve`. Consumers rely on it: `rateLimit.ts` claim before first yield;
    `loadRegistry.ts` keep synchronous local map, read shared gauge only through `refresh()`
    before rank. Thread `coord` through **all** of call graph;
    `apps/gateway/test/cluster/sharedCoord.test.ts` fail on any site still reading module-scope
    map. **`add` on unseeded bucket is no-op** (row already in store the seed read). Redis impl
    in `apps/gateway/src/coord/redis.ts` fail-open per table via `attempt()`, logged through
    closed `LogFields` keys `coord`/`coordFallback`. Layers, seeding, lease, pubsub, claim
    semantics: `ARCHITECTURE.md#clustering`. Design:
    `docs/superpowers/specs/2026-09-02-horizontal-scaling-design.md`.
15. `packages/ratelimit` stay pure same way; `now` always parameter, counters supplied by caller.
    `@omni/ratelimit/catalog` leaf holding dimension + window unions, `LimitConfig`, its zod
    schema; `@omni/store` import that subpath alone, re-export `LimitConfig`. Limiter state —
    rings + gauges — live in `apps/gateway`. `@omnigateway/plugin-api/events` **mirrors** unions
    and `WINDOW_MS`, not import (published vs not); mirror pinned by
    `apps/gateway/test/plugins/limitVocabulary.test.ts`, only place that may import both.
16. Plugins load from `<root>/plugins/` at boot, receive capability-scoped `PluginContext`: never
    `Store`, `HttpClient`, `AdminAuth`, `process.env`. **Guardrail, not sandbox** — plugin
    share gateway's process, can import past all of it. What it buy: accidental overreach
    impossible, intent auditable from manifest. Say so plainly wherever it come up.
    **One real exception: plugin supplying provider receive decrypted credential for its
    own provider.** `codec.buildRequest` get `{accessToken, apiKey, providerData}` from
    `credential.openForInference()`; its `oauth` flow reach same class by second door:
    `refresh` receive decrypted refresh token, `usage` access token through
    `UsageSecrets`. Bounded three ways: router only produce candidates for that codec's own
    provider id; refresher only hand credential to own provider's flow; neither codec
    nor flow hold client or store; every URL either name checked against
    manifest's `origins`.
    `packages/plugin-api` stay pure like `ir`; loader, context, event bus, channel registry live in
    `apps/gateway`. Every load failure skipped and reported, never fatal: proxy path depend on no
    plugin. `channels` capability give plugin `open(name)`, nothing else — never socket,
    upgrade request, header or `Principal`. Channel facade offer `send` (one connection,
    this process) and optional `broadcast` (topic, every process, over `coord.pubsub`, **never
    coalesced** — plugin payload name which thing changed, so folding by topic drop all but
    last — but **capped** per channel, `BROADCAST_BURST`, drop counted + reported, since one
    broadcast cost publish plus fan-out on every replica; per channel is **not** per key, so
    size against how many thing a plugin push about at once — first number was 50, ordinary
    install reach it. Unencodable payload counted apart from over-budget: different diagnosis,
    different line). Envelope encoded in `try` at
    `broadcaster.channel`: payload is plugin-authored `unknown`, and a throw from plugin's own
    timer kill process. Member optional in type because it land in 0.4.0 with no generation
    bump, so compiler force `?.` — host always supply it. Topic `plugin:<id>:<name>` with `<id>` from
    validated manifest, same rule `{{name}}` follow for tables. Registry answer what **exist**;
    `authorised` in `routes/stream.ts` decide who may hold it. Outbound frame reuse socket
    registry's bounded per-connection queue.
17. **No provider-specific code in core module** — aim, not achieved state, measured per package.
    `ratelimit`, `rtk`, `ponytail` clean. `ir`: only `LogFields.surface` (`"anthropic" | "openai"`),
    permitted vocabulary. `store`: `bodies/mask.ts` hold `xaiKey` rule and vendor key prefixes
    on purpose (redaction paragraph below). `router`: `resolve.ts` exclude `custom` from prefix
    routing, because bare model name cannot carry endpoint id. `control`: `schemas.ts` name
    `custom` in one rule surviving its target union (custom target carry `endpointId`,
    nothing else may); `credentials.ts` plus `models.ts` ask `=== "custom"` about endpoint
    metadata. That is all.
    **OAuth out of core.** `OAUTH_PROVIDERS` is empty null-prototype registry
    `registerOAuthProvider` fill; six vendor modules at `providers/src/<id>/oauth.ts`;
    `builtinOAuthFlows()` in `@omni/providers` is one list. Do not re-add literal.
    `seedBuiltinOAuth()` fill it from **`installPluginProviders`** on gateway (called
    unconditionally at boot, reachable from harness — `main()` called by no test) and from
    `apps/cli/src/run.ts` on CLI. Registry **threaded**: `registerOAuthProvider`,
    `seedBuiltinOAuth`, `installPluginProviders` all take one, default global, because
    guard reading module-global state passed on other test file's seed. Thread through **all**
    of call graph or none. Idempotence = `WeakMap` of which id installed into which registry
    (`WeakSet` of registries made deleted built-in unrecoverable); repair restore membership,
    not position. Seeding late safe because every consumer read registry at call time and
    `loadPlugins` register no flow; loader that ever register one move seed ahead of it.
    `installPluginProviders` must stay **unconditional** — `if (providers.length > 0)` kill OAuth
    on every plugin-less install; `oauthSeed.test.ts` catch it by asserting call sit at
    two-space indent in `main()`. Seed **order is operator-facing order** — anthropic, openai,
    kimi, kilo, grok, antigravity — because `oauthProviderIds` derive from `Object.keys`;
    `apps/cli/test/connect.test.ts` match by equality,
    `apps/gateway/test/plugins/install.test.ts` pin as literal. Never pin against
    `builtinOAuthFlows()`. Registry empty until seeded, so any test reading it **seed first**.
    Contract in `providers/src/oauthFlow.ts` with `oauthRequests.ts` and `oauthUsage.ts`;
    `@omni/providers` carry `@omni/store` **type-only** (`import type` from `@omni/store/types`),
    enforced by `packages/providers/test/oauthStoreEdge.test.ts` — not `leafSubpaths.test.ts`.
    Host keep mechanism — `pluginFlow.ts` (`oauthAdapter`), `pending.ts`, `refresh.ts`,
    `pkce.ts`, `lead.ts`, `types.ts` — because adapter hold transport, origin check, yield cap,
    return-shape validation, stamp `gatewayAuthored`. Each flow step is `async function*`
    yielding described requests; host perform every one; yield **capped** per step; `fail`,
    `keepPolling`, `pkce`, `randomState` supplied by host. `AuthRequest.timeoutMs` optional, clamped
    to host ceiling (built-ins use 30s token / 15s usage). `PluginOAuthFlow` discriminated
    union with `oauthAdapter` overloaded on `kind`. `requests.ts` hold pure builders that replaced
    `postJson`/`getJson` — deleted so nothing bypass adapter. Provider OAuth tests stay in
    `control/test/oauth/`, reading five via `test/oauth/builtins.ts` off seeded registry.
    History: decoupling spec.
    New provider knowledge in core go through three outcomes, in order: **descriptor data**; **make
    value carry own provenance** so branch delete; **named extension point** from
    closed set. `providerNative` is worked example: tagging block with producing
    provider deleted `needsAnthropicNative`, `ANTHROPIC_NATIVE_TOOLS`, table in router.
    Hook set **closed**. `LogFields` never extensible. Core cannot scan providers
    (`packages/providers` import `@omni/ir`; reverse is cycle) — injection only direction.
    **Redaction never becomes extensible**: `MASK_RULES` in `packages/store/src/bodies/mask.ts` keep
    vendor rules in core; descriptor-supplied regex = provider deciding how much of own
    secret survive. `PREFIXED_KEY` and `OPAQUE` already catch ordinary key shapes.
    Core keep provider-shaped **vocabulary**, not logic: `ErrorCode`, `LogFields`, `StopReason`,
    `CacheControl.ttl`, `AuthType`, `WindowType`, `surface`, `AnthropicToolFamily`. Provider
    needing new member edit core, by design.
    Trap: `autoCache` is **one boolean across six core files** — `providers/types.ts`,
    `store/types.ts`, `control/schemas.ts`, `dispatch/index.ts`, `dispatch/attempt.ts`,
    `SettingsBoard.tsx`. Design:
    [core/provider decoupling](docs/superpowers/specs/2026-08-27-core-provider-decoupling-design.md),
    [descriptor registry](docs/superpowers/specs/2026-08-26-provider-descriptor-registry-design.md).
18. **`Principal` and `Scope` in `@omni/control` are only copy of "who is asking" and "what may
    they read".** Four principals — `admin`, `viewer`, `client`, `machine` — share **one cookie**,
    so `AdminAuth.verify` return principal, never boolean. `stream/registry.ts` re-export
    union. Guards **opt-in per route**, never applied to group: `requireAdmin`,
    `requireReader` (admin|viewer), `requireClient`. GET nobody remember to widen stay admin-only,
    harmless way to be wrong. Mutations, snapshot download, `/api/connect/*` and `/api/plugins`
    stay `requireAdmin`.
    Trap: `scopeOf` mapped `machine` to `{kind:"key", apiKeyId:""}` meaning "matches nothing", but
    **`usage_daily.api_key_id` is `NOT NULL DEFAULT ''`**, so that scope read every untagged row at
    `daily` grain while `request_logs.api_key_id` (NULL) hid it at `raw`. `Scope` now carry
    `none` arm; `readsNothing` gate both readers **before** `scopeKey` — which collapse `all` and
    `none` to same `undefined`. Client surface own no body route: **absent, not refusing**.
    Design:
    [client dashboard surface](docs/superpowers/specs/2026-08-27-client-dashboard-surface-design.md).

## Adding a provider

Nine-step procedure in [docs/adding-a-provider.md](docs/adding-a-provider.md). Read before adding
one — several steps exist because skipping made bugs that read as something else.

## Writing a plugin

Procedure in [docs/writing-a-plugin.md](docs/writing-a-plugin.md): manifest, capability context,
storage placeholder, event guarantees, how UI bundle share console's React. Open with what plugin
can reach, which decide whether rest good idea.

## TypeScript and dashboard style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, tests included. Use `unknown` plus narrowing or named types.
- ESM imports with explicit `.ts` extensions. Match nearby naming + comment density.
- Biome: 2-space indent, 100-column lines. Avoid unrelated refactors.
- Dashboard use styled-components, never Tailwind or CSS files.
- Palette CSS variables in `theme/GlobalStyle.ts`; `theme/tokens.ts` reference them.
- Colour mean provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behavior tests at narrowest stable boundary.
- In-memory stores, synthetic credentials, stub `HttpClient`; never call live providers.
- Dispatch or adapter changes cover streaming + non-streaming paths.
- Preserve pre-commit failover vs post-commit stream behavior.
- Shared proxy changes test Anthropic + OpenAI error surfaces.
- Auth changes cover Bearer and `x-api-key`, malformed/conflicting input, revoked keys, allowlists,
  relevant rate limits.
- Deadline tests distinguish gateway timeout from client cancellation, leave no timers/listeners.
- Dashboard tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`,
  `renderWithRouter`; assert visible text, roles, accessible names. Re-query after async loads.
- **Do not add one test per call site of threaded registry** — stale day new site
  appear. Inject sentinel registry holding one synthetic provider, none of six; assert
  real request end to end; any consumer reading module-global fail loudly.
  `apps/gateway/test/dispatch/dispatch.test.ts` hold it, kill all four threading mutants alone.
  Need two dispatches: **configured** model short-circuit `resolveModel` before any registry
  read; **inferred** target priced from `PROVIDER_MODEL_CATALOG`. Same instrument as
  `providerTables.test.ts`, which discover leaking tables, not list them.
- **Drift check reading repaired history cannot fail.** `publishable.test.ts` ask git what moved
  since last tag; query in `packages/plugin-api/test/helpers/changed.ts`; `changed.test.ts`
  ask it of scratch repositories, no-edit case first. Watched set include `package.json`; diff take
  **one ref**, never `${ref}..HEAD` — two-dot compare commit to commit, miss working tree.
- **Check gated on `merge-base(main, HEAD)` fail on `pull_request`, vacuous on `push`.**
  `actions/checkout` never create `refs/heads/main`; on `push` to main `merge-base` is HEAD.
  Base resolve through `main` or `origin/main`, fall back to **first parent** when HEAD is
  base. One copy in `scripts/lib/history.ts`, tested in `scripts/test/history.test.ts`.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- `LogFields` is closed allowlist + redaction boundary. Treat new free-text fields as security
  changes; never add index signature. `fields?: LogFields` did **not** enforce it — excess property
  checking apply only to fresh literal, so `{ plugin, ...(cond ? {} : { detail }) }` and passing
  wider object both compiled. `Logger` methods now take `<T extends LogFields>(msg, fields?:
  OnlyLogFields<T>)`, pinned by `packages/ir/test/logFields.test.ts` with `@ts-expect-error`.
- **`GatewayError.gatewayAuthored` is second half of that boundary, opt-in on purpose.**
  `reasonField` withhold failure's message from stdout unless debug on, because `httpError`
  fill one from up to 500 characters of upstream body. Inferring from `provider !== undefined`
  broke moment codec errors named provider: plugin codec throwing on every request
  logged `code=UPSTREAM` with no reason. Flag default **false**; set only for message built
  from literals and values this repository own — never one carrying upstream body, never one
  authored outside this repository (`rebound` not set it, `codecFailure` do). Must survive
  re-wraps: `classify` and dispatch's `rewrap` both rebuild error.
- Return raw gateway API keys once; store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows and
  two password routes, which end sessions **by design**.
- **Two passwords, neither with default.** Admin password set at `/api/setup`, replaced at
  `PUT /api/settings/password` — require **current** one, because unattended cookie that
  rewrite own credential turn "left tab open" into "locked out". Success clear **every**
  session, caller's included; console send operator to `/login?reason=password-changed`. Wrong
  current password answer exactly like failed login. Viewer password **optional, absent by
  default**: no row, `passwordMatches(null, …)` refuse everything, `viewerConfigured` false.
  `PUT /api/settings/viewer-password` set/replace it; `{"password": null}` withdraw it and
  **delete** row; absent field is `BAD_REQUEST`. Setting or clearing drop **viewer**
  sessions only.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, errors
- `POST /v1/responses`: OpenAI Responses-compatible. **Stateless**: `previous_response_id`,
  `item_reference`, explicit `store: true` refused, not normalized away; `background: true`
  dropped. Keepalive under five seconds — Codex's HTTP client abandon connection silent for
  about that long.
- `GET /v1/models`: authenticated, filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

`/api/client/*` is key holder's own read surface: `login`, `logout`, `summary`, `usage`, `logs`,
`quota`, `quota/history`. Scope come from verified session, never query parameter — two
arrive as separate arguments because separate provenance. Client session re-read key
row on **every** verify, refuse revoked one.

Provider quota reach client as **named accounts**: `accountQuota` return one row per
credential+window carrying operator's `label`, deliberately. `usedRatio` and
`ratePerHourRatio` fractions in `0..1`. **Ceiling behind them derivable; accepted, not
defended** — `usedRatio` exact quotient recoverable by continued fractions;
`exhaustsAt` give second way. Rounding tried, not work; never reintroduce and claim
size withheld. `stale` and `rolledOver` stay separate booleans — folding blank chart for
poll interval after every rollover. `/api/client/quota/history` carry **no gateway rate** (that
aggregate cover every key). `clientSurface.test.ts` hold both halves: no credential identity on
`logs`/`usage`/`summary`; quota routes name accounts, omit `used`/`limit`/`ratePerHour`.

Every `/v1/*` request accept Bearer or `x-api-key`; reject conflicts. `null` model allowlist mean
unrestricted; empty array deny all models.

Translation invariants:

- Keep mid-conversation system messages in place; never fold into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve + accumulate Anthropic signatures.
- Outbound: OpenAI surface render canonical thinking as `reasoning_content` (stream deltas and
  non-streaming field); Anthropic surface keep dialect, unsigned blocks suppressed.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize missing beta.
- `ToolDef` discriminant is `kind`: `"portable"` or `"provider"` plus real `ProviderId`.
  `ProviderToolDef` is provider arm; `AnthropicToolDef` is **narrowing** requiring `family`.
  `AnthropicToolDef` carry exact versioned `type`, never normalized or upgraded; versions in
  `packages/providers/src/anthropic/tools.ts`; unknown dated types rejected, not prefix-matched.
- Provider-native content blocks use `providerNative` IR variant, keep payload verbatim, stay out
  of tool-id correlation, orphan removal, cross-provider translation, RTK. Block carry `provider` —
  who produced it — routing read that field.
- Provider-defined tool or `providerNative` history block admit **only** that provider's targets at
  routing. OpenAI hosted tools (`tool_search`, `web_search`, `local_shell`) pin from turn 1; OpenAI
  reasoning items come back from upstream and replayed, so Codex conversation pin from
  turn 2. Degradation spelled `excluded:capability:providerNative`; old rows carry
  `excluded:capability:anthropicTools`, stay readable — degradations forensic text never
  parsed. Redaction of `credentialId` there read `Excluded.kind`, never string.
- **Breakpoint on request's final mid-conversation system turn must leave that turn**, moved
  by `systemCacheControl` + retarget in `toWire` onto last cacheable block *before* it
  (`lastCacheableHistoryBlock(body.messages.slice(0, -1))`). Such turn is directive client
  re-emit every request, so it sit at different position next request; prefix ending inside
  it never prefix again. Measured: marked on trailing turn read **0** every request;
  moved one block back, read 13,896. Hoisting to request-level `cache_control` behave identically
  (dead). Mixed system turn (block array) get own copy of marker **stripped**. Recorded
  `anthropic:system-turn-cache-control-retargeted`; skipped when target already carry client's
  own marker. Numbers and $70.53 day: auto-cache spec History.
- `pauseTurn` own stop reason; never fold into `endTurn` or `toolUse`.
- Client tool names renamed to PascalCase on Anthropic **OAuth** leg only, restored in
  `anthropic/decode.ts` — never at egress. Anthropic fingerprint some name sets, refuse them
  through billing placeholder; `FINGERPRINT_REFUSED` name that. Restore site load-bearing: RTK
  normalize by case and separator alone, so egress-side restore silently degrade every shell
  classification. Cloak live in `buildRequest` frame, never on `dispatchRequest` — shared across
  attempts. Exempt names (already PascalCase, or `mcp__*`) reach wire unrenamed and **claim their
  spelling**.
- Unknown Anthropic block types + SSE events fail visibly, not skipped.
- Preserve cache-control breakpoint block, TTL, order when target can express them. Record
  degradations for requested features provider cannot express. **Two exceptions, only two:**
  - `autoCacheEnabled` (default **on**) let Anthropic adapter add breakpoints to request carrying
    **none**. Fire only when `estimateCachedInputTokens` is 0 *and* no `cache_control` in vendor
    bag. Up to **three** markers, one rule: walk tiers in render order — last tool, last system
    block, last cache-eligible block of wire history — place marker when that prefix beat
    **last placed marker's** prefix by ≥1024 (running comparison start at 0). Last *placed*, not
    previous tier. Gating each marker on own prefix was wrong: prefixes monotone, so gate 1
    implied all three. Same rule cover `OAUTH_IDENTITY` (~15 tokens) — **never add check naming
    that string**. Marker 3 walk `body.messages` **backwards, never `req.messages`** (flatMap drop
    turns of unsignable reasoning, so indices differ); skip string content and block types outside
    text/image/tool_use/tool_result/document. Write to wire body only, never IR — IR shared across
    attempts — pinned by deep-frozen fixture in `packages/providers/test/anthropic.test.ts`.
    Recorded `anthropic:cache-breakpoint-added` (marker 1 or 2),
    `anthropic:history-cache-breakpoint-added` (marker 3). Design:
    `docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md`.
  - `ponytailMode` (default **off**) let dispatch append vendored ruleset to `system` and
    **move** breakpoint client put on own last system block onto appended block:
    marker meant "cache through end of system", still do — count, TTL unchanged, no marker
    invented. Edit marker's *position* alone, on IR in dispatch, so
    `estimateCachedInputTokens` stay non-zero and autoCache still decline; moving marker must
    never become way to switch autoCache on. Injection **return new request**, pinned by
    deep-frozen fixture in `packages/ponytail/test/inject.test.ts`. Dedupe on `PONYTAIL_MARKER`.
    `count_tokens` apply same function by hand. Recorded on `request_logs.degradations` as
    `ponytail:<level>`, `ponytail:already-present`, `ponytail:cache-marker-moved`,
    `ponytail:cache-marker-not-last` — constants only. Last one is shape move cannot help
    (client marker on non-final system block; ruleset billed fresh, ~1,240 tokens). Text vendored
    from upstream tag **v4.9.0**, blob `a3e4d94b…` — pin blob. Design:
    `docs/superpowers/specs/2026-08-29-ponytail-prompt-injection-design.md`.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes disjoint classes priced
  once. Use `promptTokens()` when client surface need total prompt tokens.
- Adapters stream upstream. OpenAI chat usage need `stream_options.include_usage`; Responses API
  report usage on `response.completed`.
- `/v1/models` report smallest target window in pool. Limits advertised, not enforced.
- Normalize `[1m]` before key allowlist checks. `claude/` **is** reserved (`modelSchema`) and
  unwound at ingress **unconditionally**, before the allowlist runs — stripping later make
  mirror a way around key policy. `/v1/models` append one `claude/<id>` mirror per listed pool
  whose id not already start `claude`/`anthropic`, built from **filtered** list so it never
  widen what key see.
- Gateway not validate request-shape support per model; unsupported combos surface as upstream
  errors.
- **`ChatRequest.conversationId` is client's own name for its conversation; Codex
  backend partition prompt cache by it** — measured 0 of 5 cache reads without session id,
  14 of 15 with one. Arrive as Anthropic **`metadata.user_id`**: opaque free text (Claude Code send
  96-char JSON string whose nested `session_id` make it conversation-scoped); ingress **not**
  parse it. Only **conversation**-scoped ids may be used — OpenAI's `user` name human, read
  nowhere. `readConversationHeader` in `ingress/schemas.ts` hold header list, checked
  **after** body field, case-insensitive: `x-session-id`, `x-session-affinity` (opencode),
  `x-deepseek-harness-session-id` (dsh), `session-id` (Codex). Derived fallback (hash of
  instructions plus opening item) rotate several times per conversation; do **not** hash tool list
  or first message; gateway-generated id collapse into same fallback. `openai/wire.ts`
  resolve one key — client `prompt_cache_key`, then client `session_id`, then `conversationId`,
  then hash — **before** vendor `Object.assign`; `openai/codec.ts` put **same**
  string in `session_id` header (OAuth leg alone; `api.openai.com` take body field).
  `"session_id"` sit in `openaiProfile.order`. Both non-client cases hashed, two reasons:
  derived case hash by construction; `conversationId` hashed for **privacy** — arrive
  beside `device_id` and `account_uuid`. `store: false` **required** (Codex 400 otherwise). When
  checking what client send, print key set, not one member. History: responses-ingress spec.
- OpenAI surface read images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as `content`. Payload's own container header beat any
  declared type; remote URL never fetched. `images` is Ollama's images-only field, so
  non-image there is `BAD_REQUEST`; `attachments` is SDK's general envelope, so PDF or hosted
  URL dropped, never refused. Same reasoning as `looseCacheControl`.

Detailed compatibility rules + measured client behavior belong in `docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_BASE_URL` must be public reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidate
  stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > install in cwd > `~/.config/omnigateway`. Root
  `.env` intentionally override ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  root. `--root` flag suppress ambient `OMNI_DB_PATH` entirely (Bun preload cwd's `.env`);
  suppression warned on stderr, reported by `doctor`, removed from env spawned gateway inherit.
  `OMNI_ROOT` not suppress it: both ambient.
- Quota cooldowns, `1m` and `concurrency` process-local, reset on restart; `5h` and `1w` come
  from database, survive one.
- `usage.append` must run at most once per request ID; duplicate completion double-count
  `usage_daily` and `usage_rollup`. Pending rows hold placeholder metrics; inspect `state`, not
  `status`.
- `usage_rollup` derived, never authoritative: `request_logs` source of truth; `rebuildRollup`
  reproduce every bucket. Written in `append`'s transaction, pruned with rows it summarizes, rebuilt
  after restore, compared by `omni doctor`. Replaced unbounded `SELECT SUM` — `bun:sqlite`
  synchronous, so that scan blocked whole event loop. Same reason timeout around store read
  cannot fire; do not add one back.
- `quota_windows` store provider observations, not gateway counts. Missing data mean unknown, not
  unlimited. Probe failure must never disable credential.
- `quotaRolledOver` (single-copy rule above): between rollover and next probe — up to
  `quotaPollIntervalMs`, 300_000 default — newest reading count window that no longer exist;
  every staleness check report it current. Null `resetsAt` **not** rolled over. Rollover suppress
  **inference**, never measurement: `burnFor` drop `ratePerHour`, `exhaustsAt`, `survives`
  but **keep `windowStartsAt`** — suppressing it too make `spanStartOf` null, blank chart of
  real readings for poll interval. Surfaces phrasing both verdicts say **staleness first**.
- Projection line **truncate at ceiling**, never overshoot: `ratePerHour` is whole-window
  average, enormous in minutes after rollover. `projectedPace` move endpoint to instant
  line reach 100% — same instant `exhaustsAt` name. `usedPercent` capped at 100. Fact read "100% of
  limit before it resets", not "160% by reset".
- RTK filter ids persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is storage contract.
  `isRtkFilterId` drop unknown ids on read. Add ids freely; rename or remove only with migration.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are JSON keys of `api_keys.limits` —
  storage contract failing **closed**: unknown name is parse failure. Rename or remove only with
  migration; update mirror in `@omnigateway/plugin-api/events` in same change.
- Rate limiting explained in `ARCHITECTURE.md#rate-limiting`; invariants below each already broken
  once.
- **Nothing plugin imports may reach core package.** `@omnigateway/plugin-api` and
  `@omnigateway/dashboard-sdk` published; every `@omni/*` not, so one import put unresolvable
  `workspace:*` into stranger's tree — and typecheck green here.
  `packages/plugin-api/test/bundleWeight.test.ts` build each entry point, assert zod appear only
  under root; first test assert zod *is* present there, because "absent" also what broken
  harness report.
- **Range one published package put on other never resolved in this repository.**
  `dashboard-sdk` carried `@omnigateway/plugin-api: ^0.1.0` past that package's move to `0.2.0`, so
  every `bun add` of SDK resolved generation 1 against gateway refusing `api: 1`. Repairing
  range fix nobody: release step skip package whose **version** not moved. `publishable.test.ts`
  walk pairs, watch `package.json` beside `src`.
- **`SAFE_PROVIDER_ID` in `apps/dashboard/src/theme/tokens.ts` mirror `PROVIDER_ID_PATTERN`;
  `providerColor` is where stored string become CSS.** styled-components not escape
  interpolations; `credential.provider`, `target.provider`, `log.resolvedProvider` never pass
  `/api/catalog`; `sqlite/config.ts` parse `virtual_models.targets` with bare `JSON.parse`. Check
  live in `providerColor`, not four call sites. Pinned by
  `apps/gateway/test/routes/providerIdMirror.test.ts`. Reference carry
  `var(--p-<id>, var(--ink-faint))`.
- `admit`/`consume` claim ring stamp and gauge **synchronously**, before any `await`, roll back
  on refusal — ceiling of 3 once admitted 10 parallel requests.
- Refuse at auth, degrade at list. Unparseable `limits` read back as `null`, distinct from `{}`;
  `authenticateApiKey` turn it into `INTERNAL` — not `AUTH`. `keys.list()` must never throw over
  such row. Nothing may collapse that `null` into `{}`.
- Two fields editable after minting: `limits` (`setKeyLimits`, `PUT /api/keys/:id/limits`) and
  `modelAllowlist` (`setKeyModels`, `PUT /api/keys/:id/models`). Both written whole, never patched —
  `{}` is how last limit go away; allowlist `null` and `[]` opposite facts, so schema refuse
  default. `bodyLoggingOptOut` deliberately not editable — promise to whoever hold key.
- Windows *slide*. `1m` exact ring in `apps/gateway`; longer windows are `usage.sumSince` —
  which must filter `state = 'done'` — plus in-memory delta, cached 30s. Composition may over-count,
  must **never** under-count, so delta keep everything at or after read instant. Failed
  `sumSince` serve request, log through existing `LogFields` keys, degrading long windows
  only.
- Token and spend debit live in `finishLog` beside `usage.append`, never inside `@omni/store`: that
  site already run at most once per request id.
- Concurrency gauge released at request scope, nowhere else. Streaming handler return while
  request still run, so `finally` around handler body fire at head-send; streams free it from
  `sseResponse`'s run-once completion. No window expire gauge — leak lock key out until
  restart.
- `ApiKeySummary.limitUsage` count committed rows only: floor on what limiter see.
  `concurrency.used` is `null`, not `0`.
- `Target.credentialId` pin one account to one target — **filter state, not strategy**. No
  `"pinned"` strategy exist, none should be added. Pin **hard**: disabled, breakered,
  rate-limited or quota-spent pinned account fail request, never spill.
  `pin:missing` emitted **once per target**, only when no account resolve; accounts pin exclude
  skipped silently. `pinSeen` declared **per target, inside target loop**, set **before**
  any `drop()`. All three guards are `continue`, so order cannot change membership — order
  decide only whether `pin:missing` fire; mutation that widen membership is making earlier
  guard conditional on pin.
  Nothing validate pin at write time (removing account must not make unrelated edit
  unsavable); `omni doctor` carry that weight, must resolve through `resolvePin`. Control schema
  refuse `""`, bound it to 64 chars of `[A-Za-z0-9_-]` **on both arms of union**, because
  `pin:missing` carry it into `LogFields.credentialId` untruncated; dashboard **omit** field
  rather than send empty. `sqlite/config.ts` read targets back unvalidated, so restored database
  bypass schema. Format not pinned to `crypto.randomUUID()`.
  Console draft clear pin on provider **and** endpoint change (`retargetDraft`,
  `reEndpointDraft`), never on model change — **draft behaviour only**; `PUT /api/models/:id` and
  `omni models put -f` save pin under changed provider; `doctor` report it.
  `resolveModelLimits` describe pinned target by own account's auth; unresolvable pin fall
  back to provider-wide narrowing, **never** catalog figures (`setup.ts` persist that number into
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`). `unreachable` in `putModel` check pinned account's auth
  alone, **deliberately not grandfatherable** — `pairOf` stay keyed on provider+model, so
  clearing dangling pin never refused. `modelLimits` resolve pin from **enabled** credentials,
  `models.ts` from existence, same split `heldAuths` make.
  Both surfaces that remove account name models pinned to it **before** confirm; console
  treat unanswered `useModels()` or empty credential list as unknown, never as no pin.
- `provider:missing` follow pin rule exactly: **once per target**, `kind: "target"`,
  `credentialId: ""`, **first** guard in target loop. Dispatch's `INTERNAL "no adapter for
  provider …"` stay throw: reaching it mean router admitted what it should have excluded;
  `deps.adapters` separate injection point from descriptors.
- **Format and existence two questions.** `providerIdSchema` check format alone, gate
  **credentials**: `createApiKeyCredential` parse it, then ask `isProviderId`. `catalogModelAuths`
  answer "every way in" for unknown provider. **Target naming any well-formed provider id
  save** — `targetSchema` take `providerIdSchema`, existence checked nowhere on that path, same
  exemption dangling pin have; `provider:missing` and `omni doctor` carry weight. One rule
  survive old enum: **`custom` target require `endpointId`, nothing else may carry
  one**.
- `ProviderModelChoice.auth` enforced at write time in `putModel`, never at routing. Catalog export
  fact (`catalogModelAuths`), control own rule. Provider with no credential unknown,
  unlisted model unknown, disabled credentials count, stored target under that id exempt.
- **`ProviderId` is validated string, not union of six.** Five tables key on it —
  `PROVIDER_DESCRIPTORS`, `ADAPTERS`, `PROFILES`, `BODY_ORDER`, `PROVIDER_MODEL_CATALOG` — each
  hand-written literal; only `PROVIDERS` derived. Delete built-in's line and **typecheck
  pass**. What catch it: lint (unused import) and
  `packages/providers/test/descriptor.test.ts` (key-set equality against literal `IDS`) — never
  compiler; if guarantee need be stronger, derive table. Lookups keyed on
  **stored** id partial; `noUncheckedIndexedAccess` make each compile error at point
  of use; do not cast away. `PROVIDER_ID_PATTERN` in `packages/providers` is source;
  `packages/control/src/catalog.ts` read it. Four other copies validate **plugin** id
  (`packages/plugin-api/src/manifest.ts`, `apps/gateway/src/plugins/routes.ts`,
  `packages/control/src/plugins.ts`, `packages/store/src/sqlite/plugins.ts`), pinned by behaviour
  in `apps/gateway/test/plugins/pluginIdGrammar.test.ts` — failure mean mirror stale, never
  that pattern should widen.
- **Every provider-keyed table drop its prototype.** Provider id arrive from client's `model`
  name and from unvalidated `virtual_models.targets`; on ordinary literal
  `table["constructor"]` read "installed" then throw. `PROVIDER_ID_PATTERN` accept `constructor`;
  `noUncheckedIndexedAccess` cannot see it. Do not add `Object.hasOwn` at readers instead — partial
  protection reading as total worse than none. **Do not enumerate tables here**:
  `packages/control/test/providerTables.test.ts` **discover** them by walking exported surface
  of both packages, assert walk found something. Spreading null-prototype object give
  ordinary one — use `Object.assign(Object.create(null), …)` — and `.hasOwnProperty()` as method
  throw; use `Object.hasOwn`. Guard live at **read site**, `dispatch/index.ts`, not
  `app.ts`: `DispatchDeps` and `ProxyDeps` public injection points. Console cannot import
  `@omni/providers`, so `heldAuths` restate rule with `Object.create(null)` and own test.
- **Registry threaded into some of call graph, not all, is this repository's most repeated
  bug, and sweep that keep failing.** Sentinel-registry test (Testing section) is guard;
  history in decoupling spec.
- **Module-scope `Object.keys`/`Object.entries` over `PROVIDER_DESCRIPTORS` is build-time
  snapshot**; `loadPlugins()` run long after import. Six sites wrong this way
  (`providerCatalog`, `providerIdSchema`, `isProviderId`, `PREFIX_PROVIDER`, `CALLBACKS` — deleted
  — and `OAUTH_PROVIDER_IDS`, now `oauthProviderIds()`). Assume **seventh** exist until you
  grep for pattern, not names. `PROVIDER_IDS` still exist, still snapshot — feed
  CLI usage messages and tests, never gate.
- **`AggregateError` has no message of own.** Node report failed multi-address connect that
  way, so `error.message` render `reason=` empty; `request_logs` hold no message column.
  `describeError` in `@omni/ir` is one way to fill that field; `classify` recurse into `errors`
  for same reason, else retryable transport failure fell through to `INTERNAL`.
- `CONNECT_ATTEMPT_TIMEOUT_MS` must stay above one TCP retransmit: node's Happy Eyeballs budget
  under Linux's one-second initial RTO, so dropped SYN abandoned at ~500ms. Measured: 3
  failures in 99 connects at default, 0 in 212 once raised.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats decoded
  away. Keep server idle timeout above request deadline.
- Socket registry close every connection **before** `app.stop()`; its `stopLoops` position is
  what make that true. `stop()` called without `true`, so it drain. Close with `1001`; `4401` mean
  "do not reconnect", for expired session alone.
- `/health` watcher stay plain `fetch` poll, must never move onto socket.
- Elysia call `.ws()` route's `beforeHandle` **twice**, guarded by `typeof === "function"`, so it
  must be single idempotent function, never array. Register companion plain `GET` on
  same path, else browser hit 404 on endpoint that exists.
- **Pushed topic replace polling, so emitter count must match writer count** (`res:logs`:
  `beginLog`, `routeLog`, `finishLog`; `res:usage` only `finishLog`, nothing else count tokens).
- **Topic name resource; every query-key branch reading it in its entry** (`res:usage` cover
  console `["usage",…]` and `["client","usage",…]`). Topic classes, `res:*` prefix mapping,
  `plugin:*` no-`seq` contract, coalescing: `ARCHITECTURE.md#push-transport`.
- Telemetry is process-local: `/metrics` reads neither store nor `coord`; provider HTTP gains no
  trace header; tracing off allocates no spans. See the [observability design](docs/superpowers/specs/2026-09-04-observability-design.md).
- Stdout hold operational events; `request_logs` hold completed requests. Do not restore duplicate
  per-request access lines. `requestId` join both.
- Console read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` name
  existing capture; not create one.
- Docker image contain gateway + built console (multi-stage, non-root `bun`, `HEALTHCHECK` on
  `/health`); npm package contain CLI, gateway, dashboard. Kustomize base in `k8s/`; `secret.yaml`
  gitignored, `secret.example.yaml` committed.
- OpenAI OAuth route to narrower Codex surface. OAuth-specific encoding stay behind existing `oauth`
  flag.
- Snapshot is database alone. `request_bodies/` excluded; after restore, body rows and artifact
  files disagree until `sweepOrphans` reconcile. Snapshot still carry encrypted credentials and
  API-key hashes; downloads `no-store`.
- Lifecycle and swap rules below explained in `ARCHITECTURE.md#replacing-the-database-while-it-is-open`
  and `#stopping-and-restarting`. Read section before changing any.
- Restart ask systemd, never self-SIGTERM; `--no-block` required.
- Quiesce latch gate `/v1/*` only; `/api/*` and `/health` stay live through swap.
- `store.close()` idempotent, `reopen()` tolerate closed handle, so restore = close → swap →
  reopen. Repo methods forward per call: bind one to local and it die at next swap.
- **Swap forwarder in `sqlite/store.ts` hand-write one arrow per repo method; arrow of
  lower arity still satisfy interface** — dropped optional parameter silently become
  `undefined` (`usage.recent` shipped that way; scoped read returned every key's rows). Adding
  parameter to repo method mean editing that arrow; `packages/store/test/swap.test.ts` read
  forwarder source, assert no arrow drop argument.
- `vacuum()` must checkpoint, or page count fall while file keep every page.
- Restore compare admin password hash across swap, invalidate sessions only when differ.
  **Nothing may sit between swap and that comparison.** `swapIn` rebuild `usage_rollup` last
  and guarded, for that reason; cost documented in `README.md`.
- `omni db restore` refuse while gateway running, no override.
- Plugin ordering traps, both silent when reversed: channel registry build **before**
  `loadPlugins` in `apps/gateway/src/index.ts`; route's `close` read `registry.topics(id)`
  **before** `registry.remove(id)`. Tables, migrations, events, channels, externals, asset
  paths: `ARCHITECTURE.md#plugins`.
- Literal `../` never reach route handler — `URL` normalise first, so test asserting 404 for
  it prove nothing. Only percent-encoded forms reach guard; `realpath` already decide every case.

## Subagent workflow

- Orchestrator create implementation subagent, then separate review subagent. Subagents not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; no worktrees.

## graphify

Project can carry knowledge graph at `graphify-out/` with god nodes, community structure,
cross-file relationships. `graphify-out/` gitignored, so fresh clone has none: if
`graphify-out/graph.json` absent, run `/graphify .` to build, or skip graph and read source
directly. Every rule below conditional on that file existing.

Rules:
- Codebase questions: first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships, `graphify explain "<concept>"` for focused concepts. Return scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain not surface enough context.
- After modifying code, run `graphify update .` to keep graph current (AST-only, no API cost).
- AST extraction not follow barrel re-exports: import of `GatewayError` from `@omni/ir` target
  `packages_ir_src_index_gatewayerror`, but symbol defined in `errors.ts`, so edge dangle, drop
  at build. That silently zero inbound degree of types whole architecture turn on —
  `GatewayError`, `ChatRequest`, `Store`, `ProviderId`, `StreamEvent`, `Logger`, `HttpClient` — so
  god-node rankings under-weight `packages/ir` and `packages/store` until endpoints remapped to
  defining module. Every `graphify update .` bring it back.