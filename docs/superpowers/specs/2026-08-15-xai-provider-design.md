# xAI (Grok) Provider Design

## Goal

Add xAI as a first-class provider, reachable two ways: with an xAI API key, and with an OAuth
credential backed by a SuperGrok or X Premium+ subscription. The OAuth path is the reason this is
worth doing — it lets an operator spend a subscription they already pay for through the same gateway
that fronts Anthropic and OpenAI.

## Scope

In scope: a `grok` provider id, a Responses-API adapter, a PKCE OAuth provider, a model catalog, and
the wiring each of those forces through `ir`, `router`, `control`, `store`, the dashboard, and the
CLI. Two adjacent cleanups ride along because this change would otherwise make them worse: moving
`kimi-device.ts` into `kimi/`, and moving the beta constants out of `packages/providers` into
`@omni/ir`.

Out of scope: images, video, and voice endpoints; the deferred-completion and stored-response
surfaces; server-side tools (`web_search`, `x_search`, `code_execution`, MCP); round-tripping xAI's
encrypted reasoning content; and any quota probe. The `custom` adapter keeps its existing
cross-provider imports for now — untangling it is separate work.

## Sources

Every wire-level constant below is quoted from source, not from documentation. xAI's developer docs
describe API keys only and never mention OAuth, so the OAuth half of this design is derived from
xAI's own client (`xai-org/grok-build`, `SOURCE_REV e6a67a5408288c98380cd13f3b1fe1fbc01c9f1f`) and
corroborated against independent third-party implementations. Where a value is a guess rather than a
quote, this document says so.

## Provider Identity

`ProviderId` gains `"grok"` (`packages/ir/src/request.ts:1`). That single edit makes the compiler
enumerate every exhaustive `Record<ProviderId, …>` in the monorepo, which is the intended way to find
the work rather than a list maintained by hand.

- `PROVIDER_CAPABILITIES.grok = { tools: true, images: false, reasoning: true }`.
  `images: false` is a deliberate under-claim: the Responses wire has an `input_image` form, but
  nothing in the sources confirms xAI accepts it. Flipping it on is a small, testable follow-up.
- `ANTHROPIC_NATIVE_TOOLS.grok = false`, so the router excludes grok from any request carrying an
  `AnthropicToolDef` or an `anthropicNative` history block, per the existing invariant.
- `WRITE_OVER_INPUT.grok = 0` (`apps/gateway/src/dispatch/price.ts:17`) — xAI bills no cache-write
  premium.

## Dual Endpoint Routing

xAI serves OAuth and API-key traffic from two different hosts, and crossing them is the single
easiest way to break this feature.

```
CLI_CHAT_PROXY_BASE_URL_DEFAULT = "https://cli-chat-proxy.grok.com/v1"   // session token
XAI_API_BASE_URL_DEFAULT        = "https://api.x.ai/v1"                  // API key
```

(`crates/codegen/xai-grok-shell/src/agent/config.rs:49,51`.) xAI's own client freezes the pairing in
a test asserting `SessionToken must route to cli-chat-proxy` and `ExternalApiKey must route to
api.x.ai` (`agent/config_tests.rs:1171-1198`), and `proxy_url()` is documented to *never* fall back
to the API host (`agent/config.rs:298-305`).

The failure mode when this is wrong is not a clean 401. Sending an OAuth bearer to `api.x.ai` bills
against xAI API credits and returns 402 even for an account whose subscription is healthy
(`grok-build-auth/xconsole_client/xai_oauth.py:341-344`). A 402 on a working subscription is a
confusing enough symptom that the adapter test asserts URL selection by credential type directly.

This mirrors `openai/index.ts:10-11` closely enough that the grok adapter should read as a sibling of
it:

```ts
const PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses"; // OAuth
const API_URL   = "https://api.x.ai/v1/responses";                // apiKey
```

Third-party clients disagree about this — roughly half send OAuth tokens straight to `api.x.ai`. They
are followed here only where they corroborate xAI's own source, never where they contradict it.

## Provider Directory Layout

`packages/providers/src/grok/` holds `index.ts`, `wire.ts`, `decode.ts`, `models.ts`, matching the
shape of every other provider.

`wire.ts` and `decode.ts` are **forked**, not shared with `openai/`. Sharing would be tempting —
xAI's Responses surface is close to OpenAI's today — but the two diverge already and will diverge
further, and a shared file means every future xAI quirk lands as another branch inside OpenAI's
encoder. The existing `custom` adapter is the counter-example: it reaches into `../kimi/` and
`../openai/` and pays for it with a regex that rewrites degradation prefixes after the fact
(`custom/index.ts:57-59`).

