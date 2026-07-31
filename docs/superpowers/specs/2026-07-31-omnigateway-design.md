# OmniGateway — Design

**Date:** 2026-07-31
**Status:** Approved, ready for implementation planning

## Overview

An AI gateway that fronts multiple upstream LLM providers, holds a pool of OAuth
credentials per provider, and routes each request to the best available
credential using health, tier, cost, and latency signals.

Backend is Bun + Elysia. Dashboard is React + Vite. Storage is SQLite behind a
repository interface.

Clients speak either the Anthropic Messages API or the OpenAI Chat Completions
API. The gateway normalizes both to a canonical internal representation, routes
on that, and serializes the response back to whichever format the client used.
The response format is determined solely by the endpoint the client called —
`/v1/messages` returns Anthropic-shaped responses, `/v1/chat/completions`
returns OpenAI-shaped ones — regardless of which upstream provider served the
request.

### Client-facing surface

```
POST  /v1/messages           Anthropic Messages API, streaming and non-streaming
POST  /v1/chat/completions   OpenAI Chat Completions API, streaming and non-streaming
GET   /v1/models             Virtual models and aliases visible to the calling key
GET   /health                Liveness, unauthenticated
```

All `/v1/*` routes require a gateway-issued API key (`Authorization: Bearer` or
`x-api-key`, accepting whichever header the calling SDK sends).

### Providers (v1)

- Anthropic (Claude) — OAuth 2.0 + PKCE
- OpenAI (Codex) — OAuth 2.0 + PKCE
- Kimi Coding (Moonshot) — device code flow

### Non-goals (v1)

Explicitly out of scope. Each is a deliberate exclusion, not an oversight:

- **Multi-tenancy.** Single operator, one credential pool. Gateway API keys are
  labels for attribution and limits, not tenant boundaries.
- **Semantic caching / response dedup.** Every request reaches an upstream.
- **Prompt/response transformation.** No injection guards, no system-prompt
  rewriting, no token compression. Content passes through unmodified except for
  format translation.
- **Web-session / cookie providers.** Only official OAuth and API-key endpoints.
  No scraping of browser sessions.
- **Horizontal scaling.** Single node. The storage interface makes a
  multi-instance implementation possible later without a router rewrite, but no
  shared-state implementation ships in v1.

### Reference

`github.com/diegosouzapw/OmniRoute` was surveyed for prior art. Patterns adopted:
field-level AES-256-GCM encryption with lazy decryption, per-credential quota
windows, persistent circuit breakers, per-provider refresh lead times, and
stable synthetic device identifiers for Kimi. Its pairwise translator registry
was evaluated and rejected in favor of a canonical IR (see Architecture
Decisions).

## Architecture Decisions

### Canonical IR over pairwise translation

Three approaches were considered for moving requests between client and upstream
formats:

- **(A) Canonical IR.** Every inbound request normalizes to one internal shape.
  Adapters convert IR to and from provider wire formats. N+M adapters.
- **(B) Pairwise translator registry.** A registry keyed `"from:to"` holds a
  direct translator per format pair. N×M translators. This is OmniRoute's design.
- **(C) Passthrough-first hybrid.** Byte-proxy when client format matches
  upstream format, translate only on cross-format routes.

**Chosen: (A).** The deciding constraint is full virtual-model routing. The
router must score candidates on cost, latency, and token estimates, which means
it must understand every request semantically regardless of its wire format. A
canonical shape therefore has to exist. Approach A makes it the spine of the
system rather than a side channel.

Approach B's N×M cost compounds on the fourth provider, and its lack of a common
shape forces provider knowledge into the router. Approach C optimizes the
same-format path, but full model routing makes cross-format the common case, and
its fast path bypasses the request inspection that scoring depends on.

The cost of A is that the IR must be a superset of all provider capabilities.
Non-portable parameters are handled by a typed per-provider `vendor` bag rather
than by widening the IR on every provider release.

### The commit point

Once a byte of a streaming response reaches the client, failover is impossible.
Every request therefore has a commit point, and retries happen only before it.
See Dispatch.

## Repository Layout

Bun workspaces monorepo.

