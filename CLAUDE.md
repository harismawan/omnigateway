# OmniGateway Repository Guidance

Guidance for an agent working in this repository. It is the contributor-facing
document: architecture, boundaries, conventions, and the reasons behind them.

`README.md` is the other half, and is for people *using* OmniGateway — install,
first run, the client API, the CLI, configuration, operational limits. Keep the
split when editing either: a repository map or a testing convention does not
belong in the README, and an operator does not need the dependency direction to
point a client at the gateway. When a change affects both audiences, update both.

## Scope

OmniGateway is a Bun/TypeScript monorepo for a self-hosted AI gateway. Three front ends are implemented over one core: the gateway under `apps/gateway`, the admin console under `apps/dashboard` whose built output the gateway serves, and the `omni` CLI under `apps/cli`. Admin operations themselves live in `packages/control`, which both the gateway routes and the CLI drive. Treat approved documents under `docs/superpowers/specs/` and `docs/superpowers/plans/` as product requirements, but verify current code before assuming plan snippets still match implementation.

## Commands

Use Bun from repository root:

```bash
bun install
bun run dev              # gateway with file watching
bun run start
bun test                 # gateway, CLI, control, router, IR, providers, store
bun run typecheck        # core and dashboard
bun run lint
bun run fmt
```

Release:

