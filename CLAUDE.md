# OmniGateway Repository Guidance

Agent guidance for repository work: architecture, boundaries, conventions, and durable traps.
`README.md` serves operators; `ARCHITECTURE.md` explains how the system fits together; this file
serves contributors. Update all that a change affects.

## Scope

OmniGateway is a Bun/TypeScript monorepo for a self-hosted AI gateway:

- `apps/gateway`: Elysia gateway and long-lived process loops
- `apps/dashboard`: admin console served by gateway
- `apps/cli`: local `omni` CLI
- `packages/control`: admin operations shared by gateway routes and CLI
- `packages/ir`: provider-neutral domain model
- `packages/providers`: provider adapters and catalog
- `packages/router`: pure routing
- `packages/ratelimit`: pure API-key limit evaluation and sliding-window counting
- `packages/rtk`: tool-result filters, applied in dispatch before routing
- `packages/store`: persistence and encryption
- `packages/testkit`: shared test fixtures

Approved designs live in `docs/superpowers/specs/`; matching implementation plans live in
`docs/superpowers/plans/`. Read relevant spec before changes, but verify current code because plans
record past intent.

## Commands

Use Bun from repository root:

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
bun run dev:dashboard              # Vite on 5173, proxies /api and /oauth to 9000
bun run build:dashboard            # writes apps/dashboard/dist
bun run --cwd apps/dashboard test  # happy-dom suite excluded from root tests
```

CLI and release:

```bash
bun apps/cli/src/index.ts --help
cd apps/cli && bun link
omni doctor --root <install>
bun run build:npm v1.2.3
```

Pushing a `v*` tag runs `.github/workflows/release.yml`; tag is sole version source. Before claiming
completion, run focused changed-behavior tests, full `bun test`, dashboard suite, `bun run typecheck`,
and `bun run lint`.

## Architectural boundaries

1. `packages/ir` stays provider-independent and side-effect-free. Inject clocks and logger sinks;
   never import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, and model catalogs stay in
   `packages/providers`.
3. `packages/router` stays pure: no network, database, token refresh, or timers.
4. Dispatch owns side effects, retries, refresh, deadlines, failover, and stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, and record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` knows nothing about caller type: no Elysia, cookies, argv, terminal, or timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows and secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
8. All outbound provider HTTP uses `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` is browser-imported and must remain a leaf: model lists plus types only.
10. Catalog pricing provides defaults. Router prices from saved targets; catalog edits affect new
    targets only.
11. CLI administers local installations through `@omni/control`, never `/api/*`. Inject every side
    effect so tests never start processes or write outside temp directories.
12. Dashboard calls `/api/*` only, with one exception: `/health`, polled to watch the gateway leave
    and return across a restart. During a restart there is no session and no authenticated surface
    to probe, so liveness is the one question `/api/*` cannot answer. It may import
    `@omni/store/types`, `@omni/ir`, and catalog subpath, but not provider adapters, HTTP client, or
    runtime store code.
13. `packages/rtk` stays pure like `ir` and `router`: no I/O, clocks, or randomness. It rewrites
    tool-result content only and preserves errors and non-tool-result blocks. `@omni/rtk/catalog` is
    a leaf holding the filter-id union; `@omni/store` imports that subpath alone.
14. `packages/ratelimit` stays pure the same way; `now` is always a parameter and the counters are
    supplied by the caller, so the package never learns where they came from. `@omni/ratelimit/catalog`
    is a leaf holding the dimension and window unions, `LimitConfig`, and its zod schema;
    `@omni/store` imports that subpath alone and re-exports `LimitConfig` from `@omni/store/types`,
    which is the import the dashboard is already permitted. Limiter state — rings and gauges — lives
    in `apps/gateway`, because state is not the package's job.

## Adding a provider

1. Start at `ProviderId` in `packages/ir/src/request.ts`. Adding a member makes the compiler
   enumerate every exhaustive `Record<ProviderId, …>`; let it drive the work rather than keeping a
   checklist. What it cannot find: hardcoded provider lists in tests (`kimi`, `custom`, `catalog`,
   `proxy`), the dashboard's duplicated `PROVIDER_LABEL`, `PASTE_HINT`, and `PROVIDER_ORDER` maps,
   the `--p-<id>` oklch pair in `theme/GlobalStyle.ts`, and free-text `"provider must be one of …"`
   strings in CLI and control. Beware assertions that still pass by prefix.
2. No store migration. `credentials.provider` is `TEXT` with no `CHECK`, and `providerData` is
   free-form.