```
omnigateway/
  apps/
    gateway/          Bun + Elysia. Proxy and control API.
    dashboard/        React + Vite. Talks to the control API only.
  packages/
    ir/               Canonical types. Zero dependencies.
    providers/        Adapters: anthropic, openai, kimi. Depends on ir only.
    store/            Repository interfaces plus the SQLite implementation.
    shared/           Control API contract types. Used by gateway and dashboard.
```

### Gateway modules

| Module         | Responsibility                                                    | Depends on            |
| -------------- | ----------------------------------------------------------------- | --------------------- |
| `ingress/`     | Parse client request into `ChatRequest` IR                        | `ir`                  |
| `router/`      | Resolve virtual model, rank candidates                            | `ir`, `store`         |
| `dispatch/`    | Execute attempts, enforce the commit point, retry                 | `router`, `providers` |
| `egress/`      | Serialize `StreamEvent` into the client's wire format             | `ir`                  |
| `credentials/` | OAuth flows, refresh, encryption, health state                    | `store`               |
| `control/`     | REST and WebSocket API for the dashboard                          | all                   |

Boundary rules:

- `providers/*` never imports `store` or `router`. An adapter is a function of
  (IR, credential) to a stream, testable with no infrastructure.
- `router` never imports `providers`. It ranks candidate descriptors; it does not
  call anything.
- `dispatch` is the only module that knows both. It is the composition root.

This keeps the router — the component most likely to contain subtle bugs — a
pure function, unit-testable from a fixture with no HTTP or database mocking.

## The IR (`packages/ir`)

### Request

```ts
type ChatRequest = {
  model: string;              // virtual name or concrete; the router resolves it
  system?: ContentBlock[];    // always separate, never a message
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  stream: boolean;
  reasoning?: { effort: "low" | "medium" | "high"; budgetTokens?: number };
  vendor?: Partial<Record<ProviderId, Record<string, unknown>>>;
};

type Message = { role: "user" | "assistant"; content: ContentBlock[] };

type ContentBlock =
  | { type: "text"; text: string; cacheBreakpoint?: boolean }
  | { type: "image"; mediaType: string; data: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  | { type: "toolResult"; toolUseId: string; content: ContentBlock[]; isError?: boolean };
```

Four decisions worth stating explicitly:

- **`system` is a top-level field, never a message.** Anthropic requires it
  top-level; OpenAI expects it as the first message. Normalizing at the edge
  eliminates an entire class of system-prompt-hoisting bugs.
- **`content` is always an array.** Ingress widens a bare string into
  `[{ type: "text", text }]`, so downstream code handles exactly one shape.
- **`cacheBreakpoint` is a boolean on a block**, not Anthropic's `cache_control`
  object. The Anthropic adapter emits the object; other adapters drop the flag.
  The IR carries the semantic, not one provider's syntax.
- **`vendor`** carries genuinely non-portable parameters, typed per provider.
  Adapters ignore keys they do not own.

### Stream

```ts
type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "blockStart"; index: number; block: ContentBlockStart }
  | { type: "blockDelta"; index: number; delta: TextDelta | ThinkingDelta | JsonDelta }
  | { type: "blockEnd"; index: number }
  | { type: "usage"; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: "end"; stopReason: "stop" | "maxTokens" | "toolUse" | "stopSequence" }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };
```

Indexed blocks with explicit start, delta, and end events follow Anthropic's
streaming model, which is the richer of the two. OpenAI's flat
`choices[0].delta` is derivable from it; the reverse is not. The OpenAI adapter
reassembles its stream into indexed blocks — work it must do anyway to track
tool-call indices — and the OpenAI egress flattens back. The cost lands in one
place rather than in every consumer.

### Boundary validation

`validate(req)` runs once, in ingress, and enforces:

- Every `toolResult.toolUseId` matches a preceding `toolUse.id`. Orphans are
  dropped.
- Every `toolUse` has a non-empty `id`. Missing ids are synthesized.
- No two adjacent messages share a role. Adjacent same-role messages are merged.

These are handled once at the edge rather than inside each adapter.

## Router