```bash
bun run build:npm v1.2.3   # assembles dist/npm: bundled CLI, bundled gateway, dashboard as public/
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which verifies, builds, and publishes `omnigateway` to npm. The tag is the only place a version is written down; the workspace manifests stay private at 0.0.0.

Publishing uses npm trusted publishing: npmjs.com is configured to trust `release.yml` in this repository, and exchanges the workflow's OIDC token for a short-lived credential. There is no secret in the repository, and provenance is attached automatically. `0.1.0` was published by hand to claim the name, because npm can only be told to trust a workflow for a package that already exists; every release since has gone through the tag.

CLI:

```bash
bun apps/cli/src/index.ts --help   # run it in place
cd apps/cli && bun link            # then `omni` is on PATH (registers the cwd package; it takes no path argument)
omni doctor --root <install>       # what it resolved, and whether it can act on it
```

Dashboard:

```bash
bun run dev:dashboard              # Vite on 5173, proxies /api and /oauth to 9000
bun run build:dashboard            # writes apps/dashboard/dist, which the gateway serves
bun run --cwd apps/dashboard test  # needs a DOM; excluded from the root run
```

`bunfig.toml` excludes `apps/dashboard/test/**` from the root `bun test`, so a green root run says nothing about the dashboard. Run focused tests with `bun test <path>`. Before claiming completion, run tests covering changed behavior plus full `bun test`, the dashboard suite, `bun run typecheck`, and `bun run lint`.

## Documentation

- `README.md`: for users. What it is, install, first run, client API, CLI,
  configuration, security, limits. No repository layout, no test conventions.
- `CLAUDE.md`: this file. For whoever changes the code.
- `docs/superpowers/specs/`: the approved design behind each feature, with the
  reasoning. Read the relevant one before changing that area.
- `docs/superpowers/plans/`: the implementation plans those specs produced.

Specs, newest first:

- `2026-08-09-agent-client-context-and-setup-design.md` — why no agent reads its context window from `/v1/models`, generated client config, and the missing `/v1/responses`
- `2026-08-08-omnigateway-cli-design.md` — the CLI, and the extraction into `packages/control`
- `2026-08-08-provider-model-catalog-design.md`
- `2026-08-06-provider-chooser-focus-return-design.md`
- `2026-08-05-dashboard-redesign-design.md`
- `2026-07-31-client-identity-profiles-design.md`
- `2026-07-31-omnigateway-design.md` — the original system design

Plans sit beside them under `docs/superpowers/plans/` with matching names.
A plan records what was intended at the time; verify the current code before
assuming a snippet still matches.

## Repository map

- `apps/gateway/src/app.ts`: dependency-injected Elysia application composition
- `apps/gateway/src/index.ts`: production bootstrap, config, SQLite, maintenance, server lifecycle
- `apps/gateway/src/ingress/`: Anthropic/OpenAI request parsing into canonical IR
- `apps/gateway/src/dispatch/`: upstream attempts, refresh, failover, deadlines, stream commit
- `apps/gateway/src/routes/`: client, admin, and OAuth control surfaces
- `apps/gateway/src/routes/models.ts`: the `/v1/models` listing, including the token limits it advertises; the route feeds it the routing snapshot rather than its own store reads, so the listing cannot disagree with dispatch about which credentials exist
- `packages/control/src/modelLimits.ts`: how much a virtual model holds and what to call it, shared by the `/v1/models` listing and by the setup writers, so a pool is never described one way to a client and another to the operator
- `packages/control/src/setup.ts`: the configuration files Claude Code and opencode read at startup, generated for both `omni setup-*` and `GET /api/agent-setup`
- `packages/ir/src/tokens.ts`: the local prompt estimate behind `POST /v1/messages/count_tokens`
- `apps/gateway/src/ingress/model.ts`: unwinds a `claude/` discovery mirror and a `[1m]` suffix, during parsing and so before the key allowlist
- `apps/gateway/src/auth/`: gateway API-key authentication and its process-local rate limiter
- `packages/ir/`: provider-neutral domain types, error mapping, and the pure structured logger
- `packages/ir/src/logger.ts`: level filtering, safe `LogFields` allowlist, deterministic line formatting, `parseLine` reading a rendered line back, and no-op logger; sinks are injected by callers
- `packages/control/src/console.ts`: resolves where stdout was captured and reads it back, over an injected filesystem and command runner
- `packages/router/`: pure candidate selection and routing state
- `packages/control/`: every admin operation, the OAuth connect flow, admin auth, config parsing, and the quota probe
- `packages/testkit/`: shared test fixtures (`@omni/testkit`), used by the gateway, router, control, and CLI suites
- `packages/providers/`: provider adapters, OAuth, HTTP client, wire rendering/parsing
- `packages/store/`: store interfaces, encryption, SQLite repositories, migrations
- `packages/store/src/sqlite/rollup.ts`: the `usage_daily` rollup, written in the same transaction as each request log
- `apps/gateway/src/oauth/scheduler.ts`: background sweep that refreshes OAuth tokens before they expire
- `packages/control/src/oauth/usage.ts`: tolerant readers shared by the per-provider `parseUsage` functions
- `packages/control/src/quota.ts`: one probe of a provider's reported quota, and one pass over every credential
- `apps/gateway/src/quota/poller.ts`: the timer that runs that pass on an interval
- `packages/router/src/quota.ts`: pure reading of a quota snapshot into a routing signal
- `apps/gateway/test/`: gateway unit, route, integration, and end-to-end tests
- `packages/providers/src/{anthropic,openai,kimi}/models.ts`: per-provider model catalog with list pricing and token limits
- `packages/providers/src/catalog.ts`: assembles them; exported at `@omni/providers/catalog`
- `apps/dashboard/src/api/`: typed control-API client and TanStack Query hooks
- `apps/dashboard/src/ui/`: styled-components primitives (Panel, Table, Lamp, Meter, Sparkline)
- `apps/dashboard/src/features/`: one directory per screen
- `apps/dashboard/src/routes/`: TanStack Router file routes; `_app.tsx` is the session guard
- `apps/cli/src/run.ts`: one invocation, from argv to exit code, with every side effect injectable
- `apps/cli/src/context.ts`: installation root resolution, `.env` loading, lazily opened store
- `apps/cli/src/service.ts`: systemd delegation and the pidfile supervisor behind it
- `apps/cli/src/commands/`: one module per command group

## Architectural boundaries

Preserve these constraints:

1. `packages/ir` stays provider-independent and side-effect-free. Its structured logger is allowed because clocks and sinks are injected; it must never import `process`, `console`, or a transport.
2. Provider-specific wire formats, headers, signing, and stream decoding stay in `packages/providers`.
3. `packages/router` stays pure: no network, database, token refresh, or timers.
4. Dispatch owns side effects, retries, refresh, request deadlines, and streaming commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render client-compatible responses, and record metadata. An admin operation belongs in `packages/control`, not in a handler: a rule enforced only on the HTTP path is a rule the CLI does not have.
6. `packages/control` knows nothing about how it was called — no Elysia, no cookies, no argv, no terminal, no timers. Loops that only a long-lived process wants (the refresh scheduler, the quota poll timer) stay in `apps/gateway`.
7. Store rows and secrets remain behind `@omni/store`; never expose encrypted or raw provider secrets through control APIs.
8. All outbound provider HTTP goes through the `HttpClient` seam. Do not add direct production `fetch` calls.
9. The provider model catalog is provider-specific data and lives in `packages/providers`, never in `packages/ir`. `@omni/providers/catalog` is imported by the browser bundle, so it must stay a leaf: it may import the three model lists and a type, and nothing else.
10. Catalog pricing is a source of defaults, not of truth. The router prices a request from the target the operator saved; editing the catalog changes only what a new target starts with.
11. The CLI is a local tool: it reaches the store directly through `@omni/control` and never through `/api/*`. Every side effect it has — spawning, signalling, systemctl, `/health` probes, prompting — goes through an injected seam, so no test starts a process or writes outside a temporary directory.
12. The dashboard calls `/api/*` only. It may import types from `@omni/store/types` and `@omni/ir`, and the catalog subpath, but must not import provider adapters, the HTTP client, or anything from `packages/store` at runtime.

## TypeScript and style

- Strict TypeScript is required.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are enabled.
- Never commit `any`, including tests. Use `unknown` and narrow it, or define a named type.
- Use ESM imports with explicit `.ts` extensions, matching surrounding code.
- Match existing naming, comment density, and formatting.
- Biome uses 2-space indentation and 100-column lines.
- Avoid unrelated refactors while changing behavior.

Dashboard specifics:

- Styling is styled-components. There is no Tailwind and no CSS file; do not reintroduce either.
- Palette values are CSS custom properties defined in `theme/GlobalStyle.ts`; `theme/tokens.ts` only points at them. That is what lets the light/dark switch repaint without re-rendering, and what lets the pre-paint script in `index.html` set the mode before React boots.
- Colour carries exactly two meanings: which provider a row belongs to, and what state something is in. Do not introduce decorative colour.
- Transient style props are prefixed `$` so they do not reach the DOM.
- Fonts are self-hosted through `@fontsource`. Never add a CDN font or any other third-party origin: the gateway promises no phone-home.

## Testing conventions

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores and stub `HttpClient`; tests must not call live providers.
- Use synthetic tokens and credentials only.
- Cover both non-streaming and streaming paths when changing dispatch or adapters.
- Preserve pre-commit failover versus post-commit stream behavior.
- Test both Anthropic and OpenAI error surfaces when changing shared proxy behavior.
- Authentication changes must cover Bearer and `x-api-key`, malformed input, conflicts, revoked keys, allowlists, and rate limits where relevant.
- Deadline tests must distinguish gateway timeout from downstream client cancellation and must not leave timers/listeners active.

Dashboard tests:

- Run under happy-dom via the preloads in `apps/dashboard/test/setup/`.
- Stub the network with `test/helpers/fetchStub.ts`; an unstubbed route returns a loud 501 rather than hanging.
- Use `renderWithProviders` for features, `renderWithRouter` for anything that navigates.
- Assert on what the operator sees — visible text, roles, accessible names — not on class names or component internals.
- A component mounts only after its data loads, so re-query the DOM after waiting; an element found earlier belongs to a component that has since been replaced.

## Security and privacy

- Never log prompt bodies, response bodies, OAuth tokens, API keys, admin passwords, or encryption keys.
- Raw gateway API keys are returned once at creation and stored only as hashes.
- Provider credentials are encrypted at rest with `OMNI_ENCRYPTION_KEY`.
- Do not introduce default encryption secrets or commit `.env` files/databases.
- Keep client-facing errors free of provider tokens, credential IDs, and internal stack traces.
- Preserve admin session checks on every `/api/*` route except documented setup/status/login flows.

## API contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, and error shape
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, and error shape
- `GET /v1/models`: authenticated and filtered by calling key model allowlist, and describing each model in both dialects at once
- `POST /v1/messages/count_tokens`: authenticated local estimate of a prompt's size
- `GET /health`: unauthenticated liveness

Every `/v1/*` request accepts `Authorization: Bearer <key>` or `x-api-key: <key>`. Conflicting credentials must be rejected. A `null` model allowlist means unrestricted; an empty array denies all models.

Ingress accepts the shapes current clients send, and these are contracts:

- A `{"role": "system"}` entry inside `messages` is a mid-conversation system message. Carry it in place. Never fold it into the request-level `system` prompt: that moves the instruction to the front of the conversation, changes when it takes effect, and invalidates the provider's cached prefix.
- `thinking` accepts `adaptive`, `enabled` with a budget, and `disabled`. Never synthesize a token budget from an effort level — current models reject that form. An explicit `disabled` must be forwarded, because omitting `thinking` is not the same thing on models that think by default.
- A thinking block is replayable only where it was signed. Anthropic signs its reasoning and verifies that signature on every later turn carrying the block; OpenAI's reasoning summaries carry none, and the decoder still renders them as `thinking` because the console and the client display them. `ContentBlockStart` therefore carries `signed`, set only by the Anthropic decoder, and both directions enforce it: the Anthropic-shaped egress drops an unsigned thinking block rather than hand a client something it will replay (renumbering the remaining blocks, because Anthropic indexes content contiguously from zero), and `anthropic/wire.ts` drops an unsigned one out of inbound history, noting `anthropic:unsigned-thinking-dropped` and dropping a message left with no content at all. Without the second half, switching a live conversation from an OpenAI pool to an Anthropic one fails every subsequent turn with `Invalid \`signature\` in \`thinking\` block`. A signature is also accumulated across `signature_delta` events rather than assigned, and an empty one is treated as absent rather than sent.
- `anthropic-beta` is carried on the request as `betas` and re-emitted by the adapter, merged with the OAuth beta the OAuth path requires. A beta is a header *and* a body field: the field rides through `vendor` passthrough, so forwarding one without the other turns a legitimate request into an upstream 400 on an unknown key.
- A nested `cache_control` marker is caller intent and survives to the upstream body, on the same block, TTL included. Caching is a prefix match, so moving a breakpoint changes what is cached and dropping one bills a repeated prefix as fresh input. The blocks the gateway itself prepends — the OAuth identity, the billing header, the agent preamble — stay unmarked. `IR` models it as `CacheControl` on every block Anthropic can cache plus `ToolDef`, never on a thinking block, which Anthropic rejects. Anthropic accepts a block array on a mid-conversation `role: "system"` turn but ignores a nested marker there. When the final system-turn marker is on the request's final cacheable text block, the encoder preserves that boundary with top-level automatic `cache_control`; any earlier system-turn markers still record `anthropic:system-turn-cache-control-dropped`, as does a final marker that cannot be promoted without broadening the cached prefix. Other losses are silent because nothing was expressible to begin with: a marker on a thinking block, on a block whose text filters away entirely, on a message whose content ends up empty and is dropped with it, or on a request routed to OpenAI or Kimi, whose encoders have no field for one and whose upstreams cache without being asked.
- Both ingresses read cache breakpoints, because either can route to an Anthropic target. The OpenAI surface accepts the two spellings its clients send: on a content part, and on the message or tool object. Anthropic takes a marker only on a content block, so a message-level one lands on that message's last block and a block-level one outranks it. The Anthropic surface refuses a marker it cannot express, because there the field is part of the contract; the OpenAI surface ignores one, because there it is a best-effort translation and refusing would break callers that worked before the field was read at all. Ordering between `1h` and `5m` breakpoints is the caller's to get right — the gateway never reorders marked blocks, so a request Anthropic would accept directly still arrives valid.
- Anthropic-compatible responses report `cache_read_input_tokens` and `cache_creation_input_tokens` beside `input_tokens`, streaming and buffered. OpenAI-compatible responses report `prompt_tokens_details.cached_tokens`, and their `prompt_tokens` is the whole prompt with the cached share inside it — that is what the surface promises, so a client can subtract one from the other.
- Every adapter streams upstream regardless of what the client asked for, and an OpenAI-compatible chat stream reports no `usage` object at all unless the request sets `stream_options.include_usage`. Kimi's wire sets it; dropping it does not fail a request, it files one that cost nothing and cached nothing. The Responses API needs no such flag — `response.completed` always carries usage.
- Cached-token field names differ by surface: `input_tokens_details.cached_tokens` on the Responses API, `prompt_tokens_details.cached_tokens` on chat-completions. The OpenAI decoder reads its own name first and falls back to the other, because an OpenAI-compatible endpoint may use either; Kimi reads the chat-completions name and falls back to `prompt_cache_hit_tokens`, the DeepSeek-family spelling.
- The four token classes are disjoint and each is priced once, in `apps/gateway/src/dispatch/price.ts`. Cache writes cost *more* than fresh input, not less: Anthropic bills a 5m write at 1.25x base input and a 1h write at 2x, so `Usage` carries the per-TTL split Anthropic reports in `cache_creation` and a target prices each separately. A target that names no write price falls back to its *provider's* multiplier rather than to zero, so a target saved before write pricing still bills something for Anthropic and nothing for OpenAI or Kimi, whose catalog entries carry an explicit zero. The fallback cannot be one constant: those two answers are opposite, and a Kimi target can report cache-creation tokens.
- `Usage.inputTokens` changed meaning for OpenAI and Kimi when the decoders were normalized, and rows written before that still count cached tokens inside it. Nothing rewrites them, so a chart or rollup spanning the change mixes two definitions and over-reports prompt volume for those two providers. The console stacks the classes as disjoint, which they now are and were not.
- `Usage.inputTokens` is the *uncached remainder*, never the whole prompt. Anthropic reports input already net of cache; OpenAI and Kimi count cached tokens inside their prompt total, so those decoders subtract via `usageFromPromptTotal`. Pricing adds `cacheReadTokens` at the cache rate on top of `inputTokens`, so a decoder that leaves the overlap in bills those tokens twice — once at full input price and again at the cache rate. `promptTokens()` adds the parts back for a surface that wants one number.
- A provider that cannot express something the client asked for records a degradation rather than dropping it silently. Degradations reach the request log.
- `GET /v1/models` states how much context a model holds: an entry carries `max_input_tokens` and `max_tokens` beside the OpenAI-shaped keys, read from the target the operator saved and falling back to the catalog. A pool reports the *smallest* window any of its targets names, because failover can land on any of them, and a model where nothing is known reports nothing rather than a zero. OpenAI-dialect clients read these fields. **Claude Code does not** — measured against 2.1.226, it ignores the listing entirely for sizing and assumes 200K for any id its built-in table does not know, while opencode takes the number from its own config file. `omni setup claude` writes one `~/.claude/settings.json` with explicit default/Fable/Opus/Sonnet/Haiku pool mappings; it no longer writes one context-sized profile per pool because one process-global context variable cannot describe several model classes. `omni setup opencode` still writes per-model limits. `GET /api/agent-setup` serves equivalent generated files to the console. See `docs/superpowers/specs/2026-08-09-agent-client-context-and-setup-design.md` for measurements and `docs/superpowers/specs/2026-08-10-claude-setup-and-dashboard-scroll-design.md` for the revised setup design.
- Claude Code's model picker lists only ids beginning with `claude` or `anthropic`, so a pool named `opus` or `gpt-5.6-sol` is invisible there. With `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` set, the listing also advertises a `claude/<id>` mirror of every other pool, carrying that pool's limits and a `root` back-pointer, and ingress unwinds the prefix again. The separator is a slash, not a hyphen, because the client ignores `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for an id beginning `claude-` — a mirror spelled that way would be visible and permanently pinned to 200K. `claude/` is a reserved namespace: `modelSchema` refuses a pool id in it, since such a pool would be shadowed by its own mirror rule. Unwinding happens during parsing, which puts it *before* the key allowlist: a key denied `gpt-5.6-sol` is equally denied `claude/gpt-5.6-sol`, and moving it later would turn the mirror into a way around policy.
- `[1m]` after a model name is a client-side assumption plus a header. Claude Code strips the suffix and sends `context-1m-2025-08-07`; ingress accepts either spelling and folds the suffix into `betas`, so the encoders gate on one thing. The Anthropic adapter forwards that beta only where the catalog does *not* report a smaller window — an unlisted model is an operator's own id, about which nothing is known, and guessing "no" would break a custom 1M target that works today. The OpenAI and Kimi encoders have no beta mechanism at all, so they record `openai:context-1m-dropped` / `kimi:context-1m-dropped` rather than losing the request silently while the client keeps pacing itself against a megabyte.
- `POST /v1/messages/count_tokens` answers `{"input_tokens": n}` from `estimateInputTokens` in `packages/ir`, with no upstream call. It counts every block class — text, images, tool-use arguments, tool-result content, thinking, the system prompt and tool schemas — because a real agentic conversation keeps most of its tokens inside tool results, and an estimator that walked only `text` would return near-zero for a session minutes from its limit. It writes no request-log row: nothing was dispatched, and a row would be counted by every usage aggregate. The figure is an estimate for pacing compaction and is never billed from.
- `Target.contextWindow` and `Target.maxOutputTokens` are advertised, never enforced: an over-long request still fails upstream. Unlike pricing, they are resolved when the listing is built rather than copied onto a target when it is saved, because the answer depends on the credential: the OpenAI adapter routes an OAuth credential to Codex, which caps a prompt at 272,000 tokens where `api.openai.com` takes 922,000. A provider with both kinds of credential is described by the narrower. That is why the console and `--from-catalog` leave both fields empty — a saved figure is an operator override that pins one of those answers.
- The OpenAI catalog's `contextWindow` is the published cap on *input* (922,000), not the 1,050,000 context window, because the field is advertised as the size of prompt a client may send.

Control surface uses `/api/*`, never `/admin/*`. Dashboard code must call `/api/*` and must not assume WebSocket log streaming; current design polls logs.

`GET /api/console` is the gateway's own output, as opposed to `/api/logs`, which is what clients asked for. It returns the resolved `source` alongside the lines, because the screen states which log it is reading and cannot without being told. The `journalctl` argv is fixed and nothing from the query reaches it — `lines` is clamped, `level` is parsed to one of four words or dropped — and the spawn is behind the injected runner, so no test spawns a process.

## Configuration

`OMNI_EXPOSE_CLAUDE_CODE_ALIASES` (`1`/`true`/`yes`/`on`) turns on the `claude/<id>` discovery mirrors, off by default and read once at boot. `OMNI_ENCRYPTION_KEY` is mandatory and changing it invalidates existing encrypted credentials. `OMNI_BASE_URL` must be public origin behind reverse proxy. Provider identity environment overrides are startup configuration; validate and keep built-in defaults when absent or invalid.

## Subagent workflow

- For subagent-driven work, orchestrator creates implementation subagent, then separately creates review subagent; subagents must not spawn nested subagents.
- Use `feat/*` branches for subagent implementation work; do not use worktrees.

## Known constraints

- Version 1 is single-node and single-operator.
- A non-streaming `POST /v1/messages` to an Anthropic target fails with `upstream stream ended before message_stop`. The OpenAI and Kimi adapters force `stream: true` on the upstream body and collect the events themselves (`openai/index.ts`, `kimi/index.ts`); the Anthropic adapter forwards the client's own flag, sends `Accept: application/json`, and then parses the JSON response with `parseSse`, which yields no events. The streaming path — the one Claude Code and the console use — is unaffected, which is why this survived. Not a regression from the prompt-caching work: `anthropic/index.ts` is untouched by it.
- `OMNI_LOG_LEVEL` is read once at boot and defaults to `info`; an invalid value falls back to `info` and is reported. Stdout logging relies on `LogFields` being a closed allowlist with no index signature — that type is the redaction mechanism, not a convenience. Never add bodies, headers, tokens, keys, passwords, or unconstrained metadata to it; treat each new free-text field as a security-boundary change.
- Stdout and `request_logs` answer different questions and no longer overlap. A completed request produces a row and *no* line: the terminal access lines were deleted from `proxy.ts` because they restated a row, less completely, where nothing could query them. What stays on stdout is what never becomes a row — failover, auth and rate-limit rejections, store-write failures, boot, oauth, quota. `requestId` is on both and joins them. Do not reintroduce a per-request access line. The one survivor is `request rejected`, a warn on the outer catch: a rejection's reason is free text (`model "x" is not allowed for this API key`) and `request_logs` has a status and an error code and no column to hold it.
- The console view of stdout reads whatever *captured* it, because a process cannot read back its own output: `OMNI_LOG_FILE`, else the systemd journal, else nothing. `OMNI_LOG_FILE` *names* an existing capture and never creates one — setting it without redirecting stdout leaves the screen empty, which is the first thing an operator will try. `none` is a first-class answer and both surfaces state it — that is the ordinary `bun run dev` case, not a failure. The gateway detects journald capture through `JOURNAL_STREAM`, which systemd sets on a unit's stdout, and reads `MANAGERPID` to tell a user unit from a system one (a user manager sets it; a UID check answers neither question, since a system unit can run as a non-root `User=`). The CLI is a separate process and cannot see either, so it asks whether a unit is installed and claims its own state directory's log file only once that file exists. `omni start` redirects the gateway it spawns *and* sets `OMNI_LOG_FILE` to the same path, since under a pidfile supervisor nothing else would tell it.
- Both console readers bound what they pull in: `tailFile` seeks backward from the end in 64 KiB chunks for at most 8 MiB, and a journal read is `-n`-limited, so an unbounded log cannot be slurped into memory to show 200 lines. A filtered query scans wider than its page (20x, capped at 5,000) because the error the operator opened the screen for is usually older than the last 200 lines.
- `parseLine` recovers only the instant, level, and message. Structured fields stay unparsed because they are already rendered in `raw`, and a second definition of the format could disagree with `formatLine`. The message/field boundary is two spaces before a `k=`, which is lossy and cannot be otherwise without changing the rendered format: a message containing `"  reason=x"` would truncate there. Safe only because every message is a fixed literal and `msg` is used for display and filtering, never dispatch — a message needing an `=` belongs in `reason`, which is quoted. A line that does not parse — systemd's own notices, a runtime stack trace — is kept with null fields and survives a level filter, because that is often the line explaining a crash; a `since` filter drops it instead, having no instant to compare.
- Usage has two grains. `/api/usage?grain=raw` reads `request_logs`, which is pruned at `logRetentionDays` (30 by default) and is the only grain that resolves to the hour. `grain=daily` reads `usage_daily`, kept for 400 days, and is the only grain that answers a year. A day key is the *host's local* midnight fixed at write time: rollup rows cannot be re-bucketed into another timezone afterwards, and changing the host timezone does not rewrite history.
- A `request_logs` row is filed `pending` by `usage.begin` when dispatch selects its first provider/model/credential, updated by `usage.route` if failover selects another attempt, and upserted to `done` by `usage.append` when the request ends. A pending row's `status`, `attempts`, tokens, cost and duration are placeholder zeros, never measurements — read `state`, never `status`, to tell the two apart. Only completion writes `usage_daily`, and `append` must therefore run at most once per id: the upsert no longer throws on a duplicate, so double-counting the rollup is the failure mode that replaced it. Raw-grain aggregation excludes pending rows in SQL, and the console excludes them again in `summarize`/`bucketLogs`. Rows still pending at boot are swept to `499`/`interrupted` with a zero duration, because nobody knows when the process died.
- API-key rate limits are process-local, reset on restart, and are not shared across instances.
- `quota_windows` holds what the *provider* reported, not what the gateway counted. Rows are written only by the quota poller, so a credential with no rows means the provider said nothing, which the console reads as `unknown` rather than as unlimited. A row is a reading from `observedAt`, not a live counter.
- The provider usage endpoints are undocumented and unversioned: `GET api.anthropic.com/api/oauth/usage` (`five_hour`/`seven_day`, each `utilization` = percent *used*), `GET chatgpt.com/backend-api/wham/usage` (`rate_limit.primary_window`/`secondary_window`, `used_percent`, `reset_at` in epoch seconds), `GET api.kimi.com/coding/v1/usages` (one weekly `usage` block whose counters are strings). Each probe is one fetch plus one pure `parseUsage`, and every failure path — non-2xx, unparseable body, missing window — reports nothing rather than guessing. A probe must never disable a credential: only token refresh may judge a credential dead, because a moved usage endpoint would otherwise retire working accounts.
- These quota endpoints are throttled separately from inference: a 429 means stop asking, not that the account is spent, and chat on the same token keeps working. Probes raise `RATE_LIMIT` on 429 and the poller parks that credential for `RATE_LIMIT_COOLDOWN_MS` (3 minutes, process-local).
- Anthropic's usage endpoint is not reached through the CLI's Stainless client, so the probe overrides the User-Agent to `claude-code/<version>` while `/v1/messages` keeps `claude-cli/<version> (external, cli)`. Per-model weekly windows (`seven_day_opus`), Codex feature caps (`code_review_rate_limit`, `additional_rate_limits`) and Kimi's per-minute `limits` array are deliberately not read: none is the plan window the router chooses between.
- Two refresh leads exist for one reason: the background sweep (`SCHEDULER_REFRESH_LEAD_MS`, 300s, swept every 60s) should refresh before any request needs to, and dispatch's shorter lead (`DISPATCH_REFRESH_LEAD_MS`, 120s) is the safety net for a fresh boot or a short-lived token. One process-wide `Refresher` is shared by the request path and both loops; its per-credential coalescing is what protects providers that rotate refresh tokens.
- `quotaPollIntervalMs` is read once at boot. Changing it takes effect on restart.
- A streaming response must keep writing bytes. Provider heartbeats are decoded away and never become IR events, so a long think produces no downstream traffic at all, and Bun closes an idle socket — Elysia defaults `idleTimeout` to 30s — which a client reports as a response truncated mid-flight rather than as an error. `sseResponse` writes a `: keepalive` SSE comment every `KEEPALIVE_MS` (10s) to prevent that. A buffered response cannot be paced that way, so `app.listen` also raises `idleTimeout` to Bun's maximum of 255s, which has to stay above `requestDeadlineMs` (120s by default).
- Quota steers routing by *pace*, not by raw headroom: `quotaHeadroom` divides fraction-remaining by fraction-of-window-remaining, so 5% left reads as fine minutes before a reset and as urgent with six days to run. A stale reading (older than three poll intervals), an unobserved row, or a window past its reset scores neutral rather than optimistic, and an OAuth credential with nothing reported scores neutral while an api-key credential scores unconstrained. `score`, `weighted` (draw weight scaled by headroom) and `roundRobin` (below-floor accounts demoted to the tail) all read it; `priority` deliberately keeps tier as the only primary signal.
- The CLI manages a *local* installation: it needs the database file and `OMNI_ENCRYPTION_KEY`, and it does not administer a remote gateway. Writing while the gateway runs is safe — the gateway rebuilds its snapshot per request — but the CLI cannot see process-local state (rate-limit counters, quota-poll cooldowns, in-flight OAuth flows, admin sessions), and a password change therefore does not evict a signed-in console until the gateway restarts.
- The CLI resolves an installation root (`--root` > `OMNI_ROOT` > cwd holding an installation > `~/.config/omnigateway`) and lets that root's `.env` win over the ambient environment. That is deliberately the opposite of the usual rule: Bun loads the *current directory's* `.env` into `process.env` before the CLI starts, so ambient-wins would make `omni --root /srv/omni` read one installation's database with another's encryption key. `omni doctor` prints the root and env file it chose.
- The Docker image builds the gateway only. It does not include `apps/dashboard`, so a container serves the APIs and returns 404 for the console. The npm package is the opposite: it carries the CLI, the bundled server, and the console together.
- The published package is one bundle, not six libraries. `workspace:*` cannot be resolved by npm, so `scripts/build-npm.ts` inlines the `@omni/*` packages into two files. `@node-rs/argon2` stays an external dependency because it is native, and Bun stays the required runtime.
- The published server finds the console at `./public` beside itself, and a checkout finds it at `apps/dashboard/dist`. `OMNI_STATIC_DIR` overrides both and is taken literally.
- `omni` runs the root's own `apps/gateway/src/index.ts` when the root is a checkout, and the bundled `gateway.js` beside the CLI otherwise. The checkout wins, because the root names the installation being managed.
- The gateway does not model which *model* accepts which request shape. Mid-conversation system messages and the several thinking forms vary by model and by platform, so an unsupported combination surfaces as an upstream 400 rather than being caught by the router.
- The OpenAI adapter routes OAuth credentials to the Codex backend, which is a narrower surface than `api.openai.com`: it rejects several standard parameters and refuses a system turn inside `input`. Path-specific handling belongs behind the `oauth` flag already threaded into the encoder.
