# OmniGateway Repository Guidance

Agent guidance for repo work: architecture, boundaries, conventions, durable traps.
`README.md` serve operators; `ARCHITECTURE.md` explain how system fit together; this file serve
contributors. Update all that change touch. Forensic history behind a rule — how it was found, what
was measured — live under `## History` in the matching spec, not here.

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
  counter a fleet must share live behind it
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
`bun run check:claims`, `bun run check:dead`. Last two were once missing from this line while CI ran
them, and a branch passed every command named here and still failed `verify`. The set here is what
`.github/workflows/ci.yml` run; when that file gain a step, this line gain one.

## Architectural boundaries

**Single-copy rules.** Four helpers in `@omni/store/types` and `@omni/control` are the only copy of
their question, and each exist because several sites once asked it separately and disagreed. Never
re-derive one locally, however small the local question look: `servesTarget` / `resolvePin` ("can
this account serve this target" — provider, custom `endpointId` and pin are one question; router,
`putModel`, `resolveModelLimits`, `omni doctor` and the console picker all route through it, and
`ServingCredential` carry `providerData` so it can see custom endpoints), `scopeOf` (principal to
read filter), `quotaRolledOver` ("has this window already ended"). `servesTarget` consult no
descriptor and name no provider: rule is "target naming an endpoint is served only by account at
it", which cover `custom` without saying so.

1. `packages/ir` stay provider-independent + side-effect-free. Inject clocks + logger sinks; never
   import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, model catalogs stay in
   `packages/providers`. Within it, an adapter never import from another provider's directory —
   shared helpers live at the package root (`http.ts`, `sse.ts`, `types.ts`), and codecs a provider
   needs are forked into its own directory even when near-identical, so each provider can become a
   standalone plugin later; `custom/` is the worked example.