A pure module: `rank(request, snapshot) => Candidate[]`. No I/O, no clock reads
(time arrives in the snapshot), no provider calls.

### Model resolution

```ts
type VirtualModel = {
  id: string;                 // "fast", "smart", "cheap"
  targets: Target[];
  strategy: "score" | "priority" | "roundRobin" | "weighted";
};

type Target = {
  provider: ProviderId;
  model: string;
  tier: number;               // 1 is preferred; spill to 2 when tier 1 is unavailable
  weight?: number;
  costPerMTok: { input: number; output: number; cacheRead?: number };
};
```

Concrete model names resolve through an alias table to a single-target virtual
model. Everything is therefore a virtual model, and aliases are the degenerate
case — one code path. A client requesting a concrete model still gets credential
pool balancing and never a silent model substitution, because that virtual model
has exactly one target.

### Candidate expansion

The cross product of targets and healthy credentials for each target's provider.
A target backed by three Anthropic accounts yields three candidates.

### Scoring

Additive, with configurable weights. Each term is normalized to 0..1.

```
score = w.tier    * tierScore(c)      // 1/tier; w.tier is much larger than the rest
      + w.health  * healthScore(c)    // 1 - (recentErrors / window)
      + w.quota   * quotaScore(c)     // remaining / limit for the active window
      + w.cost    * costScore(c)      // normalized against the cheapest candidate
      + w.latency * latencyScore(c)   // 1 - normalized EWMA of TTFT
      + w.recency * recencyScore(c)   // LRU spread; breaks ties
```

Default weights make tier dominant and recency a tiebreaker, so out-of-the-box
behavior is priority tiers with LRU spread inside a tier — predictable and easy
to reason about. Raising `w.cost` or `w.latency` shifts behavior smoothly. The
`priority`, `roundRobin`, and `weighted` strategies bypass scoring entirely for
operators who want strict determinism.

### Hard filters

Applied before scoring. These are exclusions, not penalties:

- Credential disabled, or token expired and not refreshable
- Circuit breaker OPEN and cooldown not yet elapsed
- `rateLimitedUntil > now`, set from an upstream `Retry-After` header
- Quota window exhausted
- Target model not in the requesting API key's allowlist

When every candidate is filtered out, the request fails with `NO_CANDIDATES`
carrying the per-candidate exclusion reasons, which the dashboard surfaces. This
is a gateway-level error rather than an upstream one, returned as HTTP 503 in
the client's error format.

### Quota window limits

Providers do not expose subscription quota limits through their APIs, so limits
cannot be discovered. Each `quota_windows` row therefore takes its limit from
operator-entered configuration on the credential, and `used` is incremented from
observed usage. A credential with no configured limit is never excluded by the
quota filter and scores a neutral `quotaScore`; it can still be excluded by
`RATE_LIMIT` once an upstream actually rejects it. Observed rate-limit responses
remain the authoritative signal; configured quotas are an optimization that
avoids spending a request to discover exhaustion.

### Health state

A circuit breaker per `(credential, model)` pair, not per credential — one model
being rate-limited should not sideline an account that is healthy for others.

States are CLOSED, OPEN, and HALF_OPEN. N consecutive failures opens the
breaker. After a cooldown it moves to HALF_OPEN, and a single trial request
decides whether it closes or reopens. Cooldown is exponential with jitter and a
cap; an upstream `Retry-After` header overrides the computed value.

### Snapshot

The router reads a plain object written by dispatch after each attempt:

```ts
type Snapshot = {
  now: number;
  credentials: Map<CredId, {
    healthy: boolean;
    breaker: BreakerState;
    rateLimitedUntil: number | null;
    quota: QuotaState;
    ewmaTtft: number;
    lastUsedAt: number;
  }>;
};
```

Held in memory, hydrated from SQLite on boot, and persisted on change with
debouncing. It sits behind the store interface, so a future multi-instance
deployment replaces the snapshot implementation rather than the router.

## Dispatch

The only module aware of both the router and the provider adapters.

### The commit point

Each attempt has two phases:

```
attempt(candidate):
  PRE-COMMIT   upstream connect, response headers, first content event.
               Errors here are retryable; the client has seen nothing.
  COMMIT       first content event received. Flush to client, lock in candidate.
               Errors after this are terminal and surface mid-stream.
```

The gateway holds the client's SSE connection open from the start of the request
but writes nothing until commit. Retries are therefore invisible to the client:
failing over from a rate-limited account to a healthy one appears only as a
slightly later first token.

Commit triggers on the **first `blockDelta`**, not on response headers.
Providers return 200 and then fail in-stream; waiting for actual content catches
that case. The cost is one event of buffering, which is negligible against what
it buys.

### Retry loop

```ts
for (const candidate of ranked.slice(0, maxAttempts)) {
  const r = await attempt(candidate, req);
  if (r.ok) return r.stream;             // committed; stream through
  recordFailure(candidate, r.error);     // updates breaker, rateLimitedUntil, EWMA
  if (!r.error.retryable) throw r.error;
  if (deadlineExceeded()) throw r.error;
}
throw new AllCandidatesFailed(attempts);
```

`maxAttempts` defaults to 3 and the wall-clock deadline to 120 seconds,
whichever is reached first. Both are configurable and both are overridable
per-request via header. Non-retryable errors fail immediately rather than
consuming the credential pool on a request that cannot succeed. A 401 or 403
marks the credential unhealthy and queues a token refresh before the next
candidate is tried.

### Error classification

Adapters normalize provider-specific errors into a shared `ErrorCode`:

| Code                        | Retryable | Snapshot effect                       |
| --------------------------- | --------- | ------------------------------------- |
| `RATE_LIMIT`                | yes       | `rateLimitedUntil` set from Retry-After |
| `QUOTA_EXHAUSTED`           | yes       | quota window marked exhausted         |
| `AUTH_FAILED`               | yes       | credential unhealthy, refresh queued  |
| `UPSTREAM_5XX`, `TIMEOUT`   | yes       | breaker failure count incremented     |
| `CAPABILITY_MISMATCH`       | yes       | none — the credential is not at fault |
| `BAD_REQUEST`, `CONTENT_FILTER` | no    | none                                  |

### Streaming

Adapter SSE becomes a canonical `StreamEvent` async iterable, which the egress
serializer converts to the client's format. The pipeline is pull-based
(`AsyncGenerator`), so client backpressure propagates to the upstream connection
without unbounded buffering.

Three concerns ride along the stream:

- **Cancellation.** A client disconnect aborts the upstream request through an
  `AbortSignal`, so the gateway stops paying for tokens nobody will read.
- **Usage capture.** The `usage` event is easy to lose on an early return, so the
  request log is written in a `finally` block and records regardless of whether
  the stream ended in success, error, or abort.
- **Heartbeats.** SSE comment lines during long pre-first-token gaps prevent
  intermediaries from idling out the connection.

Non-streaming requests use the identical path and collapse the resulting event
stream into a single response object, so the two paths cannot drift apart. When
a client requests a non-streaming response, the gateway still issues a streaming
request upstream. This keeps one code path and makes the commit point meaningful
for non-streaming requests too, since nothing is written to the client until the
full response has been assembled.

### Capability mismatches

A virtual model may span providers with differing capabilities. When the
resolved candidate cannot honor part of a request, the adapter degrades rather
than failing: `thinking` blocks are dropped for providers without reasoning
support, `cacheBreakpoint` flags are ignored where caching is unavailable, and
`vendor` entries for other providers are skipped. Each degradation is recorded
on the request log so the dashboard can show what was dropped.

Requests that cannot degrade — a tool-using request routed to a candidate with
no tool support, or an image block sent to a text-only model — fail that
candidate with `CAPABILITY_MISMATCH`. This is retryable in the sense that
dispatch advances to the next candidate, but it records no health penalty: the
credential is fine, it simply cannot serve this particular request. Capability
flags per target come from the virtual model configuration, and the router
filters on them where they are known ahead of time, so this is a backstop rather
than the primary mechanism.

## Credentials and Storage

### Storage interface

