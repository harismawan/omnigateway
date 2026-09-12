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

Push `v*` tag run `.github/workflows/release.yml`; tag = sole version source. Before claim done, run
focused changed-behavior tests and every check in `.github/workflows/ci.yml`.

## Architectural boundaries

**Single-copy rules.** Never re-derive these helpers locally:
- `keyUsable`: revoked or expired keys are unusable; `expiresAt === now` is expired.
- `credentialExpired` / `credentialPastExpiry`: only OAuth expiry prevents routing; refreshability
  stays caller phrasing.
- `servesTarget` / `resolvePin`: provider, endpoint, and pin are one question;
  `ServingCredential.providerData` carries endpoint data. `servesTarget` names no provider.
- `scopeOf`: principal to read filter.
- `quotaRolledOver`: whether a quota window ended.

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
12. Dashboard call `/api/*` only, including `/api/stream`; `/health` alone stays plain polling.
    It may import `@omni/store/types`, `@omni/ir`, `@omnigateway/dashboard-sdk`, never
    `@omni/providers` — no subpath or leaf, including type-only imports (plugins exist only at
    runtime). Pin: `apps/dashboard/test/imports.test.ts`. Mirror wire shapes in `api/types.ts`; never
    import them back. `ProviderId` comes from `@omni/ir`; provider list/order/label/colour/models
    come from `GET /api/catalog`, never `theme/tokens.ts`. In `routes/_app.tsx`, resolve catalog in
    `beforeLoad` after session check and before mount; `errorComponent` must show error + retry and
    preserve expired-session `redirect`. Pin: `apps/dashboard/test/routes/appGate.test.tsx`.
    Keep SDK in `SHARED_IMPORTS` so plugins share `LiveContext`; SDK owns the plugin API-prefix
    rule, LIVE switch, and `usePluginChannel`. See
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
16. Plugins load from `<root>/plugins/` at boot with capability-scoped `PluginContext`, never
    `Store`, `HttpClient`, `AdminAuth`, or `process.env`. This is a guardrail, not a sandbox; say so.
    Provider plugins alone receive their own decrypted credential: `codec.buildRequest` gets
    `{accessToken, apiKey, providerData}` via `credential.openForInference()`; OAuth `refresh` gets
    the refresh token and `usage` gets the access token via `UsageSecrets`. Router/refresher enforce
    matching provider, codec/flow hold neither client nor store, and URLs must match manifest
    `origins`. OAuth `requests.ts` holds pure builders replacing `postJson`/`getJson`; nothing may
    bypass the adapter. `packages/plugin-api` stays pure; loader/context/event bus/channel registry live in
    `apps/gateway`. Load failures are reported and skipped, never fatal.
    `channels.open(name)` exposes no socket, upgrade request, header, or `Principal`. `send` is local;
    optional `broadcast` uses `coord.pubsub`, is never coalesced, and is capped per channel by
    `BROADCAST_BURST`; count/report over-budget and unencodable payloads separately. Encode the
    plugin-authored `unknown` envelope inside `try` at `broadcaster.channel`; call optional member
    with `?.` though host always supplies it. Topic/table names use validated manifest id/name.
    Registry reports existence; `routes/stream.ts` `authorised` decides access. Reuse the socket
    registry's bounded per-connection queue.