Forking costs real duplication, and the mitigation is that neither file is a blind copy. The
differences from `openai/wire.ts` are load-bearing:

| Concern | `openai/wire.ts` | `grok/wire.ts` |
| --- | --- | --- |
| reasoning effort | clamps `xhigh`/`max` to `high` (`:160-165`) | sends `xhigh`; maps `max` to `xhigh` |
| reasoning summary | `"auto"` | `"concise"` |
| OAuth parameter drops | drops `max_output_tokens`, `temperature` (`:134,140`) | sends both |
| `include` | absent | `["reasoning.encrypted_content"]` |
| `prompt_cache_key` | absent | set, for cache affinity |
| vendor passthrough | `req.vendor?.openai` | `req.vendor?.grok` |
| degradation prefix | `openai:` | `grok:` |

The OAuth-drop row is the clearest argument for the fork: those two drops exist because the *Codex*
backend rejects the parameters, which has nothing to do with xAI. Nothing in xAI's client suggests
its proxy rejects them, so grok sends both — and this is recorded as unverified rather than as
known-good.

Shared infrastructure is still shared. `usageFromPromptTotal` comes from `@omni/ir`, `parseSse` from
`../sse.ts`, `httpError` from `../http.ts`. Only provider-shaped code is duplicated.

### Body fields

Set on every request, following xAI's own client:

- `store: false` (`xai-grok-sampler/src/client.rs:1213-1216`) — the default is `true`, which breaks
  zero-data-retention expectations.
- `include: ["reasoning.encrypted_content"]` (`client.rs:1218-1222`).
- `reasoning.summary: "concise"` (`conversation/responses.rs:146-149`).
- `prompt_cache_key`, which pins requests to a server and raises the cache hit rate
  (`responses.rs:141-144`).

Not sent: `presence_penalty`, `frequency_penalty`, `logprobs`, `top_logprobs`. xAI's client hardcodes
these to `None` rather than stripping them, and reasoning models reject them outright.

`BODY_ORDER.grok` mirrors `BODY_ORDER.openai`, which already lists `include` and `prompt_cache_key`
(`body.ts:31,34`), so no new field vocabulary is needed.

### Usage accounting

xAI reports `input_tokens_details.cached_tokens` as a **subset** of `input_tokens`, the opposite of
Anthropic's disjoint classes. This needs no new code: `usageFromPromptTotal` exists for exactly this
conversion and is already used on the OpenAI Responses path with the comment
`input_tokens includes the cached part; the IR wants it net` (`openai/decode.ts:174`). `grok/decode.ts`
does the same.

xAI has no cache-write class at all, so catalog entries carry `cacheWrite5m: 0, cacheWrite1h: 0` —
which `catalog-types.ts:21-25` already documents as "a real price, not a missing one".

### Thinking blocks

Incoming Anthropic `thinking` blocks are dropped with a `grok:thinking-dropped` degradation, as the
OpenAI adapter does. xAI's encrypted reasoning content could in principle round-trip, but carrying it
needs an IR representation for an opaque provider-owned blob, and that is a separate design.

## Client Identity

The gateway presents as xAI's own CLI. Two corrections to what third-party clients do, both sourced:

- The product token is **`grok-shell`**, not `grok-cli`. No `grok-cli/<version>` user-agent exists
  anywhere in xAI's source. The format is
  `grok-shell/<version> (<os>; <arch>)` (`xai-grok-sampler/src/client.rs:45,510-537`), with `arm64`
  normalized to `aarch64` and the OS lowercased — different enough from `stainlessHost` that
  `PROFILES.grok` needs its own small normalizer rather than reusing that helper.
- The authorize URL carries **`referrer=grok-build`** and no `plan` parameter at all
  (`auth/config.rs:168`, frozen test at `auth/oidc/protocol.rs:819-827`). The widely-copied
  `plan=generic&referrer=hermes-agent` combination belongs to a different third-party product;
  sending it would identify this gateway as that product.

`PROFILES.grok` static headers:

| Header | Value |
| --- | --- |
| `User-Agent` | `grok-shell/<version> (<os>; <arch>)`, env `OMNI_UA_GROK` |
| `x-grok-client-identifier` | `grok-shell` (`client.rs:42,649-660`) |
| `x-grok-client-version` | version, env `OMNI_GROK_CLI_VERSION` |
| `x-grok-client-mode` | `headless` (`xai-grok-http/src/lib.rs:284-299`) |
| `Accept` | `text/event-stream` |