All persistence goes through `packages/store`, which exposes narrow repository
interfaces — `CredentialRepo`, `ConfigRepo`, `UsageRepo`, `KeyRepo` — rather than
a single data-access object. SQLite via `bun:sqlite` in WAL mode is the only v1
implementation. Migrations are numbered SQL files applied at boot and recorded
in a `migrations` table.

Repositories return domain types, never rows, so an alternative backend is a new
package rather than an edit at every call site.

### Schema

| Table               | Contents                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `credentials`       | One row per provider account: encrypted tokens, `providerData` JSON, tier, weight, enabled |
| `credential_health` | Breaker state, `rateLimitedUntil`, EWMA TTFT, consecutive failures. Hydrates the snapshot |
| `quota_windows`     | `(credentialId, windowType, startsAt, used, limit)` for rolling 5-hour, daily, and weekly windows |
| `virtual_models`    | Routing configuration: targets, tiers, weights, cost table, strategy          |
| `api_keys`          | Gateway-issued keys: Argon2id hash, display prefix, model allowlist, rate limit |
| `request_logs`      | One row per request. No prompt or response bodies                            |

### Encryption at rest

AES-256-GCM field-level encryption on `accessToken`, `refreshToken`, `apiKey`,
and `idToken`. The key derives from the `STORAGE_ENCRYPTION_KEY` environment
variable through scrypt. Ciphertext format is `enc:v1:<iv>:<ct>:<tag>`; the
version prefix makes key rotation a migration rather than a breaking change.

Decryption is lazy. The router reads credential metadata — tier, health, quota —
on every request but needs an actual token only for the winning candidate. So
`CredentialRepo.list()` returns metadata with token fields as thunks, and
ranking twenty candidates costs one decryption rather than twenty.

**If `STORAGE_ENCRYPTION_KEY` is unset, the gateway refuses to start.** Silently
storing live OAuth tokens in plaintext is the wrong default for a service whose
entire purpose is holding provider credentials. An `--insecure-no-encryption`
flag exists for ephemeral development and logs a warning on every boot.

### OAuth

Three flows behind one interface:

```ts
type OAuthProvider = {
  id: ProviderId;
  flow: "pkce" | "device";
  begin(): Promise<{ userUrl: string; state: string; pending: PendingHandle }>;
  complete(pending: PendingHandle, input: CodeOrPoll): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
};
```

Anthropic and OpenAI use PKCE; Kimi Coding uses device code. PKCE serves both
supported UI modes from one `begin()` — redirect mode returns to
`/oauth/callback`, and paste mode has the user hand the code back through the
dashboard. Both converge on `complete()`. The `pending` handle holds the
verifier, state, and nonce, never leaves the server, and expires after ten
minutes.

Kimi requires stable synthetic device identifiers, persisted in `providerData`;
its API rejects requests whose device identity changes between calls.

### Token refresh

Refresh is proactive, with a per-provider lead time defaulting to five minutes
before expiry. Providers that rotate refresh tokens use a longer lead, because
allowing a rotating refresh token to go stale can revoke the entire token family.

An in-process mutex per credential prevents concurrent refresh: two simultaneous
refreshes against a rotating-token provider will invalidate each other. On
refresh failure the credential is marked unhealthy and surfaced in the
dashboard, without a retry storm.

### Gateway API keys

Displayed once at creation, then stored as an Argon2id hash with a short display
prefix. Verified in Elysia middleware ahead of routing. Each key carries a model
allowlist and its own rate limit, and stamps every `request_logs` row for
attribution.

## Control API and Dashboard

### Control API

Served on the same Elysia instance under `/admin/*`, with separate authentication
— a session cookie obtained from an admin password, not a gateway API key.
Contract types live in `packages/shared` and are imported by both sides, so a
route signature change breaks the dashboard build rather than production.

```
GET/POST/PATCH/DELETE  /admin/credentials
POST                   /admin/credentials/:provider/oauth/begin
POST                   /admin/credentials/:provider/oauth/complete
GET/PUT                /admin/models        virtual models, tiers, cost table
GET/PUT                /admin/settings      scoring weights, retry limits
GET/POST/DELETE        /admin/keys
GET                    /admin/usage?groupBy=&since=
WS                     /admin/stream        live request logs and health updates
```