17. **No provider-specific code in core module** — aim, not achieved state, measured per package.
    `ratelimit`, `rtk`, `ponytail` clean. `ir`: only `LogFields.surface` (`"anthropic" | "openai"`),
    permitted vocabulary. `store`: `bodies/mask.ts` hold `xaiKey` rule and vendor key prefixes
    on purpose (redaction paragraph below). `router`: `resolve.ts` exclude `custom` from prefix
    routing, because bare model name cannot carry endpoint id. `control`: `schemas.ts` name
    `custom` in one rule surviving its target union (custom target carry `endpointId`,
    nothing else may); `credentials.ts` plus `models.ts` ask `=== "custom"` about endpoint
    metadata. That is all.
    **OAuth out of core.** `OAUTH_PROVIDERS` is an empty null-prototype registry populated by
    provider modules through `registerOAuthProvider`; never restore a core provider literal.
    `seedBuiltinOAuth()` runs unconditionally through `installPluginProviders` at gateway boot and
    from `apps/cli/src/run.ts`. Thread the registry through the whole call graph; tests reading it
    seed first. Idempotence tracks provider membership per registry with `WeakMap`; repair missing
    membership. Seed order is operator-facing: anthropic, openai, kimi, kilo, grok, antigravity,
    muse; pin this literal, never `builtinOAuthFlows()`. Seeding after plugin loading is safe only
    while the loader registers no flow; if it does, move seeding first. `@omni/providers` imports
    `@omni/store/types` type-only. OAuth flow steps are capped async generators; optional
    `AuthRequest.timeoutMs` is clamped to host ceilings (30s token, 15s usage). Host owns transport,
    origin checks, return validation, PKCE, polling, randomness, and `gatewayAuthored`. Contract:
    `providers/src/oauthFlow.ts`; design: decoupling
    spec; pins: `oauthSeed.test.ts`, `connect.test.ts`, `install.test.ts`, `oauthStoreEdge.test.ts`.
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
18. `Principal` and `Scope` in `@omni/control` are the only copies of caller identity/read scope.
    `admin`, `viewer`, `client`, and `machine` share one cookie; `AdminAuth.verify` returns principal,
    never boolean; `stream/registry.ts` re-exports the union. Guards are per-route, never grouped:
    `requireAdmin`, `requireReader` (admin|viewer), `requireClient`; mutations, snapshot download,
    `/api/connect/*`, and `/api/plugins` stay admin-only. `Scope.none` must pass `readsNothing` before
    `scopeKey` in every scoped reader (`recentLogs`, `usageDaily`, `pageLogs`, `exportLogs`) because
    `scopeKey` maps both `all` and `none` to `undefined` and `usage_daily.api_key_id` defaults to `''`.
    Client body route is absent, not refusing. Design:
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
- `LogFields` is a closed allowlist/redaction boundary: new free-text fields are security changes;
  never add an index signature. Logger methods use `<T extends LogFields>(..., fields?:
  OnlyLogFields<T>)`; pin: `packages/ir/test/logFields.test.ts` with `@ts-expect-error`.
- `GatewayError.gatewayAuthored` is opt-in and defaults false. `reasonField` withholds a message
  only when the error names a provider, unless debug is on or this flag is true. Set it only for repository-authored messages
  containing no upstream/external text; `rebound` does not set it, `codecFailure` does. Preserve it
  through `classify` and dispatch `rewrap`.
- Return raw gateway API keys once; store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows and
  two password routes, which end sessions **by design**.
- Two passwords, neither default. Admin: set at `/api/setup`; `PUT /api/settings/password` requires
  current password, answers wrong current exactly like failed login, clears all sessions including
  caller, then console redirects to `/login?reason=password-changed`. Viewer password is optional:
  no row means `passwordMatches(null, …)` rejects and `viewerConfigured` is false.
  `PUT /api/settings/viewer-password` sets/replaces; `{"password": null}` deletes it; absent field is
  `BAD_REQUEST`; either change clears viewer sessions only. `MIN_PASSWORD_LENGTH` is 12 in
  `@omni/control`, mirrored in plain `features/settings/policy.ts`; pin:
  `apps/gateway/test/routes/passwordPolicyMirror.test.ts`.

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

`summary` carries `dayOffsetMinutes` as an additive top-level field, not inside shared
`ApiKeySummary` and not wrapped. Absent differs from zero (UTC). It is the only install-level fact;
justify any additional one independently. Pin: `clientSurface.test.ts` uses nonzero 420.

Client provider quota exposes named accounts: `accountQuota` returns credential+window rows with
operator label; `usedRatio`/`ratePerHourRatio` are `0..1`, with derivable ceilings accepted.
Keep `stale` and `rolledOver` separate. `/api/client/quota/history` exposes no aggregate gateway
rate. Both history reads cap at `MAX_SAMPLES` (50_000) in `quota/history.ts`, query `cap + 1`, and
report `truncated`; a single-series surface narrows before applying the all-account cap.
`clientSurface.test.ts` pins no credential identity on `logs`/`usage`/`summary`; quota may name
accounts but omits `used`/`limit`/`ratePerHour`.

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
- **Breakpoint on request's final mid-conversation system turn must leave that turn.**
  `systemCacheControl` + `toWire` retarget it to
  `lastCacheableHistoryBlock(body.messages.slice(0, -1))`; strip the mixed turn's copy, skip when
  the target already has the client's marker, and record
  `anthropic:system-turn-cache-control-retargeted`. History: auto-cache spec.