3. Directory is `packages/providers/src/<id>/`: `index.ts` transport, `wire.ts` IR to request,
   `decode.ts` stream to IR, `models.ts` catalog entry, plus `device.ts` where the provider wants a
   stable client fingerprint. Mint fingerprints synthetically at connect time and freeze them onto
   the credential; never read the real hostname or machine id.
4. Fork `wire.ts` and `decode.ts` per provider. Never import another provider's directory: vendors
   look alike on paper and diverge in practice, and a shared encoder collects a branch per quirk.
   `custom/` predates this rule and shows the cost — it imports `../kimi/` and `../openai/` and pays
   with a regex rewriting degradation prefixes afterwards. Shared infrastructure stays shared
   (`usageFromPromptTotal`, `parseSse`, `httpError`, `orderHeaders`).
5. Add `PROFILES.<id>` and `BODY_ORDER.<id>`. State in a comment whether the header set was captured
   from real traffic or constructed, as the kimi profile does. Put any version string the upstream
   gates on behind `env()` so a stale value is an operator fix, not a release.
6. OAuth is optional — `OAUTH_PROVIDERS` is `Partial`. Omit `usage` when there is no quota surface,
   so accounts read as unknown rather than unlimited. Refresh must retain the previous refresh token
   when a response omits one. Endpoints read from OIDC discovery must be validated as HTTPS on the
   provider's own domain before use, and a discovery failure is `UPSTREAM`, never `AUTH` — `AUTH`
   disables the credential.
7. Where a provider serves OAuth and API-key traffic from different hosts, or from different paths
   on one host as `kilo` does, select the URL by credential type in the adapter and assert the split
   in a test. Crossing them surfaces as a billing or entitlement error, which reads as anything but
   a routing bug.
8. A provider that prices by request size cannot be expressed in `ProviderModelPricing`. Pick a
   tier, say so in a comment, and warn operators in `README.md`.
9. Cover streaming and non-streaming, and mutation-test the load-bearing assertions — URL selection,
   usage-token arithmetic, tool call and result round-trip, mid-conversation system placement.
   Verify each anchor fails when its behaviour is broken; a green suite is not evidence of coverage.

## TypeScript and dashboard style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, including tests. Use `unknown` plus narrowing or named types.
- Use ESM imports with explicit `.ts` extensions. Match nearby naming and comment density.
- Biome uses 2-space indentation and 100-column lines. Avoid unrelated refactors.
- Dashboard uses styled-components, never Tailwind or CSS files.
- Palette CSS variables live in `theme/GlobalStyle.ts`; `theme/tokens.ts` references them.
- Colour means provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores, synthetic credentials, and stub `HttpClient`; never call live providers.
- Dispatch or adapter changes cover streaming and non-streaming paths.
- Preserve pre-commit failover versus post-commit stream behavior.
- Shared proxy changes test Anthropic and OpenAI error surfaces.
- Auth changes cover Bearer and `x-api-key`, malformed/conflicting input, revoked keys, allowlists,
  and relevant rate limits.