Proxy-only, injected when the credential is OAuth (`agent/config.rs:5235-5247`):
`X-XAI-Token-Auth: xai-grok-cli` and `x-authenticateresponse: authenticate-response`.

The version is the weakest constant here. `x-grok-client-version` exists specifically for version
gating at the proxy (`client.rs:623`); this source drop reports `1.0.3` while shipped third-party
clients pin `0.2.93`, `0.2.106`, and `0.2.120`. The default is `1.0.3` behind `OMNI_GROK_CLI_VERSION`
so an operator can move it without a release, and `PROFILES.grok` carries a comment saying the value
is a guess — the same honesty `profile.ts:179-180` already applies to kimi.

### Per-request headers

xAI's client sends five per-request identifiers (`client.rs:60-79`). Mapping them without inventing
randomness:

- `x-grok-req-id` ← the gateway's existing `requestId`, so stdout and `request_logs` still join on
  one value and the upstream id is not a third unrelated identifier.
- `x-grok-conv-id`, `x-grok-session-id` ← both derived deterministically from `requestId`, and equal
  to each other. xAI's own client sets `conv-id` to the session id for main turns, so their being
  equal matches its behaviour rather than approximating it.
- `x-grok-model-override` ← the resolved model slug.
- `x-grok-agent-id` ← a stable device fingerprint, described below.

Deriving rather than minting keeps adapter tests deterministic without threading a random source
through `AdapterRequest`.

### Device identity

`x-grok-agent-id` is a **stable machine fingerprint** in xAI's client — a UUIDv5 over a machine hash,
cached at `$GROK_HOME/agent_id` with mode 0600 (`xai-grok-telemetry/src/id.rs:34-68`). A fresh random
value on every request is a visible behavioural difference.

The gateway already has this pattern. `grok/device.ts` mirrors `kimi/device.ts`: mint a synthetic but
stable id once at connect time, freeze it onto `credential.providerData`, and read it back per
request. As with kimi, the value is *made up rather than read from the host* — `os.hostname()` is
routinely the operator's own name or an employer asset tag, and it would go upstream on every
request. Upstream needs the id to be stable, not true.

## OAuth

`packages/control/src/oauth/grok.ts` implements the existing `OAuthProvider` interface with
`kind: "pkce"` and `supportsManualPaste: true`.

| Field | Value | Source |
| --- | --- | --- |
| issuer | `https://auth.x.ai` | `auth/config.rs:132` |
| client_id | `b1a00492-073a-47ea-816f-4c329264a828` | `auth/config.rs:279` |
| client_secret | none — public PKCE client | — |
| scopes | `openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write` | `auth/config.rs:15-28` |
| PKCE | 32 random bytes → 43-char base64url verifier, S256 | `protocol.rs:340-348` |
| extra authorize param | `referrer=grok-build` | `auth/config.rs:168` |
| token request | form-encoded POST | `protocol.rs` |

Authorize and token endpoints come from OIDC discovery rather than being hardcoded, matching xAI's
client (`protocol.rs:306`).

### Discovery validation

Discovery output is validated before use: the endpoint must be HTTPS and its host must be `x.ai` or a
subdomain of it. A discovery document is fetched over the network and then used to decide where an
authorization code and a client id are sent, so an unvalidated response is a redirect of the token
exchange to an attacker-chosen host. This guard is small and worth having.

### Refresh

xAI rotates refresh tokens **conditionally** — a refresh response may omit `refresh_token` entirely.
The refresh implementation retains the previous token when the response omits one; xAI's own client
does this explicitly, and both independent third-party clients do the same. Getting it wrong silently
destroys a working credential on its first refresh.

Refresh failures classify through the existing `tokenErrorCode`, so only a genuine repudiation
disables a credential and a 5xx or 429 during an xAI outage does not.

### Usage probe

`usage` is **omitted**. xAI publishes no rate-limit headers, and none are read anywhere in its own
client — the only retry signals are `Retry-After` (integer seconds, capped at 120) and
`x-should-retry` (`client.rs:231-252`). Omitting the probe means grok accounts read as *unknown*
rather than as unlimited, which is the correct answer and matches the existing rule that missing
quota data is not an absence of limits.

## Catalog

`grok/models.ts` lists both surfaces' models in one entry, with `grok-4.6` as the default.

