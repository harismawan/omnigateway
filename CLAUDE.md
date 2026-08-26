# OmniGateway Repository Guidance

Agent guidance for repo work: architecture, boundaries, conventions, durable traps.
`README.md` serve operators; `ARCHITECTURE.md` explain how system fit together; this file serve
contributors. Update all that change touch.

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
- `packages/rtk`: tool-result filters, applied in dispatch before routing
- `packages/store`: persistence + encryption
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
focused changed-behavior tests, full `bun test`, dashboard suite, `bun run typecheck`, `bun run lint`.

## Architectural boundaries

1. `packages/ir` stay provider-independent + side-effect-free. Inject clocks + logger sinks; never
   import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, model catalogs stay in
   `packages/providers`. Within it, an adapter never import from another provider's directory —
   shared helpers live at the package root (`http.ts`, `sse.ts`, `types.ts`), and codecs a provider
   needs are forked into its own directory even when near-identical. This is what lets each
   provider become a standalone plugin later without dragging the others along; `custom/` is the
   worked example (own chat + responses codecs, forked from kimi/kilo/openai).
3. `packages/router` stay pure: no network, database, token refresh, timers.
4. Dispatch own side effects, retries, refresh, deadlines, failover, stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` know nothing about caller type: no Elysia, cookies, argv, terminal, timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows + secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
8. All outbound provider HTTP use `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` browser-imported, must stay leaf: model lists plus types only.
10. Catalog pricing give defaults. Router price from saved targets; catalog edits hit new targets
    only.
11. CLI administer local installs through `@omni/control`, never `/api/*`. Inject every side effect
    so tests never start processes or write outside temp dirs.
12. Dashboard call `/api/*` only — which now include the one WebSocket, `/api/stream`. One
    exception: `/health`, polled to watch gateway leave and return
    across restart. During restart no session and no authenticated surface to probe, so liveness is
    the one question `/api/*` cannot answer. May import `@omni/store/types`, `@omni/ir`, catalog
    subpath, `@omnigateway/dashboard-sdk`, but not provider adapters, HTTP client, runtime store
    code. SDK permitted because alternative was second copy of rule about what may leave plugin's
    own API prefix — rule held in two places is one that end up true in one. Same argument later
    moved LIVE switch there: which control pause polling is a rule too. SDK **no longer** leaf with
    no imports — `live.ts` import React — so it now in `SHARED_IMPORTS`, one copy served to console
    and every panel. Order load-bearing: SDK holding a context but bundled per plugin give each its
    own `createContext`, and panel reading that one find no provider, take "polling off" default,
    never poll again, silently. Never ship half.
13. `packages/rtk` stay pure like `ir` and `router`: no I/O, clocks, randomness. Rewrite tool-result
    content only, preserve errors + non-tool-result blocks. `@omni/rtk/catalog` is leaf holding
    filter-id union; `@omni/store` import that subpath alone.
14. `packages/ratelimit` stay pure same way; `now` always a parameter, counters supplied by caller,
    so package never learn where they came from. `@omni/ratelimit/catalog` is leaf holding dimension
    + window unions, `LimitConfig`, its zod schema; `@omni/store` import that subpath alone and
    re-export `LimitConfig` from `@omni/store/types`, the import dashboard already permitted.
    Limiter state — rings + gauges — live in `apps/gateway`, because state not package's job.
    `@omnigateway/plugin-api/events` **mirrors** the unions and `WINDOW_MS` rather than importing
    them, because that package published and this one not. This package stay source of truth; mirror
    pinned by `apps/gateway/test/plugins/limitVocabulary.test.ts`, only place that may import both.
15. Plugins load from `<root>/plugins/` at boot, receive capability-scoped `PluginContext`: never
    `Store`, `HttpClient`, `AdminAuth`, decrypted credentials, `process.env`. **It is a guardrail,
    not a sandbox** — plugin share gateway's process and can import past all of it. What it buy:
    accidental overreach impossible, plugin's intent auditable from manifest. Say that plainly
    wherever it come up; reader who believe otherwise make worse decisions than one who know.
    `packages/plugin-api` stay pure like `ir`; loader, context, event bus, channel registry live in
    `apps/gateway`. Every load failure skipped and reported, never fatal: proxy path depend on no
    plugin and must not become able to. `channels` capability give plugin `open(name)` and nothing
    else — never a socket, upgrade request, header or `Principal`. Topic is `plugin:<id>:<name>`
    with `<id>` from validated manifest, so plugin cannot name another plugin's topic, same rule
    `{{name}}` follow for its tables. Registry answer what **exist**; `authorised` in
    `routes/stream.ts` decide who may hold it, so opening channel never widen plugin's own reach.
    Outbound frame reuse socket registry's own bounded per-connection queue — no second queue, and
    nothing here touch `Store`.

## Adding a provider

Nine-step procedure in [docs/adding-a-provider.md](docs/adding-a-provider.md): what compiler
enumerate for you, what it cannot find, per-provider files, why `wire.ts` and `decode.ts` forked not
shared. Read before adding one — several steps exist because skipping them made bug that read as
something else entirely.

## Writing a plugin

Procedure in [docs/writing-a-plugin.md](docs/writing-a-plugin.md): manifest, capability context,
storage placeholder, event guarantees, how UI bundle share console's React. Read before adding or
reviewing one — it open with what plugin can reach, which decide whether rest of it good idea.

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

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- `LogFields` is closed allowlist + redaction boundary. Treat new free-text fields as security
  changes; never add index signature.
- Return raw gateway API keys once; store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, errors
- `GET /v1/models`: authenticated, filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

Every `/v1/*` request accept Bearer or `x-api-key`; reject conflicts. `null` model allowlist mean
unrestricted; empty array deny all models.

Preserve these translation invariants:

- Keep mid-conversation system messages in place; never fold into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve + accumulate Anthropic signatures.
- On the way back out, the OpenAI surface renders canonical thinking as `reasoning_content`
  (stream deltas and non-streaming message field — the DeepSeek/OpenRouter spelling); the
  Anthropic surface keeps its full dialect, with unsigned blocks suppressed from stream and
  buffered content alike.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize missing beta.
- `ToolDef` is union. `CustomToolDef` stay portable; `AnthropicToolDef` carry exact versioned `type`
  never normalized or upgraded. Versions in `packages/providers/src/anthropic/tools.ts`; unknown
  dated types rejected, not prefix-matched.
- Anthropic-native content blocks use `anthropicNative` IR variant, keep payload verbatim, stay out
  of tool-id correlation, orphan removal, cross-provider translation, RTK.
- `AnthropicToolDef` or `anthropicNative` history block exclude every provider whose
  `ANTHROPIC_NATIVE_TOOLS` entry false at routing — currently everything except Anthropic.
- `pauseTurn` is own stop reason; never fold into `endTurn` or `toolUse`.
- Client tool names renamed to PascalCase on Anthropic **OAuth** leg only, restored in
  `anthropic/decode.ts` — never at egress. Anthropic fingerprint some name sets and refuse them
  through a billing placeholder; `FINGERPRINT_REFUSED` name that. Restore site load-bearing: RTK
  normalize by case and separator alone, so `SessionSearch` never match `session_search` and an
  egress-side restore silently degrade every shell classification. Cloak live in `send()` frame,
  never on `dispatchRequest` — that object shared across attempt, so storing it leak alias into
  next provider. Exempt name (already PascalCase, or `mcp__*`) reach wire unrenamed and therefore
  **claim its spelling**, else derived alias land on live tool's real name.
- Unknown Anthropic block types + SSE events fail visibly, not skipped.
- Preserve cache-control breakpoint block, TTL, order when target can express them. Record
  degradations for requested features provider cannot express.
- **One exception, and only one**: `autoCacheEnabled` (default **on**) let Anthropic adapter add
  breakpoints to request carrying **none**. Anthropic caching opt-in, so unmarked request pay full
  input price forever however stable its prefix. Trigger narrow and load-bearing — fire only when
  `estimateCachedInputTokens` is 0 *and* no `cache_control` in vendor bag, so client's own placement
  never second-guessed. Up to **three** markers, one rule: walk tier in render order — last tool
  (prefix = tools), last system block (tools+system), last cache-eligible block of wire history
  (whole request) — and place marker when that prefix beat **last placed marker's** prefix by ≥1024.
  Running comparison start at 0, so first marker's test is Anthropic's own ≥1024 minimum and no
  separate cumulative check exist; one that did would be condition no input can fail. Three of four
  slot, so ceiling never crossed. **Last *placed*, not previous tier** — tier skipped for small
  increment leave comparison where it was, else marker that would have paid get suppressed. Gating
  each marker on prefix it cache instead is what shipped first and was wrong: `estimateInputTokens`
  sum non-negative term, so tools ≤ tools+system ≤ whole and gate 1 passing *imply* other two — big
  tool set under 1-token system prompt took 3 slot and 2 cache write to re-store same byte. Same
  rule remove need for `OAUTH_IDENTITY` special case: injected line ~15 token, not in IR, so system
  tier add nothing and never get marked. **Never add a check naming that string** — it defend
  against one string and nothing shaped like it. Marker 3 walk `body.messages` **backwards, never
  `req.messages`** — flatMap drop turn of entirely unsignable reasoning, so index differ and wrong
  turn get marked silently; skip string content (`encodeSystemTurn`) and any block type outside
  text/image/tool_use/tool_result/document. Write to wire body only, never IR: IR shared across
  attempt, so marker there follow failover into other provider. `systemCacheControl` promotion path
  walk IR, so it cannot see wire-side marker — earlier claim it could was wrong. IR rule pinned by
  **deep-freezing module fixture** in `packages/providers/test/anthropic.test.ts`, not by cloning
  and diffing: fixture handed to `toWire` unclone by earlier test, so leaked marker already inside
  clone and assertion compare polluted to polluted. Recorded as `anthropic:cache-breakpoint-added`
  (marker 1 or 2) and `anthropic:history-cache-breakpoint-added` (marker 3), each only when its
  marker placed. Design:
  `docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md`.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes are disjoint classes priced
  once. Use `promptTokens()` when client surface need total prompt tokens.
- Adapters stream upstream. OpenAI chat usage need `stream_options.include_usage`; Responses API
  report usage on `response.completed`.
- `/v1/models` report smallest target window in pool. Limits advertised, not enforced.
- Normalize `claude/<id>` aliases and `[1m]` before key allowlist checks. `claude/` stay reserved.
- Gateway not validate request-shape support per model; unsupported combos surface as upstream
  errors.
- OpenAI surface read images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as from `content`. Neither sidecar is OpenAI field; read
  because clients that send them send no other copy. Payload's own container header beat any
  declared type, and remote URL never fetched.
- Two sidecars differ on what unusable payload mean, and split is the contract. `images` is Ollama's
  images-only field, so anything in it that not image data is `BAD_REQUEST`. `attachments` is SDK's
  general file envelope, where PDF or hosted URL is ordinary: those dropped, never refused, because
  they were dropped before gateway read the field and refusing now would break caller that worked
  yesterday. Same reasoning as `looseCacheControl`.

Detailed compatibility rules + measured client behavior belong in relevant specs under
`docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` default off, read at boot. `OMNI_BASE_URL` must be public
  reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidate stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > install in cwd > `~/.config/omnigateway`. Root
  `.env` intentionally override ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  the root. A `--root` flag suppress ambient `OMNI_DB_PATH` entirely — Bun preload cwd's `.env`, so
  otherwise flag pick the root and unrelated checkout pick its database. Suppression warned on
  stderr, reported by `doctor`, removed from env spawned gateway inherit. `OMNI_ROOT` not suppress
  it: both ambient.
- Quota cooldowns process-local, reset on restart. So are `1m` and `concurrency`; `5h` and `1w` come
  from database and survive one.
- `usage.append` must run at most once per request ID; duplicate completion double-count
  `usage_daily` and `usage_rollup` alike. Pending rows hold placeholder metrics; inspect `state`,
  not `status`.
- `usage_rollup` derived, never authoritative: `request_logs` is source of truth and `rebuildRollup`
  reproduce every bucket from it. Written in `append`'s transaction, pruned with rows it summarizes,
  rebuilt after restore, compared by `omni doctor`. It replaced `SELECT SUM` whose cost grew without
  bound — and `bun:sqlite` is synchronous, so that scan blocked whole event loop, not one request.
  Same reason a timeout around store read cannot fire; do not add one back.
- `quota_windows` store provider observations, not gateway counts. Missing data mean unknown, not
  unlimited. Probe failure must never disable credential.
- RTK filter ids persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is storage contract,
  not internal enum. `isRtkFilterId` drop unknown ids on read, so renaming one lose history silently
  rather than failing. Add ids freely; rename or remove only with migration.
- Rate limiting explained in `ARCHITECTURE.md#rate-limiting`; these are invariants a change must not
  break, each already broken once.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are JSON keys of `api_keys.limits`, so
  storage contract like RTK ids — but failing **closed**: unknown name is parse failure, never
  silent drop. Rename or remove only with migration, and update mirror in
  `@omnigateway/plugin-api/events` in same change.
- **Nothing a plugin imports may reach a core package.** `@omnigateway/plugin-api` and
  `@omnigateway/dashboard-sdk` published; every `@omni/*` package not, so single import put
  unresolvable `workspace:*` into stranger's dependency tree. It typecheck and test green inside
  this repo, because workspace resolution make every internal package reachable — exactly why it
  went unnoticed once. `packages/plugin-api/test/bundleWeight.test.ts` build each entry point and
  assert zod appear only under root; first test assert zod *is* present there, because "absent" is
  also what broken harness report.
- `admit`/`consume` claim ring stamp and gauge **synchronously**, before any `await`, and roll back
  on refusal. Reading counters first and recording after let concurrent requests judge one pre-burst
  snapshot — ceiling of 3 admitted 10 parallel requests, and it need no I/O to fire.
- Refuse at auth, degrade at list. Unparseable `limits` read back as `null`, distinct from `{}`, and
  `authenticateApiKey` turn it into `INTERNAL` — not `AUTH`, which would blame credential that is
  fine. `keys.list()` must never throw over such a row: `toKey` serve the listing too, and listing
  is how operator find the row to fix. Nothing may collapse that `null` into `{}`.
- Two fields editable after minting: `limits` (`setKeyLimits`, `PUT /api/keys/:id/limits`) and
  `modelAllowlist` (`setKeyModels`, `PUT /api/keys/:id/models`). Both written whole, never patched —
  matrix `{}` is how last limit go away, never husk like `{"requests":{}}`; allowlist `null` (every
  model) and `[]` (none) are opposite facts, so schema refuse default and absent never pick one.
  `bodyLoggingOptOut` deliberately not editable — opt-out is promise to whoever hold the key; limit
  and allowlist are operator's own ceiling on own installation.
- Windows *slide*. `1m` is exact ring in `apps/gateway`; longer windows are `usage.sumSince` — which
  must filter `state = 'done'` — plus in-memory delta, cached 30s. Composition may over-count and
  must **never** under-count, so delta keep everything at or after read instant; other direction
  walkable by timing the refresh. Failed `sumSince` serve the request and log through existing
  `LogFields` keys, degrading long windows only, because `1m` and `concurrency` never touch store.
- Token and spend debit live in `finishLog` beside `usage.append`, never inside `@omni/store`: that
  site already run at most once per request id, the guarantee debit need.
- Concurrency gauge released at request scope and nowhere else. Streaming handler return while
  request still run, so `finally` around handler body fire at head-send, and decrement beside debit
  sit behind store write; streams free it from `sseResponse`'s run-once completion. No window expire
  a gauge — leak lock the key out until restart, silently.
- `ApiKeySummary.limitUsage` count committed rows only: floor on what limiter see, never its number.
  `concurrency.used` is `null`, not `0`, because gauge not stored.
- `ProviderModelChoice.auth` enforced at write time in `putModel`, never at routing. Which ways in
  exist is installation state, so catalog export the fact (`catalogModelAuths`) and control own the
  rule. Provider with no credential is unknown rather than blocked, unlisted model unknown rather
  than forbidden, disabled credentials still count, and target already stored under that id exempt
  so removing credential cannot make unrelated edit unsavable.
- **An `AggregateError` has no message of its own.** Node report failed multi-address connect that
  way — `autoSelectFamily` on by default — keeping each address's error in `errors` and leaving
  `message` empty. Copying `error.message` verbatim therefore render `reason=` with nothing after
  it, and `request_logs` hold no message column, so on proxy path the reason a request failed was
  recoverable from nowhere. `describeError` in `@omni/ir` is the one way to fill that field; it fall
  back to error's name, and every site reporting a `reason` go through it. `classify` recurse into
  `errors` for same reason: matching only `name` and `message` saw `""`, fell through to `INTERNAL`,
  and `RETRYABLE` mark that false — so retryable transport failure ended the request after one
  attempt and served 500 blaming the gateway.
- `CONNECT_ATTEMPT_TIMEOUT_MS` must stay above one TCP retransmit. Happy Eyeballs give each address
  family fixed budget, and node's default is under Linux's one-second initial RTO, so dropped SYN —
  routine on lossy path — abandoned at ~500ms instead of recovering at ~1000ms. Where other family
  cannot serve (AAAA record with no IPv6 route), both attempts then exhausted and connect fail
  outright. Measured: 3 failures in 99 connects at default, 0 in 212 once raised, previously-failing
  connects completing at 1007–1061ms. Failure read as provider outage and is not one.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats decoded
  away. Keep server idle timeout above request deadline.
- Socket registry close every connection **before** `app.stop()`, and its `stopLoops` position is
  what make that true. `stop()` called without `true`, so it drain rather than sever, and open
  WebSocket never end by itself — one connected console otherwise hold teardown for the full
  `STOP_DEADLINE_MS` every restart. Close with `1001`; `4401` mean "do not reconnect" and is for
  expired session alone.
- `/health` watcher stay a plain `fetch` poll and must never move onto the socket. The one check
  proving gateway came back cannot depend on subsystem being restarted.
- Elysia call a `.ws()` route's `beforeHandle` **twice** — once through composed hooks, once by hand
  in the Bun adapter, guarded by `typeof === "function"`. So it must be a single function, never an
  array (an array is silently skipped by the second call, and guard appear to work while running
  half the time), and it must be idempotent or every upgrade cost two `verify` round-trips.
  Throwing from it is fine and reach `apiErrorHandler`. Also register a companion plain `GET` on the
  same path: a ws route match only when `upgrade: websocket` present, so without one a browser hit
  fall through to static catch-all and 404 an endpoint that exists.
- `res:*` frame carry at most `{ keys }` and client map **topic to query-key prefix**, never an
  enumerated key list. `["logs", limit]` and `["usage", …6]` are parameterised, so an enumerated
  table go stale silently. One exception is real: `res:logs` must exclude `["logs","body",…]`, a
  prefix collision on immutable data.
- Coalescing on `res:*` is load-bearing, not tuning. Uncoalesced push at 100 req/s is 100 refetch
  per second against a surface polling at 60s — strictly worse than what it replace.
- Stdout hold operational events; `request_logs` hold completed requests. Do not restore duplicate
  per-request access lines. `requestId` join both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` name
  existing capture; it not create one.
- Docker image contain gateway only; npm package contain CLI, gateway, dashboard.
- OpenAI OAuth route to narrower Codex surface. OAuth-specific encoding stay behind existing `oauth`
  flag.
- Snapshot is database alone. `request_bodies/` excluded, so downloaded snapshot never a prompt
  corpus and its size never track prompt volume. After restore, body rows and artifact files
  disagree until `sweepOrphans` reconcile them; expected, not bug.
- Snapshot still carry encrypted credentials and API-key hashes. Downloads are `no-store`, and file
  inert only because `OMNI_ENCRYPTION_KEY` not in it.
- Lifecycle and swap rules below explained in `ARCHITECTURE.md#replacing-the-database-while-it-is-open`
  and `#stopping-and-restarting`. Each look arbitrary alone and is not; read the section before
  changing any of them.
- Restart ask systemd, never self-SIGTERM (which stop the gateway for good), and `--no-block`
  required.
- Quiesce latch gate `/v1/*` only; `/api/*` and `/health` stay live through swap.
- `store.close()` idempotent and `reopen()` tolerate closed handle, so restore is close → swap →
  reopen. Repo methods forward per call: bind one to local and it die at next swap.
- `vacuum()` must checkpoint, or page count fall while file keep every page.
- Restore compare admin password hash across swap and invalidate sessions only when it differ.
  **Nothing may sit between the swap and that comparison** — swap already succeeded, so anything
  throwing in front of it skip the invalidation while new password live.
- `swapIn` rebuild `usage_rollup` last and guarded, for that reason. It block the loop; cost
  measured in `README.md` and must stay documented rather than hidden.
- `omni db restore` refuse while gateway running, no override.
- Plugin tables are `plugin_<id>_<name>`, written by host from `{{name}}` placeholder, tracked in
  `plugin_migrations` on track independent of core's `001..`. Core's next migration number
  unaffected by any plugin. Plugin migrations apply **one transaction each**: batch transaction
  would make plugin failing on migration 5 silently revert 1–4 on every later boot.
- Restore onto install without that plugin leave orphan `plugin_*` tables. They stay, and
  `omni doctor` report them. **Nothing auto-drops them** — restore is exactly when plugin may not
  be installed yet, and drop is irreversible. `omni plugin remove` keep tables too; only `--purge`
  drop them, and it confirm first.
- Plugin events are **at-most-once and not durable**: one queued when process die is gone, and full
  queue drops rather than grows. Anything needing exact accounting must reconcile from own storage.
  `RequestCompleted` emitted from `finishLog` because that already the one site running at most once
  per request id — same reason usage debit there.
- Plugin channels carry same promise and one more. Client must **subscribe before it send**: plugin's
  only way to answer is `send(connectionId, …)` on that topic, so frame from unsubscribed connection
  is question whose answer have nowhere to land, and it refused rather than handed over. Plugin topic
  nothing opened refused like `stream:*` topic nothing `declareStream`d, same reason — topic with no
  owner must not read as topic that merely quiet. Channel registry build **before** `loadPlugins` in
  `apps/gateway/src/index.ts`, because plugin open its channel inside `setup`; one built after leave
  every plugin holding live-looking handle onto nothing. Route's `close` read `registry.topics(id)`
  **before** `registry.remove(id)` — reverse it and every `onClose` handler go unfired, silently.
  Throwing handler caught, counted per plugin, reported one batched line per plugin, never one per
  failure, and never with error body: `LogFields` closed allowlist and that code authored outside
  this repository.
- Console externalise `react`, `react-dom`, `styled-components`, `@tanstack/react-query`,
  `@omnigateway/dashboard-sdk` and resolve them through import map, so console and every plugin
  share one instance; two React copies throw "invalid hook call".
  `apps/dashboard/shared/manifest.ts` is single list feeding externals, import map, shared build.
  **`export * from "react"` does not work and does not warn** — React is CommonJS, so re-export
  compile to module exporting only `default`. Shims destructure the default instead. SDK is ESM so
  `export *` correct for it, and it on list for different reason than other four: they about
  instance identity and each announce breach; SDK hold `LiveContext`, so duplicate is duplicate
  *context object* — panel find no provider, pause forever, nothing thrown, nothing logged. Plugin
  bundle must mark SDK external exactly like React.
- Plugin UI assets served at `/plugin-assets/<id>/…`, not `/plugins/<id>/…`, which would collide
  with console's own client-side routes. Bundles unauthenticated like console's own JavaScript;
  catalog at `/api/plugins` admin-gated, because what is gated is data.
- Literal `../` never reach a route handler — `URL` normalise it before routing, so test asserting
  404 for that input prove nothing. Only percent-encoded forms reach a guard, and they arrive
  undecoded. Two path checks here deleted after mutation showed `realpath` already decided every
  case; decoration in security path invite belief that something is being done.

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