- `pauseTurn` own stop reason; never fold into `endTurn` or `toolUse`.
- Client tool names renamed to PascalCase on Anthropic **OAuth** leg only, restored in
  `anthropic/decode.ts` — never at egress. Anthropic fingerprint some name sets, refuse them
  through billing placeholder; `FINGERPRINT_REFUSED` name that. Restore site load-bearing: RTK
  normalize by case and separator alone, so egress-side restore silently degrade every shell
  classification. Cloak live in `buildRequest` frame, never on `dispatchRequest` — shared across
  attempts. Exempt names (already PascalCase, or `mcp__*`) reach wire unrenamed and **claim their
  spelling**.
- Unknown Anthropic block types + SSE events fail visibly, not skipped.
- Preserve cache-control block, TTL, and order; record unsupported-feature degradations. Only two
  exceptions:
  - `autoCacheEnabled` defaults on and adds markers only when both
    `estimateCachedInputTokens === 0` and the vendor bag has no `cache_control`. Walk last tool,
    last system block, then last eligible wire-history block; place at most three markers where
    prefix growth from the **last placed** marker is ≥1024, starting at 0. Walk `body.messages`
    backwards, never `req.messages`; eligible blocks are text/image/tool_use/tool_result/document.
    Mutate wire only, never shared IR. Record `anthropic:cache-breakpoint-added` and
    `anthropic:history-cache-breakpoint-added`. Pin: deep-frozen
    `packages/providers/test/anthropic.test.ts`; design: [auto-cache](docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md).
  - `ponytailMode` defaults off. Injection returns a new request, dedupes on `PONYTAIL_MARKER`, and
    moves only the client's final-system marker onto the appended ruleset, preserving count/TTL and
    never enabling auto-cache. `count_tokens` applies the same function. Degradation constants:
    `ponytail:<level>`, `ponytail:already-present`, `ponytail:cache-marker-moved`,
    `ponytail:cache-marker-not-last`. Vendor text stays pinned to v4.9.0 blob `a3e4d94b…`. Pin:
    deep-frozen `packages/ponytail/test/inject.test.ts`; design: [ponytail](docs/superpowers/specs/2026-08-29-ponytail-prompt-injection-design.md).
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes disjoint classes priced
  once. Use `promptTokens()` when client surface need total prompt tokens.
- Adapters stream upstream. OpenAI chat usage need `stream_options.include_usage`; Responses API
  report usage on `response.completed`.
- `/v1/models` report smallest target window in pool. Limits advertised, not enforced.
- Normalize `[1m]` before key allowlist checks. `claude/` **not** reserved, not rewritten.
- Gateway not validate request-shape support per model; unsupported combos surface as upstream
  errors.
- `ChatRequest.conversationId` is the client's opaque, conversation-scoped name; Anthropic
  `metadata.user_id` supplies it without parsing. Never use OpenAI `user`. `readConversationHeader`
  in `ingress/schemas.ts` checks after the body field, case-insensitively:
  `x-session-id`, `x-session-affinity`, `x-deepseek-harness-session-id`, `session-id`. Fallback hashes
  instructions + opening item, not tool list/first message; gateway-generated ids use the fallback.
  In `openai/wire.ts`, resolve client `prompt_cache_key` → client `session_id` → hashed
  `conversationId` → fallback before vendor `Object.assign`. `openai/codec.ts` sends the same value
  in OAuth `session_id` header; API-key leg uses body. Keep `session_id` in `openaiProfile.order` and
  `store: false` for Codex. Inspect client key sets, not one member. History: responses-ingress spec.
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
- A success writes `credential_health` only when pre-attempt snapshot
  `successWouldChange`; never decide inside `updateHealth.apply`. `SUCCESS_RESETS` in
  `router/src/breaker.ts` is the single reset set and includes `consecutiveFailures`; Postgres
  trigger `WHEN` is a strict subset. Missing health row means blank/healthy. Recent ranking uses
  `loadRegistry`'s `lastUsedAt`/`ewmaTtftMs`; display uses `usage.lastUsedByCredential`. Pins:
  `apps/gateway/test/dispatch/dispatch.test.ts`, `packages/router/test/breaker.test.ts`.