- Deadline tests distinguish gateway timeout from client cancellation and leave no timers/listeners.
- Dashboard tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`, and
  `renderWithRouter`; assert visible text, roles, and accessible names. Re-query after async loads.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- `LogFields` is a closed allowlist and redaction boundary. Treat new free-text fields as security
  changes; never add an index signature.
- Return raw gateway API keys once and store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, and internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, and errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, and errors
- `GET /v1/models`: authenticated and filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

Every `/v1/*` request accepts Bearer or `x-api-key`; reject conflicts. `null` model allowlist means
unrestricted; empty array denies all models.

Preserve these translation invariants:

- Keep mid-conversation system messages in place; never fold them into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve and accumulate Anthropic signatures.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize a missing beta.
- `ToolDef` is a union. `CustomToolDef` stays portable; `AnthropicToolDef` carries an exact
  versioned `type` that is never normalized or upgraded. Versions live in
  `packages/providers/src/anthropic/tools.ts`; unknown dated types are rejected, not prefix-matched.
- Anthropic-native content blocks use the `anthropicNative` IR variant, keep their payload verbatim,
  and stay out of tool-id correlation, orphan removal, cross-provider translation, and RTK.
- An `AnthropicToolDef` or `anthropicNative` history block excludes every provider whose
  `ANTHROPIC_NATIVE_TOOLS` entry is false at routing — currently everything except Anthropic.
- `pauseTurn` is its own stop reason; never fold it into `endTurn` or `toolUse`.
- Unknown Anthropic block types and SSE events fail visibly rather than being skipped.
- Preserve cache-control breakpoint block, TTL, and order when target can express them. Record
  degradations for requested features a provider cannot express.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes are disjoint classes priced
  once. Use `promptTokens()` when a client surface needs total prompt tokens.
- Adapters stream upstream. OpenAI chat usage requires `stream_options.include_usage`; Responses API
  reports usage on `response.completed`.
- `/v1/models` reports smallest target window in a pool. Limits are advertised, not enforced.
- Normalize `claude/<id>` aliases and `[1m]` before key allowlist checks. `claude/` remains reserved.
- Gateway does not validate request-shape support per model; unsupported combinations surface as
  upstream errors.
- The OpenAI surface reads images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as from `content`. Neither sidecar is an OpenAI field; they are
  read because the clients that send them send no other copy. The payload's own container header
  beats any declared type, and a remote URL is never fetched.
- The two sidecars differ on what an unusable payload means, and the split is the contract.
  `images` is Ollama's images-only field, so anything in it that is not image data is a
  `BAD_REQUEST`. `attachments` is the SDK's general file envelope, where a PDF or a hosted URL is
  ordinary: those are dropped, never refused, because they were dropped before the gateway read the
  field and refusing now would break a caller that worked yesterday. Same reasoning as
  `looseCacheControl`.

Detailed compatibility rules and measured client behavior belong in relevant specs under
`docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` defaults off and is read at boot. `OMNI_BASE_URL` must be public
  reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidates stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > installation in cwd >
  `~/.config/omnigateway`. Root `.env` intentionally overrides ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  the root. A `--root` flag suppresses ambient `OMNI_DB_PATH` entirely — Bun preloads the cwd's
  `.env`, so otherwise the flag picks the root and an unrelated checkout picks its database. The
  suppression is warned on stderr, reported by `doctor`, and removed from the env a spawned gateway
  inherits. `OMNI_ROOT` does not suppress it: both are ambient.
- API-key rate limits and quota cooldowns are process-local and reset on restart.
- `usage.append` must run at most once per request ID; duplicate completion double-counts
  `usage_daily` and `usage_rollup` alike. Pending rows contain placeholder metrics; inspect `state`,
  not `status`.
- `usage_rollup` is derived, never authoritative: `request_logs` is the source of truth and
  `rebuildRollup` reproduces every bucket from it. It is written in `append`'s transaction, pruned
  with the rows it summarizes, rebuilt after a restore or import, and compared by `omni doctor`. A
  read of it is flat where a `SELECT SUM` over the window grows without bound — and `bun:sqlite` is
  synchronous, so that scan blocked the whole event loop, not one request. For the same reason a
  timeout around a store read is a bound that cannot fire; do not add one back.
- `quota_windows` stores provider observations, not gateway counts. Missing data means unknown, not
  unlimited. Probe failure must never disable a credential.
- RTK filter ids are persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is a storage
  contract, not an internal enum. `isRtkFilterId` drops unknown ids on read, so renaming one loses
  history silently rather than failing. Add ids freely; rename or remove only with a migration.
- The limit vocabulary — `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` — is persisted as
  the JSON keys of `api_keys.limits` in every row, so it is a storage contract of the same class.
  Unlike RTK ids it fails **closed**: an unknown dimension or window is a parse failure, never a
  silent drop, because a limit read as "no limit" fails open on a ceiling the operator set. Add
  names freely; rename or remove only with a migration.
- Refuse at auth, degrade at list. A row whose `limits` will not parse reads back as
  `ApiKey.limits === null`, distinct from `{}`, and `authenticateApiKey` turns that into
  `INTERNAL` — not `AUTH`, which would blame a credential that is fine. `keys.list()` must never
  throw over one such row: `toKey` serves the listing as well as the auth lookup, and the listing is
  how an operator finds the row to fix. Nothing may collapse the null into `{}` on the way to the
  CLI or console.
- `limits` is the one field on a key that is editable after minting, through `setKeyLimits` and
  `PUT /api/keys/:id/limits`; `bodyLoggingOptOut` deliberately has no such path. An opt-out is a
  promise to whoever holds the key, while a limit is the operator's own ceiling on their own
  installation. The matrix is written whole — `{}` is how the last limit goes away, and it must land
  as `{}` rather than a husk like `{"requests":{}}` or the outer `null` that means unreadable.
- The usage on `ApiKeySummary.limitUsage` is committed rows only, so it is a floor on what the
  limiter sees and never the limiter's own number: the gateway adds a process-local delta and the
  `concurrency` gauge is not stored at all, which is why its `used` is `null` rather than `0`.
- API-key limits are enforced over *sliding* windows. A fixed window resets on a clock edge and lets
  a key spend a whole window's allowance either side of one, at every window size. `1m` is exact from
  a ring of timestamps in `apps/gateway`; longer windows read `usage.sumSince`, which must filter
  `state = 'done'` or every in-flight request's placeholder metrics inflate the count.
- A long-window count is `usage.sumSince` plus the in-memory delta since that read, cached 30s. The
  composition may over-count — events aging out between the read and now are not subtracted — and
  must never under-count, so the delta keeps everything recorded at or after the read instant. A
  limiter whose error ran the other way could be walked through by timing the refresh. A failed or
  slow `sumSince` serves the request and logs it through existing `LogFields` keys; only the long
  windows degrade, because `requests` at `1m` and `concurrency` never touch the store.
- The token and spend debit lives in `finishLog`, beside `usage.append` and never inside
  `@omni/store`. That site already runs at most once per request id, which is exactly the guarantee
  the debit needs and would otherwise have to re-establish.
- The concurrency gauge is decremented at request scope and nowhere else. A streaming handler returns
  its `Response` while the request is still running, so a `finally` around the handler body fires
  when the head is sent, and a decrement beside the debit sits behind a store write. Streams free the
  slot from `sseResponse`'s run-once completion, which covers a drained stream, a broken one, and a
  hang-up alike. No window expires a gauge: a leak locks the key out until restart, silently.
- `ProviderModelChoice.auth` is enforced at write time in `putModel`, never at routing. Which ways
  in exist is installation state, so the catalog exports the fact (`catalogModelAuths`) and control
  owns the rule. A provider with no credential is unknown rather than blocked, an unlisted model is
  unknown rather than forbidden, disabled credentials still count, and a target already stored under
  that id is exempt so removing a credential cannot make an unrelated edit unsavable.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats are
  decoded away. Keep server idle timeout above request deadline.
- Stdout holds operational events; `request_logs` holds completed requests. Do not restore duplicate
  per-request access lines. `requestId` joins both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` names an
  existing capture; it does not create one.
- Docker image contains gateway only; npm package contains CLI, gateway, and dashboard.
- OpenAI OAuth routes to narrower Codex surface. OAuth-specific encoding stays behind existing
  `oauth` flag.
- A snapshot is the database alone. `request_bodies/` is excluded, so a downloaded snapshot is never
  a prompt corpus and its size never tracks prompt volume. After a restore, body rows and artifact
  files disagree until `sweepOrphans` reconciles them; that is expected, not a bug.
- A snapshot still carries encrypted credentials and API-key hashes. Downloads are `no-store`, and
  the file is inert only because `OMNI_ENCRYPTION_KEY` is not in it.
- Restart asks systemd rather than signalling itself. The unit sets `Restart=on-failure`, so a
  handled SIGTERM exits 0 and reads as success — self-SIGTERM stops the gateway for good. `--no-block`
  is required: systemd tears down the unit cgroup including the `systemctl` client it just spawned.
- The quiesce latch gates `/v1/*` only. `/api/*` and `/health` stay live through a swap, because an
  operator watching a restore recovers through exactly those routes.
- `store.close()` is idempotent and `reopen()` tolerates a closed handle, so restore is close → swap
  → reopen. Repo methods forward per call to the inner handle: bind one to a local and it dies at the
  next swap.
- `vacuum()` must checkpoint. In WAL mode the rewrite lands in the log, so page count falls while the
  file keeps every page and every caller reports reclaiming nothing.
- Restoring writes another installation's admin password hash without passing through `setPassword`,
  which is what clears sessions. Restore compares the hash across the swap and invalidates only when
  it differs. Nothing may sit between the swap and that comparison: the swap has already succeeded by
  then, so a step that throws in front of it skips the invalidation while the new password is live.
- `swapIn` ends by rebuilding `usage_rollup`, after the hash comparison and guarded. `bun:sqlite` is
  synchronous, so the rebuild blocks the event loop — and therefore `/api/*` and `/health` — for
  ≈0.4 s per 500k `request_logs` rows, ≈1.6 s at 2M, ≈6.5 s at 8M. Document the cost rather than hide
  it; a stale rollup is a `doctor` complaint, a failed restore is an outage.
- `omni db restore` refuses while a gateway is running and has no override. The dashboard swaps
  inside the process owning the handle; a second process cannot quiesce that connection, and renaming
  the file under it corrupts the database being rescued.

## Subagent workflow

- Orchestrator creates implementation subagent, then separate review subagent. Subagents do not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; do not use worktrees.