| Model | Context | Input | Cache read | Output |
| --- | --- | --- | --- | --- |
| `grok-4.6` | 500K | 2.00 | 0.50 | 6.00 |
| `grok-4.5` | 500K | 2.00 | 0.30 | 6.00 |
| `grok-4.3` | 1M | 1.25 | 0.20 | 2.50 |
| `grok-4.20-0309-reasoning` | 1M | 1.25 | 0.20 | 2.50 |
| `grok-4.20-0309-non-reasoning` | 1M | 1.25 | 0.20 | 2.50 |
| `grok-4.20-multi-agent-0309` | 1M | 1.25 | 0.20 | 2.50 |

`grok-build-0.1` is deliberately absent. Third-party model tables list it as a chat model; xAI's
source shows it is a prompt-suggestion model (`DEFAULT_SUGGEST_MODEL`, `session/helpers/prompt_suggest.rs:27`).

Models retired on 15 May 2026 — the `grok-4*` and `grok-code-fast-1` families — are also absent.
Their slugs still resolve upstream but silently redirect, so listing them would offer the operator a
target whose real identity and price differ from what the catalog says.

### Tiered pricing

xAI prices by request size: at or above 200K context the rate roughly doubles, and the higher rate
applies to **every token in the request**, not just the overage. `ProviderModelPricing` is flat, and
this design does not change it.

The catalog therefore carries the **sub-200K** figures, and the reason this is acceptable is that
catalog pricing is only a default for newly created targets — the router prices from the saved
target. An operator running long-context traffic edits the target's stored price. The under-report is
a real limitation and belongs in `README.md` rather than only here.

### Unpublished limits

`maxOutputTokens` is not published for any model. The proxy reports `x-grok-max-completion-tokens` on
live responses (`client.rs:254-279`), but the catalog needs a static default. Every entry carries
**32768**, with a comment stating the figure is unpublished, that it is a floor rather than a quoted
limit, and that `x-grok-max-completion-tokens` on any live response confirms the real value.

Under-claiming is the safe direction here: these limits are advertised through `GET /v1/models` and
never enforced by the gateway, so a low figure costs a client some headroom while a high one would
invite an upstream 400 on a request the client believed was fine.

## Adjacent Cleanups

Both are prerequisites in the sense that skipping them makes this change worse.

**`kimi-device.ts` → `kimi/device.ts`.** A provider-specific module sitting at the package root
invites the next provider to add `grok-device.ts` beside it. Only `kimi/index.ts:4` imports it
directly; `control/oauth/kimi.ts:2` goes through the `@omni/providers` barrel and is unaffected once
`index.ts` re-exports the new path. The four device tests in `test/profile.test.ts:109-142` move to a
kimi device test file.

**`betas.ts` → `@omni/ir`.** This one is not what it looks like. `CONTEXT_1M_BETA` is imported by
`anthropic/index.ts:2`, `kimi/wire.ts:2`, `openai/wire.ts:2`, and `apps/gateway/src/ingress/model.ts:1`
— three of the four are not the Anthropic adapter, and `grok/wire.ts` would be a fifth. Moving it into
`anthropic/` would force every other adapter to import across a provider boundary.

The constant is client-contract vocabulary, not adapter vocabulary: Claude Code emits the beta,
gateway ingress translates the `[1m]` suffix, and each adapter's job is to notice it and record a
degradation. `req.betas` already lives on `ChatRequest` in `@omni/ir`, so the constants belong beside
it. They are inert strings, so `ir` stays provider-independent and side-effect-free.

`apps/gateway/src/ingress/model.ts` imports from `@omni/ir` afterwards, and the `packages/providers`
barrel drops its re-export.

## Router, Store, Control, Dashboard, CLI

**Router.** `PREFIX_PROVIDER` gains `grok-` → `"grok"` (`router/src/resolve.ts:12`), so a bare
`grok-4.6` resolves without a configured target. `PROVIDERS` derives from `PROVIDER_CAPABILITIES` and
needs no edit. The router stays pure.

**Store.** No migration. `provider` is `TEXT` with no `CHECK` constraint
(`migrations/001_init.sql:3`), and `providerData` is already free-form. Existing rows are unaffected.

**Control.** `PROVIDER_IDS` (`connect.ts:8`), `providerIdSchema` and the target discriminated union
(`schemas.ts:22,35-80`), and `OAUTH_PROVIDERS.grok` (`oauth/index.ts:7`). `createApiKeyCredential`
needs no change — its only provider-specific branch is `custom`. `callbackUri` (`connect.ts:56`) is
currently OpenAI-shaped and needs generalizing; xAI binds an ephemeral loopback port in production,
with `127.0.0.1:56121` used only under its local-dev flag (`auth/oidc/login.rs:390-402`).