- `usage.append` must run at most once per request ID; duplicate completion double-count
  `usage_daily` and `usage_rollup`. Pending rows hold placeholder metrics; inspect `state`, not
  `status`.
- `startOfDay` in `packages/store/src/sqlite/rollup.ts` takes the configured fixed offset; thread it
  through both store factories, pinned by `packages/store/test/contract/usage.test.ts`.
- `usage_rollup` is derived from authoritative `request_logs`; `rebuildRollup` reproduces every
  bucket. Write it in `append`'s transaction, prune with source rows, rebuild after restore, compare
  in `omni doctor`. Never restore unbounded synchronous `SELECT SUM`; a timeout around a
  synchronous `bun:sqlite` read cannot fire.
- `quota_windows` store provider observations, not gateway counts. Missing data mean unknown, not
  unlimited. Probe failure must never disable credential.
- `quotaRolledOver`: null `resetsAt` is not rolled over; stale rollover data may persist up to
  `quotaPollIntervalMs` (default 300_000). Rollover suppresses inference only:
  `burnFor` drops `ratePerHour`, `exhaustsAt`, `survives` but keeps measured `windowStartsAt`.
  Surfaces phrase staleness before rollover.
- Projection truncates at the ceiling: `projectedPace` ends when it reaches 100%, the same instant
  as `exhaustsAt`; cap `usedPercent` at 100.
- RTK filter ids persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is storage contract.
  `isRtkFilterId` drop unknown ids on read. Add ids freely; rename or remove only with migration.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are JSON keys of `api_keys.limits` —
  storage contract failing **closed**: unknown name is parse failure. Rename or remove only with
  migration; update mirror in `@omnigateway/plugin-api/events` in same change.
- Rate limiting explained in `ARCHITECTURE.md#rate-limiting`; invariants below each already broken
  once.
- Nothing plugin imports may reach unpublished `@omni/*`; published `plugin-api` and
  `dashboard-sdk` must remain independently installable. `bundleWeight.test.ts` builds every entry
  and requires zod only in the root entry, including a positive root assertion.
- Published-package dependency ranges and versions move together. `publishable.test.ts` watches
  pair `package.json` files beside `src`; a range-only repair is not releasable.
- `SAFE_PROVIDER_ID` in dashboard `theme/tokens.ts` mirrors `PROVIDER_ID_PATTERN`.
  `providerColor` validates every stored provider before CSS interpolation and returns
  `var(--p-<id>, var(--ink-faint))`; do not move guards to call sites. `sqlite/config.ts` reads
  `virtual_models.targets` with bare `JSON.parse`, so restored data bypasses write schemas. Pin:
  `apps/gateway/test/routes/providerIdMirror.test.ts`.
- `admit`/`consume` claim ring stamp and gauge **synchronously**, before any `await`, roll back
  on refusal — ceiling of 3 once admitted 10 parallel requests.
- Refuse at auth, degrade at list. Unparseable `limits` read back as `null`, distinct from `{}`;
  `authenticateApiKey` turn it into `INTERNAL` — not `AUTH`. `keys.list()` must never throw over
  such row. Nothing may collapse that `null` into `{}`.
- Three fields editable after minting: `limits` (`setKeyLimits`, `PUT /api/keys/:id/limits`),
  `modelAllowlist` (`setKeyModels`, `PUT /api/keys/:id/models`) and `expiresAt`
  (`setKeyExpiry`, `PUT /api/keys/:id/expiry`). All written whole, never patched —
  `{}` is how last limit go away; allowlist `null` and `[]` opposite facts, and expiry `null`
  ("never") and absent field likewise, so both schemas refuse default. Expiry take **past
  instant** — "expire it now", reversible where `revoke` not; never add `> now` guard.
  `bodyLoggingOptOut` deliberately not editable — promise to whoever hold key.
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
- `Target.credentialId` is a hard filter, never a routing strategy: no `"pinned"` strategy and no
  spill from disabled, breakered, rate-limited, or quota-spent account. `pin:missing` emits once per
  target only when no account resolves; declare `pinSeen` inside each target loop and set it before
  drops. Nothing validates pin existence at write time—account removal must not make unrelated edits
  unsavable; `omni doctor` uses `resolvePin`. Schema on both
  target arms rejects empty and limits `[A-Za-z0-9_-]` to 64 chars; dashboard omits an empty pin.
  Console draft clears pin on provider/endpoint change, not model change; API/CLI preserve it.
  Pinned model limits use its account auth; unresolved pin falls back to provider-wide narrowing,
  never catalog figures. `putModel.unreachable` checks pinned auth without grandfathering; `pairOf`
  stays keyed on provider+model so clearing a dangling pin is never refused. `modelLimits` uses
  enabled credentials while `models.ts` uses existence. Account-removal surfaces
  name pinned models before confirmation; unanswered/empty console data means unknown.