3. `packages/router` stay pure: no network, database, token refresh, timers.
4. Dispatch own side effects, retries, refresh, deadlines, failover, stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` know nothing about caller type: no Elysia, cookies, argv, terminal, timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows + secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
   A repo method added to `types.ts` is added to **both** `sqlite/` and `postgres/` and to the
   sqlite forwarder, and gets a test in `test/contract/` — the only place a behaviour proven on one
   backend is proven on the other. Plugin SQL passthrough is dialect-specific by design. Postgres
   `routing.version()` is read-behind (interface sync, read async), so cross-process routing writes
   reach a replica through the `routing` pubsub topic wired in `app.ts`, filtered to other nodes so
   own writes still patch rather than rebuild.
8. All outbound provider HTTP use `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` and `/descriptors` must stay leaves: pure `packages/router` import
   `descriptors`, and leaf property is what let it. `packages/providers/test/leafSubpaths.test.ts`
   pin both.
10. Catalog pricing give defaults. Router price from saved targets; catalog edits hit new targets
    only.
11. CLI administer local installs through `@omni/control`, never `/api/*`. Inject every side effect
    so tests never start processes or write outside temp dirs.
12. Dashboard call `/api/*` only — including the one WebSocket, `/api/stream`. One exception:
    `/health`, polled to watch gateway leave and return across restart, when no session exist to
    probe. May import `@omni/store/types`, `@omni/ir`, `@omnigateway/dashboard-sdk`, but **not**
    `@omni/providers` — no subpath, not even leaf ones: a provider loaded from `<root>/plugins/`
    exist only at runtime, so a console importing providers can route to a plugin provider while
    showing it nowhere. Mirror wire shape in `api/types.ts` like `PluginCatalogEntry`; never import
    it back. `ProviderId` come from `@omni/ir`, but provider list, order, label, colour, models all
    come from `GET /api/catalog`, and `theme/tokens.ts` hold no provider list. Shell gate in
    `routes/_app.tsx` resolve catalog in `beforeLoad` **after** session check and before any screen
    mount, so `--p-<id>` exist at first paint. Gate is all-or-nothing, so its `errorComponent`
    render error **with retry** — never spinner, never blank — and must not swallow `redirect` an
    expired session throw. Pinned by `apps/dashboard/test/routes/appGate.test.tsx`.
    SDK is permitted because it hold the one copy of what may leave a plugin's own API prefix, the
    LIVE switch, and `usePluginChannel`. That hook compose `plugin:<id>:<name>` from the `pluginId`
    it is handed — **ergonomics, not boundary**: a panel spelling another plugin's topic by hand is
    authorised, since `authorised` grant admin every opened plugin topic, and a panel bundle already
    run in the console's page with the operator's cookie. It ride `LiveContextValue.channels`, not
    a second context and not `LiveConnection` (rebuilt per transition to defeat
    `useSyncExternalStore` identity bail-out, so a subscribe on it re-subscribe every reader on every
    drop). `channel.ts` import React and hold no `createContext`;
    `packages/dashboard-sdk/test/package.test.ts` pin both the allowlist of React-importing modules
    and the rule that exactly one module create a context. SDK is in `SHARED_IMPORTS` — one copy for
    console and every panel — because an SDK holding a context but bundled per plugin give each its
    own `createContext`, and a panel reading that one find no provider, take "polling off" default,
    never poll again, silently. Never ship half.
13. `packages/rtk` stay pure like `ir` and `router`: no I/O, clocks, randomness. Rewrite tool-result
    content only, preserve errors + non-tool-result blocks. `@omni/rtk/catalog` is leaf holding
    filter-id union; `@omni/store` import that subpath alone. `packages/ponytail` sit beside it
    under the same rule — the other pure dispatch-time request transform — and **return a new
    request** rather than edit the one handed. `@omni/ponytail/catalog` is leaf holding the mode
    union; `@omni/store` import it alone and re-export `PonytailMode` from `@omni/store/types`.
    Ruleset text **vendored and pinned**, never fetched: a prompt that change under an installation
    is one no operator can reproduce a bill from.
14. `packages/coord` stay pure same way: interface + memory impl, `now` a parameter, the one timer
    it own is the mutex wait. Invariant every impl must hold: a claim is visible to every concurrent
    claimant **at call time, before the promise settle** — memory impl mutate then return
    `Promise.resolve`. Consumers rely on it: `rateLimit.ts` raise `deciding` and claim before its
    first yield; `loadRegistry.ts` keep a synchronous local map and read the shared gauge only
    through `refresh()` before rank (burst test in `dispatch.test.ts`). Thread `coord` through
    **all** of a call graph; `apps/gateway/test/cluster/sharedCoord.test.ts` stand up two route
    trees over one memory coord and fail on any site still reading a module-scope map. Refresh
    serialisation is three layers — local `inFlight` map, `coord.mutex`, and the **re-read** behind
    the lock — and the re-read is the dedup. Long windows (`5h`, `1w`) are `coord.buckets`, seeded
    from `usage.sumBuckets` under a lock; **`add` on an unseeded key is a no-op** (two tests named
    "before the seed" pin both directions). Background loops run under `coord.lease` via
    `underLease`; the heartbeat keep a process's pending rows out of another's `sweepPending`. Every
    push frame go out through `coord.pubsub` and come back in through the subscription — own
    included — so there is one delivery path. `stream()` take `seq` from `coord.incr`; ring `push`
    accept that seq and drop a frame behind its head. Plugin channels are pod-local by construction.
    Redis impl live in `apps/gateway/src/coord/redis.ts` (host own transport); every primitive is
    one Lua script, `attempt()` decide fail-open per table (proxy-path primitives fall to an
    embedded memory coord, `lease` false, `mutex` throw, `kv` refuse `OVERLOADED`), logged through
    the closed `LogFields` keys `coord`/`coordFallback`. Client quirks (`connect()` never reject,
    `onclose` never fire on kill, `SCRIPT LOAD` then `EVALSHA` ordering) documented in that file's
    comments and the spec's History. `complete()` in both usage repos is a **claim** — `ON CONFLICT
    DO UPDATE … WHERE state = 'pending'` — so a row swept as dead and then completed by its owner is
    billed once. Remote routing changes arrive as the `RoutingChange` over the `routing` topic and
    go through `snapshots.applyRemote`. Contract suite run against real Redis when
    `OMNI_TEST_REDIS_URL` set (CI: `valkey` service); `test/cluster/sharedCoord.test.ts` run the
    two-replica suite over two **separate** Redis coords. Design:
    `docs/superpowers/specs/2026-09-02-horizontal-scaling-design.md`.
15. `packages/ratelimit` stay pure same way; `now` always a parameter, counters supplied by caller.
    `@omni/ratelimit/catalog` is leaf holding dimension + window unions, `LimitConfig`, its zod
    schema; `@omni/store` import that subpath alone and re-export `LimitConfig`. Limiter state —
    rings + gauges — live in `apps/gateway`. `@omnigateway/plugin-api/events` **mirrors** the unions
    and `WINDOW_MS` rather than importing them (published vs not); mirror pinned by
    `apps/gateway/test/plugins/limitVocabulary.test.ts`, the only place that may import both.
16. Plugins load from `<root>/plugins/` at boot, receive capability-scoped `PluginContext`: never
    `Store`, `HttpClient`, `AdminAuth`, `process.env`. **It is a guardrail, not a sandbox** — plugin
    share gateway's process and can import past all of it. What it buy: accidental overreach
    impossible, intent auditable from manifest. Say that plainly wherever it come up.
    **One real exception: a plugin supplying a provider receive the decrypted credential for its
    own provider.** `codec.buildRequest` get `{accessToken, apiKey, providerData}` from
    `credential.openForInference()`, and its `oauth` flow reach the same class by a second door:
    `refresh` receive the decrypted refresh token and `usage` the access token through
    `UsageSecrets`. Bounded three ways: router only produce candidates for that codec's own
    provider id and the refresher only hand a credential to its own provider's flow; neither codec
    nor flow hold the client or the store; every URL either one name is checked against the
    manifest's `origins`.
    `packages/plugin-api` stay pure like `ir`; loader, context, event bus, channel registry live in
    `apps/gateway`. Every load failure skipped and reported, never fatal: proxy path depend on no
    plugin. `channels` capability give plugin `open(name)` and nothing else — never a socket,
    upgrade request, header or `Principal`. Topic is `plugin:<id>:<name>` with `<id>` from
    validated manifest, same rule `{{name}}` follow for tables. Registry answer what **exist**;
    `authorised` in `routes/stream.ts` decide who may hold it. Outbound frame reuse socket
    registry's bounded per-connection queue.
17. **No provider-specific code in a core module** — aim, not achieved state, measured per package.
    `ratelimit`, `rtk`, `ponytail` clean. `ir`: only `LogFields.surface` (`"anthropic" | "openai"`),
    permitted vocabulary. `store`: `bodies/mask.ts` hold the `xaiKey` rule and vendor key prefixes
    on purpose (redaction paragraph below). `router`: `resolve.ts` exclude `custom` from prefix
    routing, because a bare model name cannot carry an endpoint id. `control`: `schemas.ts` name
    `custom` in the one rule surviving its target union (custom target carry an `endpointId` and
    nothing else may), and `credentials.ts` plus `models.ts` ask `=== "custom"` about endpoint
    metadata. That is all.
    **OAuth is out of core.** `OAUTH_PROVIDERS` is an empty null-prototype registry that
    `registerOAuthProvider` fill; five vendor modules live at `providers/src/<id>/oauth.ts`;
    `builtinOAuthFlows()` in `@omni/providers` is the one list. Do not re-add a literal.
    `seedBuiltinOAuth()` fill it from **`installPluginProviders`** on the gateway (called
    unconditionally at boot, reachable from a harness — `main()` is called by no test) and from
    `apps/cli/src/run.ts` on the CLI. Registry is **threaded**: `registerOAuthProvider`,
    `seedBuiltinOAuth`, `installPluginProviders` all take one, defaulting to the global, because a
    guard reading module-global state passed on another test file's seed. Thread it through **all**
    of a call graph or none. Idempotence is a `WeakMap` of which id we installed into which registry
    (a `WeakSet` of registries made a deleted built-in unrecoverable); repair restore membership,
    not position. Seeding late is safe because every consumer read the registry at call time and
    `loadPlugins` register no flow; a loader that ever register one move the seed ahead of it.
    `installPluginProviders` must stay **unconditional** — `if (providers.length > 0)` kill OAuth
    on every plugin-less install; `oauthSeed.test.ts` catch it by asserting the call sit at
    two-space indent in `main()`. Seed **order is the operator-facing order** — anthropic, openai,
    kimi, kilo, grok — because `oauthProviderIds` derive from `Object.keys`;
    `apps/cli/test/connect.test.ts` match it by equality and
    `apps/gateway/test/plugins/install.test.ts` pin it as a literal. Never pin it against
    `builtinOAuthFlows()`. Registry empty until seeded, so any test reading it **seed first**.
    Contract live in `providers/src/oauthFlow.ts` with `oauthRequests.ts` and `oauthUsage.ts`;
    `@omni/providers` carry `@omni/store` **type-only** (`import type` from `@omni/store/types`),
    enforced by `packages/providers/test/oauthStoreEdge.test.ts` — not by `leafSubpaths.test.ts`.
    Host keep the mechanism — `pluginFlow.ts` (`oauthAdapter`), `pending.ts`, `refresh.ts`,
    `pkce.ts`, `lead.ts`, `types.ts` — because the adapter hold transport, origin check, yield cap,
    return-shape validation, and stamp `gatewayAuthored`. Each flow step is an `async function*`
    yielding described requests, host perform every one, yield **capped** per step; `fail`,
    `keepPolling`, `pkce`, `randomState` supplied by host. `AuthRequest.timeoutMs` optional, clamped
    to host ceiling (built-ins use 30s token / 15s usage). `PluginOAuthFlow` is a discriminated
    union with `oauthAdapter` overloaded on `kind`. `requests.ts` hold pure builders that replaced
    `postJson`/`getJson` — deleted so nothing can bypass the adapter. Provider OAuth tests stay in
    `control/test/oauth/`, reading the five via `test/oauth/builtins.ts` off the seeded registry.
    History: decoupling spec.
    New provider knowledge in core go through three outcomes, in order: **descriptor data**; **make
    the value carry its own provenance** so the branch delete; **a named extension point** from the
    closed set. `providerNative` is the worked example: tagging the block with its producing
    provider deleted `needsAnthropicNative`, `ANTHROPIC_NATIVE_TOOLS` and the table in the router.
    Hook set is **closed**. `LogFields` never extensible. Core cannot scan providers
    (`packages/providers` import `@omni/ir`; reverse is a cycle) — injection is the only direction.
    **Redaction never becomes extensible**: `MASK_RULES` in `packages/store/src/bodies/mask.ts` keep
    vendor rules in core; a descriptor-supplied regex is a provider deciding how much of its own
    secret survive. `PREFIXED_KEY` and `OPAQUE` already catch ordinary key shapes.
    Core keep provider-shaped **vocabulary**, not logic: `ErrorCode`, `LogFields`, `StopReason`,
    `CacheControl.ttl`, `AuthType`, `WindowType`, `surface`, `AnthropicToolFamily`. A provider
    needing a new member edit core, by design.
    Trap: `autoCache` is **one boolean across six core files** — `providers/types.ts`,
    `store/types.ts`, `control/schemas.ts`, `dispatch/index.ts`, `dispatch/attempt.ts`,
    `SettingsBoard.tsx`. Design:
    [core/provider decoupling](docs/superpowers/specs/2026-08-27-core-provider-decoupling-design.md),
    [descriptor registry](docs/superpowers/specs/2026-08-26-provider-descriptor-registry-design.md).
18. **`Principal` and `Scope` in `@omni/control` are the only copy of "who is asking" and "what may
    they read".** Four principals — `admin`, `viewer`, `client`, `machine` — share **one cookie**,
    so `AdminAuth.verify` return the principal, never a boolean. `stream/registry.ts` re-export the
    union. Guards are **opt-in per route**, never applied to a group: `requireAdmin`,
    `requireReader` (admin|viewer), `requireClient`. A GET nobody remember to widen stay admin-only,
    the harmless way to be wrong. Mutations, snapshot download, `/api/connect/*` and `/api/plugins`
    stay `requireAdmin`.
    Trap: `scopeOf` mapped `machine` to `{kind:"key", apiKeyId:""}` meaning "matches nothing", but
    **`usage_daily.api_key_id` is `NOT NULL DEFAULT ''`**, so that scope read every untagged row at
    the `daily` grain while `request_logs.api_key_id` (NULL) hid it at `raw`. `Scope` now carry a
    `none` arm and `readsNothing` gate both readers **before** `scopeKey` — which collapse `all` and
    `none` to the same `undefined`. Client surface own no body route: **absent, not refusing**.
    Design:
    [client dashboard surface](docs/superpowers/specs/2026-08-27-client-dashboard-surface-design.md).

## Adding a provider

Nine-step procedure in [docs/adding-a-provider.md](docs/adding-a-provider.md). Read before adding
one — several steps exist because skipping them made bugs that read as something else.

## Writing a plugin

Procedure in [docs/writing-a-plugin.md](docs/writing-a-plugin.md): manifest, capability context,
storage placeholder, event guarantees, how UI bundle share console's React. It open with what plugin
can reach, which decide whether rest of it good idea.

## TypeScript and dashboard style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, tests included. Use `unknown` plus narrowing or named types.
- Use ESM imports with explicit `.ts` extensions. Match nearby naming + comment density.
- Biome use 2-space indent, 100-column lines. Avoid unrelated refactors.
- Dashboard use styled-components, never Tailwind or CSS files.
- Palette CSS variables live in `theme/GlobalStyle.ts`; `theme/tokens.ts` reference them.
- Colour mean provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores, synthetic credentials, stub `HttpClient`; never call live providers.
- Dispatch or adapter changes cover streaming + non-streaming paths.
- Preserve pre-commit failover versus post-commit stream behavior.
- Shared proxy changes test Anthropic + OpenAI error surfaces.
- Auth changes cover Bearer and `x-api-key`, malformed/conflicting input, revoked keys, allowlists,
  relevant rate limits.
- Deadline tests distinguish gateway timeout from client cancellation, leave no timers/listeners.
- Dashboard tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`,
  `renderWithRouter`; assert visible text, roles, accessible names. Re-query after async loads.
- **Do not add one test per call site of a threaded registry** — they go stale the day a new site
  appear. Inject a sentinel registry holding one synthetic provider and none of the six, and assert
  a real request end to end; any consumer reading module-global fail loudly.
  `apps/gateway/test/dispatch/dispatch.test.ts` hold it and kill all four threading mutants alone.
  It need two dispatches: a **configured** model short-circuit `resolveModel` before any registry is
  read, and an **inferred** target is priced from `PROVIDER_MODEL_CATALOG`. Same instrument as
  `providerTables.test.ts`, which discover leaking tables rather than listing them.
- **A drift check reading repaired history cannot fail.** `publishable.test.ts` ask git what moved
  since last tag; query live in `packages/plugin-api/test/helpers/changed.ts` and `changed.test.ts`
  ask it of scratch repositories, no-edit case first. Watched set include `package.json`; diff take
  **one ref**, never `${ref}..HEAD` — two-dot compare commit to commit and miss the working tree.
- **A check gated on `merge-base(main, HEAD)` fail on `pull_request` and is vacuous on `push`.**
  `actions/checkout` never create `refs/heads/main`, and on `push` to main `merge-base` is HEAD.
  Base resolve through `main` or `origin/main` and fall back to **first parent** when HEAD is the
  base. One copy in `scripts/lib/history.ts`, tested in `scripts/test/history.test.ts`.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- `LogFields` is closed allowlist + redaction boundary. Treat new free-text fields as security
  changes; never add index signature. `fields?: LogFields` did **not** enforce it — excess property
  checking apply only to a fresh literal, so `{ plugin, ...(cond ? {} : { detail }) }` and passing a
  wider object both compiled. `Logger` methods now take `<T extends LogFields>(msg, fields?:
  OnlyLogFields<T>)`, pinned by `packages/ir/test/logFields.test.ts` with `@ts-expect-error`.
- **`GatewayError.gatewayAuthored` is the second half of that boundary, opt-in on purpose.**
  `reasonField` withhold a failure's message from stdout unless debug is on, because `httpError`
  fill one from up to 500 characters of an upstream body. Inferring it from `provider !== undefined`
  broke the moment codec errors named their provider: a plugin codec throwing on every request
  logged `code=UPSTREAM` with no reason. Flag default **false**; set it only for a message built
  from literals and values this repository own — never one carrying an upstream body, never one
  authored outside this repository (`rebound` not set it, `codecFailure` do). It must survive
  re-wraps: `classify` and dispatch's `rewrap` both rebuild the error.
- Return raw gateway API keys once; store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows and
  the two password routes, which end sessions **by design**.
- **Two passwords, neither with a default.** Admin password set at `/api/setup`, replaced at
  `PUT /api/settings/password` — require the **current** one, because an unattended cookie that
  rewrite its own credential turn "left tab open" into "locked out". Success clear **every**
  session, caller's included; console send operator to `/login?reason=password-changed`. Wrong
  current password answer exactly like a failed login. Viewer password is **optional and absent by
  default**: no row, `passwordMatches(null, …)` refuse everything, `viewerConfigured` false.
  `PUT /api/settings/viewer-password` set/replace it; `{"password": null}` withdraw it and
  **delete** the row; absent field is `BAD_REQUEST`. Setting or clearing it drop **viewer**
  sessions only.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, errors
- `POST /v1/responses`: OpenAI Responses-compatible. **Stateless**: `previous_response_id`,
  `item_reference` and explicit `store: true` are refused, not normalized away; `background: true`
  is dropped. Keepalive under five seconds — Codex's HTTP client abandon a connection silent for
  about that long.
- `GET /v1/models`: authenticated, filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

`/api/client/*` is the key holder's own read surface: `login`, `logout`, `summary`, `usage`, `logs`,
`quota`, `quota/history`. Scope come from the verified session, never a query parameter — the two
arrive as separate arguments because they have separate provenance. Client session re-read its key
row on **every** verify and refuse a revoked one.

Provider quota reach a client as **named accounts**: `accountQuota` return one row per
credential+window carrying the operator's `label`, deliberately. `usedRatio` and
`ratePerHourRatio` are fractions in `0..1`. **The ceiling behind them is derivable, and that is
accepted, not defended** — `usedRatio` is an exact quotient recoverable by continued fractions, and
`exhaustsAt` give a second way. Rounding was tried and does not work; never reintroduce it and claim
size is withheld. `stale` and `rolledOver` stay separate booleans — folding them blank a chart for
a poll interval after every rollover. `/api/client/quota/history` carry **no gateway rate** (that
aggregate cover every key). `clientSurface.test.ts` hold both halves: no credential identity on
`logs`/`usage`/`summary`; quota routes name accounts and omit `used`/`limit`/`ratePerHour`.

Every `/v1/*` request accept Bearer or `x-api-key`; reject conflicts. `null` model allowlist mean
unrestricted; empty array deny all models.

Translation invariants:

- Keep mid-conversation system messages in place; never fold into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve + accumulate Anthropic signatures.
- Outbound: OpenAI surface render canonical thinking as `reasoning_content` (stream deltas and
  non-streaming field); Anthropic surface keep its dialect, unsigned blocks suppressed.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize missing beta.
- `ToolDef` discriminant is `kind`: `"portable"` or `"provider"` plus a real `ProviderId`.
  `ProviderToolDef` is the provider arm; `AnthropicToolDef` is a **narrowing** requiring `family`.
  `AnthropicToolDef` carry exact versioned `type`, never normalized or upgraded; versions in
  `packages/providers/src/anthropic/tools.ts`; unknown dated types rejected, not prefix-matched.
- Provider-native content blocks use `providerNative` IR variant, keep payload verbatim, stay out
  of tool-id correlation, orphan removal, cross-provider translation, RTK. Block carry `provider` —
  who produced it — and routing read that field.
- Provider-defined tool or `providerNative` history block admit **only** that provider's targets at
  routing. OpenAI hosted tools (`tool_search`, `web_search`, `local_shell`) pin from turn 1; OpenAI
  reasoning items come back from upstream and are replayed, so a Codex conversation pin from
  turn 2. Degradation spelled `excluded:capability:providerNative`; old rows carry
  `excluded:capability:anthropicTools` and stay readable — degradations are forensic text never
  parsed. Redaction of `credentialId` there read `Excluded.kind`, never the string.
- **A breakpoint on the request's final mid-conversation system turn must leave that turn**, moved
  by `systemCacheControl` + the retarget in `toWire` onto the last cacheable block *before* it
  (`lastCacheableHistoryBlock(body.messages.slice(0, -1))`). Such a turn is a directive the client
  re-emit every request, so it sit at a different position next request and a prefix ending inside
  it is never a prefix again. Measured: marked on the trailing turn read **0** every request;
  moved one block back, read 13,896. Hoisting to request-level `cache_control` behave identically
  (dead). Mixed system turn (block array) get its own copy of the marker **stripped**. Recorded
  `anthropic:system-turn-cache-control-retargeted`; skipped when target already carry the client's
  own marker. Numbers and the $70.53 day: auto-cache spec History.
- `pauseTurn` is own stop reason; never fold into `endTurn` or `toolUse`.
- Client tool names renamed to PascalCase on Anthropic **OAuth** leg only, restored in
  `anthropic/decode.ts` — never at egress. Anthropic fingerprint some name sets and refuse them
  through a billing placeholder; `FINGERPRINT_REFUSED` name that. Restore site load-bearing: RTK
  normalize by case and separator alone, so an egress-side restore silently degrade every shell
  classification. Cloak live in `buildRequest` frame, never on `dispatchRequest` — shared across
  attempts. Exempt names (already PascalCase, or `mcp__*`) reach wire unrenamed and **claim their
  spelling**.
- Unknown Anthropic block types + SSE events fail visibly, not skipped.
- Preserve cache-control breakpoint block, TTL, order when target can express them. Record
  degradations for requested features provider cannot express. **Two exceptions, and only two:**
  - `autoCacheEnabled` (default **on**) let Anthropic adapter add breakpoints to a request carrying
    **none**. Fire only when `estimateCachedInputTokens` is 0 *and* no `cache_control` in vendor
    bag. Up to **three** markers, one rule: walk tiers in render order — last tool, last system
    block, last cache-eligible block of wire history — and place a marker when that prefix beat the
    **last placed marker's** prefix by ≥1024 (running comparison start at 0). Last *placed*, not
    previous tier. Gating each marker on its own prefix was wrong: prefixes are monotone, so gate 1
    implied all three. Same rule cover `OAUTH_IDENTITY` (~15 tokens) — **never add a check naming
    that string**. Marker 3 walk `body.messages` **backwards, never `req.messages`** (flatMap drop
    turns of unsignable reasoning, so indices differ); skip string content and block types outside
    text/image/tool_use/tool_result/document. Write to wire body only, never IR — IR shared across
    attempts — pinned by a deep-frozen fixture in `packages/providers/test/anthropic.test.ts`.
    Recorded `anthropic:cache-breakpoint-added` (marker 1 or 2),
    `anthropic:history-cache-breakpoint-added` (marker 3). Design:
    `docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md`.
  - `ponytailMode` (default **off**) let dispatch append the vendored ruleset to `system` and
    **move** a breakpoint the client put on its own last system block onto the appended block:
    marker meant "cache through end of system" and still do — count, TTL unchanged, no marker
    invented. It edit a marker's *position* alone, on IR in dispatch, so
    `estimateCachedInputTokens` stay non-zero and autoCache still decline; moving a marker must
    never become a way to switch autoCache on. Injection **return a new request**, pinned by
    deep-frozen fixture in `packages/ponytail/test/inject.test.ts`. Dedupe on `PONYTAIL_MARKER`.
    `count_tokens` apply the same function by hand. Recorded on `request_logs.degradations` as
    `ponytail:<level>`, `ponytail:already-present`, `ponytail:cache-marker-moved`,
    `ponytail:cache-marker-not-last` — constants only. Last one is the shape the move cannot help
    (client marker on a non-final system block; ruleset billed fresh, ~1,240 tokens). Text vendored
    from upstream tag **v4.9.0**, blob `a3e4d94b…` — pin the blob. Design:
    `docs/superpowers/specs/2026-08-29-ponytail-prompt-injection-design.md`.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes are disjoint classes priced
  once. Use `promptTokens()` when client surface need total prompt tokens.
- Adapters stream upstream. OpenAI chat usage need `stream_options.include_usage`; Responses API
  report usage on `response.completed`.
- `/v1/models` report smallest target window in pool. Limits advertised, not enforced.
- Normalize `[1m]` before key allowlist checks. `claude/` **not** reserved and not rewritten.
- Gateway not validate request-shape support per model; unsupported combos surface as upstream
  errors.
- **`ChatRequest.conversationId` is the client's own name for its conversation, and the Codex
  backend partition its prompt cache by it** — measured 0 of 5 cache reads without a session id,
  14 of 15 with one. Arrive as Anthropic **`metadata.user_id`**: opaque free text (Claude Code send
  a 96-char JSON string whose nested `session_id` make it conversation-scoped); ingress **not**
  parse it. Only **conversation**-scoped ids may be used — OpenAI's `user` name the human and is
  read nowhere. `readConversationHeader` in `ingress/schemas.ts` hold the header list, checked
  **after** the body field, case-insensitive: `x-session-id`, `x-session-affinity` (opencode),
  `x-deepseek-harness-session-id` (dsh), `session-id` (Codex). Derived fallback (hash of
  instructions plus opening item) rotate several times per conversation; do **not** hash tool list
  or first message, and a gateway-generated id collapse into the same fallback. `openai/wire.ts`
  resolve one key — client `prompt_cache_key`, then client `session_id`, then `conversationId`,
  then the hash — **before** the vendor `Object.assign`, and `openai/codec.ts` put the **same**
  string in the `session_id` header (OAuth leg alone; `api.openai.com` take the body field).
  `"session_id"` sit in `openaiProfile.order`. Both non-client cases are hashed, for two reasons:
  derived case is a hash by construction; `conversationId` is hashed for **privacy** — it arrive
  beside `device_id` and `account_uuid`. `store: false` is **required** (Codex 400 otherwise). When
  checking what a client send, print the key set, not one member. History: responses-ingress spec.
- OpenAI surface read images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as from `content`. Payload's own container header beat any
  declared type, and remote URL never fetched. `images` is Ollama's images-only field, so a
  non-image there is `BAD_REQUEST`; `attachments` is the SDK's general envelope, so PDF or hosted
  URL is dropped, never refused. Same reasoning as `looseCacheControl`.

Detailed compatibility rules + measured client behavior belong in `docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_BASE_URL` must be public reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidate
  stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > install in cwd > `~/.config/omnigateway`. Root
  `.env` intentionally override ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  the root. A `--root` flag suppress ambient `OMNI_DB_PATH` entirely (Bun preload cwd's `.env`);
  suppression warned on stderr, reported by `doctor`, removed from env spawned gateway inherit.
  `OMNI_ROOT` not suppress it: both ambient.
- Quota cooldowns, `1m` and `concurrency` are process-local, reset on restart; `5h` and `1w` come
  from database and survive one.
- `usage.append` must run at most once per request ID; duplicate completion double-count
  `usage_daily` and `usage_rollup`. Pending rows hold placeholder metrics; inspect `state`, not
  `status`.
- `usage_rollup` derived, never authoritative: `request_logs` is source of truth and `rebuildRollup`
  reproduce every bucket. Written in `append`'s transaction, pruned with rows it summarizes, rebuilt
  after restore, compared by `omni doctor`. It replaced an unbounded `SELECT SUM` — `bun:sqlite` is
  synchronous, so that scan blocked the whole event loop. Same reason a timeout around store read
  cannot fire; do not add one back.
- `quota_windows` store provider observations, not gateway counts. Missing data mean unknown, not
  unlimited. Probe failure must never disable credential.
- `quotaRolledOver` (single-copy rule above): between a rollover and the next probe — up to
  `quotaPollIntervalMs`, 300_000 default — newest reading count a window that no longer exist and
  every staleness check report it current. Null `resetsAt` is **not** rolled over. Rollover suppress
  the **inference**, never the measurement: `burnFor` drop `ratePerHour`, `exhaustsAt`, `survives`
  but **keep `windowStartsAt`** — suppressing it too make `spanStartOf` null and blank a chart of
  real readings for a poll interval. Surfaces phrasing both verdicts say **staleness first**.
- Projection line **truncate at the ceiling**, never overshoot: `ratePerHour` is whole-window
  average, enormous in the minutes after rollover. `projectedPace` move endpoint to the instant the
  line reach 100% — same instant `exhaustsAt` name. `usedPercent` capped at 100. Fact read "100% of
  limit before it resets", not "160% by reset".
- RTK filter ids persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is storage contract.
  `isRtkFilterId` drop unknown ids on read. Add ids freely; rename or remove only with migration.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are JSON keys of `api_keys.limits` —
  storage contract failing **closed**: unknown name is parse failure. Rename or remove only with
  migration, and update mirror in `@omnigateway/plugin-api/events` in same change.
- Rate limiting explained in `ARCHITECTURE.md#rate-limiting`; invariants below each already broken
  once.
- **Nothing a plugin imports may reach a core package.** `@omnigateway/plugin-api` and
  `@omnigateway/dashboard-sdk` published; every `@omni/*` not, so one import put unresolvable
  `workspace:*` into a stranger's tree — and it typecheck green here.
  `packages/plugin-api/test/bundleWeight.test.ts` build each entry point and assert zod appear only
  under root; first test assert zod *is* present there, because "absent" is also what a broken
  harness report.
- **The range one published package put on the other is never resolved in this repository.**
  `dashboard-sdk` carried `@omnigateway/plugin-api: ^0.1.0` past that package's move to `0.2.0`, so
  every `bun add` of the SDK resolved generation 1 against a gateway refusing `api: 1`. Repairing the
  range fix nobody: release step skip a package whose **version** not moved. `publishable.test.ts`
  walk the pairs and watch `package.json` beside `src`.
- **`SAFE_PROVIDER_ID` in `apps/dashboard/src/theme/tokens.ts` mirror `PROVIDER_ID_PATTERN`, and
  `providerColor` is where a stored string become CSS.** styled-components not escape
  interpolations, and `credential.provider`, `target.provider`, `log.resolvedProvider` never pass
  `/api/catalog`; `sqlite/config.ts` parse `virtual_models.targets` with bare `JSON.parse`. Check
  live in `providerColor`, not the four call sites. Pinned by
  `apps/gateway/test/routes/providerIdMirror.test.ts`. Reference carry
  `var(--p-<id>, var(--ink-faint))`.
- `admit`/`consume` claim ring stamp and gauge **synchronously**, before any `await`, and roll back
  on refusal — ceiling of 3 once admitted 10 parallel requests.
- Refuse at auth, degrade at list. Unparseable `limits` read back as `null`, distinct from `{}`, and
  `authenticateApiKey` turn it into `INTERNAL` — not `AUTH`. `keys.list()` must never throw over
  such a row. Nothing may collapse that `null` into `{}`.
- Two fields editable after minting: `limits` (`setKeyLimits`, `PUT /api/keys/:id/limits`) and
  `modelAllowlist` (`setKeyModels`, `PUT /api/keys/:id/models`). Both written whole, never patched —
  `{}` is how last limit go away; allowlist `null` and `[]` are opposite facts, so schema refuse
  default. `bodyLoggingOptOut` deliberately not editable — a promise to whoever hold the key.
- Windows *slide*. `1m` is exact ring in `apps/gateway`; longer windows are `usage.sumSince` —
  which must filter `state = 'done'` — plus in-memory delta, cached 30s. Composition may over-count
  and must **never** under-count, so delta keep everything at or after read instant. Failed
  `sumSince` serve the request and log through existing `LogFields` keys, degrading long windows
  only.
- Token and spend debit live in `finishLog` beside `usage.append`, never inside `@omni/store`: that
  site already run at most once per request id.
- Concurrency gauge released at request scope and nowhere else. Streaming handler return while
  request still run, so `finally` around handler body fire at head-send; streams free it from
  `sseResponse`'s run-once completion. No window expire a gauge — leak lock the key out until
  restart.
- `ApiKeySummary.limitUsage` count committed rows only: floor on what limiter see.
  `concurrency.used` is `null`, not `0`.
- `Target.credentialId` pin one account to one target — **filter state, not strategy**. No
  `"pinned"` strategy exist and none should be added. Pin is **hard**: disabled, breakered,
  rate-limited or quota-spent pinned account fail the request, never spill.
  `pin:missing` emitted **once per target**, only when no account resolve; accounts the pin exclude
  are skipped silently. `pinSeen` declared **per target, inside the target loop**, set **before**
  any `drop()`. All three guards are `continue`, so order cannot change membership — what order
  decide is whether `pin:missing` fire; the mutation that widen membership is making an earlier
  guard conditional on the pin.
  Nothing validate the pin at write time (removing an account must not make unrelated edit
  unsavable); `omni doctor` carry that weight and must resolve through `resolvePin`. Control schema
  refuse `""` and bound it to 64 chars of `[A-Za-z0-9_-]` **on both arms of the union**, because
  `pin:missing` carry it into `LogFields.credentialId` untruncated; dashboard **omit** the field
  rather than send empty. `sqlite/config.ts` read targets back unvalidated, so a restored database
  bypass the schema. Format not pinned to `crypto.randomUUID()`.
  Console draft clear the pin on provider **and** endpoint change (`retargetDraft`,
  `reEndpointDraft`), never on model change — **draft behaviour only**; `PUT /api/models/:id` and
  `omni models put -f` save a pin under a changed provider, and `doctor` report it.
  `resolveModelLimits` describe a pinned target by its own account's auth; unresolvable pin fall
  back to provider-wide narrowing, **never** catalog figures (`setup.ts` persist that number into
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`). `unreachable` in `putModel` check the pinned account's auth
  alone and is **deliberately not grandfatherable** — `pairOf` stay keyed on provider+model, so
  clearing a dangling pin is never refused. `modelLimits` resolve pin from **enabled** credentials,
  `models.ts` from existence, same split `heldAuths` make.
  Both surfaces that remove an account name the models pinned to it **before** the confirm; console
  treat an unanswered `useModels()` or empty credential list as unknown, never as no pin.
- `provider:missing` follow the pin rule exactly: **once per target**, `kind: "target"`,
  `credentialId: ""`, the **first** guard in the target loop. Dispatch's `INTERNAL "no adapter for
  provider …"` stay a throw: reaching it mean the router admitted what it should have excluded, and
  `deps.adapters` is a separate injection point from the descriptors.
- **Format and existence are two questions.** `providerIdSchema` check format alone and gate
  **credentials**: `createApiKeyCredential` parse it, then ask `isProviderId`. `catalogModelAuths`
  answer "every way in" for an unknown provider. **A target naming any well-formed provider id
  save** — `targetSchema` take `providerIdSchema`, existence checked nowhere on that path, same
  exemption a dangling pin have; `provider:missing` and `omni doctor` carry the weight. One rule
  survive the old enum: **a `custom` target require an `endpointId` and nothing else may carry
  one**.
- `ProviderModelChoice.auth` enforced at write time in `putModel`, never at routing. Catalog export
  the fact (`catalogModelAuths`), control own the rule. Provider with no credential is unknown,
  unlisted model unknown, disabled credentials count, stored target under that id exempt.
- **`ProviderId` is a validated string, not a union of six.** Five tables key on it —
  `PROVIDER_DESCRIPTORS`, `ADAPTERS`, `PROFILES`, `BODY_ORDER`, `PROVIDER_MODEL_CATALOG` — each a
  hand-written literal; only `PROVIDERS` is derived. Delete a built-in's line and **typecheck
  pass**. What catch it is lint (unused import) and
  `packages/providers/test/descriptor.test.ts` (key-set equality against literal `IDS`) — never
  the compiler; if the guarantee need to be stronger, derive the table. Lookups keyed on a
  **stored** id are partial and `noUncheckedIndexedAccess` make each a compile error at the point
  of use; do not cast it away. `PROVIDER_ID_PATTERN` in `packages/providers` is the source;
  `packages/control/src/catalog.ts` read it. Four other copies validate a **plugin** id
  (`packages/plugin-api/src/manifest.ts`, `apps/gateway/src/plugins/routes.ts`,
  `packages/control/src/plugins.ts`, `packages/store/src/sqlite/plugins.ts`), pinned by behaviour
  in `apps/gateway/test/plugins/pluginIdGrammar.test.ts` — a failure mean a mirror is stale, never
  that the pattern should widen.
- **Every provider-keyed table drop its prototype.** A provider id arrive from a client's `model`
  name and from unvalidated `virtual_models.targets`, and on an ordinary literal
  `table["constructor"]` read "installed" then throw. `PROVIDER_ID_PATTERN` accept `constructor`;
  `noUncheckedIndexedAccess` cannot see it. Do not add `Object.hasOwn` at readers instead — partial
  protection that read as total is worse than none. **Do not enumerate the tables here**:
  `packages/control/test/providerTables.test.ts` **discover** them by walking the exported surface
  of both packages, and assert the walk found something. Spreading a null-prototype object give an
  ordinary one — use `Object.assign(Object.create(null), …)` — and `.hasOwnProperty()` as a method
  throw; use `Object.hasOwn`. The guard live at the **read site**, `dispatch/index.ts`, not
  `app.ts`: `DispatchDeps` and `ProxyDeps` are public injection points. Console cannot import
  `@omni/providers`, so `heldAuths` restate the rule with `Object.create(null)` and its own test.
- **A registry threaded into some of a call graph and not all is this repository's most repeated
  bug, and it is the sweep that keep failing.** Sentinel-registry test (Testing section) is the
  guard; history in the decoupling spec.
- **A module-scope `Object.keys`/`Object.entries` over `PROVIDER_DESCRIPTORS` is a build-time
  snapshot**, and `loadPlugins()` run long after import. Six sites were wrong this way
  (`providerCatalog`, `providerIdSchema`, `isProviderId`, `PREFIX_PROVIDER`, `CALLBACKS` — deleted
  — and `OAUTH_PROVIDER_IDS`, now `oauthProviderIds()`). Assume a **seventh** exist until you have
  grepped for the pattern, not the names. `PROVIDER_IDS` still exist and is a snapshot — it feed
  CLI usage messages and tests, never a gate.
- **An `AggregateError` has no message of its own.** Node report failed multi-address connect that
  way, so `error.message` render `reason=` empty and `request_logs` hold no message column.
  `describeError` in `@omni/ir` is the one way to fill that field; `classify` recurse into `errors`
  for the same reason, else retryable transport failure fell through to `INTERNAL`.
- `CONNECT_ATTEMPT_TIMEOUT_MS` must stay above one TCP retransmit: node's Happy Eyeballs budget is
  under Linux's one-second initial RTO, so a dropped SYN was abandoned at ~500ms. Measured: 3
  failures in 99 connects at default, 0 in 212 once raised.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats decoded
  away. Keep server idle timeout above request deadline.
- Socket registry close every connection **before** `app.stop()`, and its `stopLoops` position is
  what make that true. `stop()` called without `true`, so it drain. Close with `1001`; `4401` mean
  "do not reconnect" and is for expired session alone.
- `/health` watcher stay a plain `fetch` poll and must never move onto the socket.
- Elysia call a `.ws()` route's `beforeHandle` **twice**, guarded by `typeof === "function"`, so it
  must be a single idempotent function, never an array. Register a companion plain `GET` on the
  same path, else a browser hit 404 an endpoint that exists.
- `res:*` frame carry at most `{ keys }` and client map **topic to query-key prefix**, never an
  enumerated key list. One exception: `res:logs` must exclude `["logs","body",…]`.
- **`plugin:*` is third class and carry no `seq`, so it can never `gap`.** Console `hold`
  resubscribe **without** `sinceSeq` and SDK `ChannelMessage` carry no `gap` arm. Panels do get
  `open`/`refused`/`closed`, because plugin topic is the one class a principal can be refused.
  Console `hold` is refcounted and unsubscribe on last release — that frame fire plugin's
  `onClose`.
- **A topic name a resource, and every branch reading that resource must be in its entry.**
  `res:usage` and `res:logs` cover both `["usage",…]` and `["client","usage",…]`. Client's key
  summary ride `res:usage`, not `res:keys`. A panel whose topic its principal cannot hold must poll
  with **no** topic.
- **A pushed topic replaces polling, so it must emit on *every* transition of what it covers.**
  `cadence(ms, topic)` return `false` once the socket declare that topic pushed. `res:logs` emit
  from `beginLog`, `routeLog`, `finishLog` — emitter count should match writer count; `res:usage`
  pairing only with `finishLog` is correct because nothing else count tokens.
- Coalescing on `res:*` is load-bearing: uncoalesced push at 100 req/s is 100 refetch per second.
- Stdout hold operational events; `request_logs` hold completed requests. Do not restore duplicate
  per-request access lines. `requestId` join both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` name
  existing capture; it not create one.
- Docker image contain gateway + built console (multi-stage, non-root `bun`, `HEALTHCHECK` on
  `/health`); npm package contain CLI, gateway, dashboard. Kustomize base in `k8s/`; `secret.yaml`
  gitignored, `secret.example.yaml` committed.
- OpenAI OAuth route to narrower Codex surface. OAuth-specific encoding stay behind existing `oauth`
  flag.
- Snapshot is database alone. `request_bodies/` excluded; after restore, body rows and artifact
  files disagree until `sweepOrphans` reconcile them. Snapshot still carry encrypted credentials and
  API-key hashes; downloads are `no-store`.
- Lifecycle and swap rules below explained in `ARCHITECTURE.md#replacing-the-database-while-it-is-open`
  and `#stopping-and-restarting`. Read the section before changing any of them.
- Restart ask systemd, never self-SIGTERM, and `--no-block` required.
- Quiesce latch gate `/v1/*` only; `/api/*` and `/health` stay live through swap.
- `store.close()` idempotent and `reopen()` tolerate closed handle, so restore is close → swap →
  reopen. Repo methods forward per call: bind one to local and it die at next swap.
- **The swap forwarder in `sqlite/store.ts` hand-write one arrow per repo method, and an arrow of
  lower arity still satisfy the interface** — a dropped optional parameter silently become
  `undefined` (`usage.recent` shipped that way and a scoped read returned every key's rows). Adding
  a parameter to a repo method mean editing that arrow; `packages/store/test/swap.test.ts` read the
  forwarder source and assert no arrow drop an argument.
- `vacuum()` must checkpoint, or page count fall while file keep every page.
- Restore compare admin password hash across swap and invalidate sessions only when it differ.
  **Nothing may sit between the swap and that comparison.** `swapIn` rebuild `usage_rollup` last
  and guarded, for that reason; cost documented in `README.md`.
- `omni db restore` refuse while gateway running, no override.
- Plugin tables are `plugin_<id>_<name>`, written by host from `{{name}}`, tracked in
  `plugin_migrations` independent of core's `001..`. Plugin migrations apply **one transaction
  each**. Restore onto install without that plugin leave orphan `plugin_*` tables; `omni doctor`
  report them, **nothing auto-drops them**; `omni plugin remove` keep tables, only `--purge` drop.
- Plugin events are **at-most-once and not durable**. `RequestCompleted` emitted from `finishLog`
  because that is the one site running at most once per request id.
- Plugin channels: client must **subscribe before it send**, else the frame is refused. Plugin topic
  nothing opened is refused like `stream:*` topic nothing `declareStream`d. Channel registry build
  **before** `loadPlugins` in `apps/gateway/src/index.ts`. Route's `close` read
  `registry.topics(id)` **before** `registry.remove(id)`. Throwing handler caught, counted per
  plugin, reported one batched line, never with error body.
- Console externalise `react`, `react-dom`, `styled-components`, `@tanstack/react-query`,
  `@omnigateway/dashboard-sdk` through import map; `apps/dashboard/shared/manifest.ts` is the single
  list. **`export * from "react"` does not work and does not warn** — React is CommonJS; shims
  destructure the default. SDK on the list for a different reason: duplicate is duplicate *context
  object* — panel find no provider, pause forever, nothing thrown. Plugin bundle must mark SDK
  external exactly like React.
- Plugin UI assets served at `/plugin-assets/<id>/…`, not `/plugins/<id>/…` (console routes).
  Bundles unauthenticated like console's own JavaScript; catalog at `/api/plugins` admin-gated.
- Literal `../` never reach a route handler — `URL` normalise it first, so a test asserting 404 for
  it prove nothing. Only percent-encoded forms reach a guard; `realpath` already decide every case.

## Subagent workflow

- Orchestrator create implementation subagent, then separate review subagent. Subagents do not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; no worktrees.

## graphify

This project can carry knowledge graph at `graphify-out/` with god nodes, community structure,
cross-file relationships. `graphify-out/` gitignored, so fresh clone has none: if
`graphify-out/graph.json` absent, run `/graphify .` to build one, or skip graph and read source
directly. Every rule below conditional on that file existing.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. Return scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain not surface enough context.
- After modifying code, run `graphify update .` to keep graph current (AST-only, no API cost).
- AST extraction not follow barrel re-exports: import of `GatewayError` from `@omni/ir` target
  `packages_ir_src_index_gatewayerror`, but symbol defined in `errors.ts`, so edge dangle and drop
  at build. That silently zero inbound degree of the types whole architecture turn on —
  `GatewayError`, `ChatRequest`, `Store`, `ProviderId`, `StreamEvent`, `Logger`, `HttpClient` — so
  god-node rankings under-weight `packages/ir` and `packages/store` until endpoints remapped to
  their defining module. Every `graphify update .` bring it back.