**Dashboard.** Two `--p-grok` oklch variables in `theme/GlobalStyle.ts` (light and dark), then
`theme.provider`, `PROVIDER_IDS`, and `PROVIDER_LABEL` in `tokens.ts:41-46,70,73`, `PROVIDER_ORDER`
and the second `PROVIDER_LABEL` copy in `AccountsBoard.tsx:35,37`, and a `PASTE_HINT` entry in
`ConnectDialog.tsx:29`. Colour carries provider identity only, per the existing rule.

**CLI.** `PROVIDER_TONE` (`command.ts:46`) and the hardcoded
`"provider must be one of anthropic, openai, kimi, custom"` message (`credentials.ts:224`).

## Error Handling

Errors flow through the existing `httpError(res, "grok")`. `Retry-After` is honoured as integer
seconds capped at 120, and `x-should-retry` is read as an explicit upstream retry signal; an
HTTP-date `Retry-After` falls back to exponential backoff. Client-facing errors carry no bearer
token, refresh token, credential id, or internal stack — a 402 from `api.x.ai` surfaces as an upstream
error with its status and nothing more.

## Testing

**Adapter** (`packages/providers/test/grok.test.ts`). Wire encoding: `store: false`, the `include`
entry, `prompt_cache_key`, `reasoning.summary`, and effort mapping including `xhigh` and `max`.
Decoding: a fake `SseMessage` generator covering text deltas, reasoning deltas, tool calls, usage on
`response.completed`, and an unknown event failing visibly rather than being skipped. Transport: a
captured `HttpRequest` asserting **URL selection by credential type** — OAuth to the proxy, API key to
`api.x.ai` — plus header presence and order. Both streaming and non-streaming paths.

**Usage.** A decode test asserting `inputTokens` is net of `cached_tokens`, since xAI's subset
convention is the reverse of Anthropic's and a regression here silently misprices every request.

**OAuth** (`packages/control/test/`). Authorize URL parameters including `referrer=grok-build` and the
absence of `plan`; form-encoded exchange body; **refresh with no `refresh_token` in the response
retaining the previous one**; discovery rejecting a non-`.x.ai` or non-HTTPS endpoint; and refresh
failure classification distinguishing a repudiation from a 5xx.

**Exhaustive lists** that will fail to compile or assert until updated: `stubAdapters`
(`testkit/src/index.ts:288-291`), the registry assertions in `kimi.test.ts:263` and
`custom.test.ts:84`, the catalog lists in `catalog.test.ts:5,7`, `proxy.test.ts:766`, and the
dashboard accounts and models suites.

**Cleanup regressions.** Kimi device headers still emitted after the move; `CONTEXT_1M_BETA` still
honoured by the Anthropic adapter and still degraded by kimi and openai after relocating to
`@omni/ir`.

No test contacts a live provider; all use stub `HttpClient`, in-memory stores, and synthetic
credentials.

**Before completion:** focused tests for changed behaviour, then full `bun test`, the dashboard suite,
`bun run typecheck`, and `bun run lint`.

## Unverified Assumptions

Recorded so a future reader knows which numbers were quoted and which were chosen:

1. **`maxOutputTokens`** — unpublished for every model; the catalog's 32768 is a chosen floor, not a
   quoted limit.
2. **Image support** — `PROVIDER_CAPABILITIES.grok.images` is `false` pending confirmation that xAI
   accepts `input_image`.
3. **`temperature` / `max_output_tokens` on the proxy** — sent, on the reasoning that the Codex-driven
   drops do not apply here. Nothing confirms the proxy accepts them.
4. **`x-grok-client-version: 1.0.3`** — the proxy version-gates on this, and shipped clients disagree.
   Env-overridable for this reason.
5. **Responses SSE event set** — assumed to match OpenAI's. No authoritative enumeration exists, which
   is why unknown events must fail visibly.

## Follow-ups

- Round-trip xAI's encrypted reasoning content instead of dropping thinking blocks.
- Confirm image support and flip the capability.
- Server-side tools (`web_search`, `x_search`, `code_execution`) as Anthropic-native-style
  provider-owned tool definitions.
- Untangle `custom`'s cross-provider imports now that forked-per-provider is the established pattern.