- Breaker probe is one dispatch claim per `(credential, model)`, gated in router. `filters.ts` marks
  both open-past-cooldown and `halfOpen` as `Pair.probe`. Acquire `coord.gauge` inside attempt `try`
  beside `releaseSlot`; release after drain in the same `finally`. Lost claim
  (`breaker:probing`) consumes no attempt; all skipped means `NO_CANDIDATES`. `DispatchDeps.coord`
  is required; router must not import `@omni/coord`. Pins:
  `apps/gateway/test/dispatch/dispatch.test.ts`, `packages/router/test/imports.test.ts`; design:
  `docs/superpowers/specs/2026-09-07-breaker-half-open-probe-design.md`.
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
- `ProviderId` is a validated string, not a built-in union. Provider-keyed lookups are partial;
  keep `noUncheckedIndexedAccess` checks and never cast them away. `PROVIDER_ID_PATTERN` in providers
  is source; control reads it. Plugin-id grammar mirrors in manifest/routes/control/store and is
  pinned by `pluginIdGrammar.test.ts`. Built-in table completeness is pinned by lint plus
  `descriptor.test.ts`, not typecheck.
- Every provider-keyed table is null-prototype; use `Object.assign(Object.create(null), …)`, never
  spread. Use `Object.hasOwn` (not method `.hasOwnProperty()`) only for injected tables, never instead
  of null prototypes. `providerTables.test.ts` discovers tables rather than enumerating them. Guard
  injected adapters at `dispatch/index.ts`, not `app.ts`; `DispatchDeps`/`ProxyDeps` are public.
  Dashboard `heldAuths`
  separately uses a null-prototype table.
- Thread registries through the entire call graph; the sentinel-registry test is the guard.
  Module-scope `Object.keys/entries(PROVIDER_DESCRIPTORS)` is a pre-plugin snapshot: grep for the
  pattern whenever changing registries. `PROVIDER_IDS` may serve CLI text/tests, never gates.
- `AggregateError` may have no message: use `describeError`; `classify` recurses into `errors` so
  multi-address transport failures remain retryable.
- Keep `CONNECT_ATTEMPT_TIMEOUT_MS` above one Linux TCP retransmit (>1s); do not use Node's shorter
  Happy Eyeballs default.
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
- Swap forwarder in `sqlite/store.ts` hand-writes one arrow per repo method; TypeScript permits
  lower arity, so every added parameter must be forwarded. Pin: `packages/store/test/swap.test.ts`.
- `vacuum()` must checkpoint, or page count fall while file keep every page.
- In `store/src/logPage.ts`, person-entered `model`, `requestedModel`, `resolvedModel`, `errorCode`
  use case-insensitive escaped substring search; all other fields, especially scoped `apiKeyId`, use
  `=`. Dialect supplies `LIKE`/`ILIKE`; escape `_` and `%` explicitly. Pin:
  `test/contract/usage.test.ts`.
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

When gitignored `graphify-out/graph.json` exists, query it first for codebase questions; use
`path`/`explain` for focused relationships and the wiki/report only for broad navigation. If absent,
run `/graphify .` or read source directly. After code edits run `graphify update .`.

Known graphify limitation: AST barrel re-exports dangle at `index` instead of defining modules,
under-ranking core IR/store types. Every `graphify update .` reintroduces it for `GatewayError`,
`ChatRequest`, `Store`, `ProviderId`, `StreamEvent`, `Logger`, and `HttpClient`; do not trust their
inbound-degree rankings.