The WebSocket endpoint authenticates from the same session cookie during the
upgrade handshake and closes immediately if the session is absent or expired.

On first run, with no admin password set, the gateway generates one, prints it
to stdout, and stores its Argon2id hash. The dashboard forces a password change
on first login. Binding defaults to `127.0.0.1`; exposing the gateway on a
non-loopback interface requires an explicit `--host` flag, which logs a warning
noting that the admin surface is reachable.

### Dashboard

React 19 and Vite, with TanStack Router (file-based) and TanStack Query, styled
with Tailwind and shadcn/ui. TanStack Query owns all server state; there is no
Redux or Zustand, because no meaningful client state exists beyond form drafts.

Five screens:

- **Credentials.** Accounts grouped by provider, each showing a health
  indicator, token expiry, per-window quota bars, and inline tier and weight
  editing. Adding an account launches whichever flow the provider requires;
  device-code and paste modes render their own step-by-step UI.
- **Models.** Virtual model editor with targets, tiers, weights, cost, drag
  reordering, and a strategy picker. Includes a **dry-run panel**: select a
  model and see the ranked candidate list with a per-term score breakdown and
  exclusion reasons. This is what makes routing behavior debuggable.
- **Usage.** Requests, tokens, and cost over time, sliced by credential, model,
  or API key, alongside error and rate-limit rates.
- **Logs.** Live tail over WebSocket. Each row shows timestamp, API key,
  requested model, resolved provider/model/credential, attempt count, status,
  token counts, TTFT, and total duration, and expands to a per-attempt trace
  explaining why each earlier candidate failed.
- **Keys.** Mint, set allowlist and rate limit, revoke.

## Observability

One `request_logs` row per request: identifiers, API key, requested and resolved
model, credential, attempt count, status, `ErrorCode`, token counts, TTFT, total
duration, and computed cost.

**No prompt or response bodies are stored.** A service holding live provider
credentials should not also become an archive of conversation transcripts.
Retention is configurable with a daily prune job. Application logs are
structured JSON on stdout.

## Testing

| Layer          | Approach                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| `ir`           | Round-trip property tests: `egress(ingress(x))` is semantically equal to `x` for each format |
| `providers`    | Golden fixtures mapping recorded upstream SSE to expected `StreamEvent[]`. No network |
| `router`       | Table-driven pure tests: snapshot plus request yields an expected ranking. Covers every filter and tiebreak |
| `dispatch`     | Fake adapters that fail on cue, asserting the commit-point invariant          |
| `credentials`  | Mock OAuth server covering refresh races, token rotation, and expiry          |
| End-to-end     | `bun test` against a running gateway and a stub upstream, exercised with both the Claude Code client and the OpenAI SDK |

The commit-point invariant gets explicit adversarial tests: fail after headers,
fail after the first content event, and fail mid-stream. The first two must
retry with the client seeing zero bytes; the third must surface the error
mid-stream without corrupting SSE framing.

## Toolchain

Bun workspaces, TypeScript in strict mode, Biome for linting and formatting,
`bun test`, and a Dockerfile for deployment.

In development the dashboard runs under the Vite dev server and proxies
`/admin/*` to the gateway. For production `bun run build` emits the dashboard to
a static bundle that the gateway serves directly, so a deployment is a single
process listening on a single port.

## Success Criteria

The system is done when:

1. Claude Code, configured against the gateway, completes a full tool-using
   session end to end, including streaming and cache breakpoints.
2. The OpenAI SDK, pointed at `/v1/chat/completions`, completes an equivalent
   tool-using session, served by an Anthropic credential through translation.
3. A virtual model with three credentials spreads load across all three, and
   rate-limiting one causes traffic to move to the others with no client-visible
   error.
4. Killing the upstream mid-handshake retries silently onto another credential;
   killing it after the first content event surfaces a mid-stream error without
   corrupting SSE framing.
5. All three OAuth flows complete from the dashboard and survive a token
   refresh across a gateway restart.
6. The dry-run panel explains the routing decision for a given model, including
   the reason each excluded candidate was excluded.
