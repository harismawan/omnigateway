# Kilo Provider Design

## Goal

Add Kilo (kilo.ai, the inference service behind the Kilo Code editor extension) as a first-class
provider, reachable two ways: with a Kilo API key, and with an OAuth credential obtained through
Kilo's device-code flow. Kilo fronts a large third-party catalog — Anthropic, OpenAI, Google,
DeepSeek, Qwen, MiniMax and others — behind one account, plus a set of models it serves free. The
OAuth path is the reason this is worth doing: it lets an operator spend a Kilo subscription they
already pay for through the same gateway that fronts Anthropic and OpenAI directly.

## Scope

In scope: a `kilo` provider id, an OpenAI-chat-completions adapter, a device-code OAuth provider, a
curated model catalog, and the wiring each of those forces through `ir`, `router`, `control`,
`store`, the dashboard, and the CLI.

Out of scope: the anonymous free tier (Kilo serves some free models to `Bearer anonymous` with no
account at all — OmniRoute ships this; OmniGateway routes through stored credentials and a
credential-less path is a separate feature); any quota or credit-balance probe (see *Quota
Surface*); dynamic catalog population from Kilo's `/models` endpoint; and the image-generation,
embedding, and audio surfaces.

Image *input* and reasoning are in scope, which is a correction to an earlier draft of this
document. `PROVIDER_CAPABILITIES.kilo` claims `images: true` and `reasoning: true`, and
`packages/router/src/filters.ts` both drops a provider lacking `images` from any request carrying an
image block and routes reasoning requests by that flag. A capability claimed and then dropped by the
encoder or the decoder is not a smaller scope, it is a false claim the router acts on. Both are
therefore encoded and decoded; see *Adapter*.

## Sources

Kilo publishes no API reference covering the endpoints below. Every wire-level constant here is
quoted from two independent third-party implementations that talk to the live service, not from
documentation:

- **9router** (`decolua/9router`) — `open-sse/providers/registry/kilocode.js`,
  `open-sse/providers/registry/kilo-gateway.js`, `src/lib/oauth/providers/kilocode.js`. The OAuth
  device flow's status codes and response fields are quoted from the last of these.
- **OmniRoute** (`omniroute@3.8.48`, a TypeScript fork of 9router) —
  `open-sse/config/providers/registry/{kilocode,kilo-gateway}/index.ts`. Newer; source of the
  `X-KILOCODE-EDITORNAME` header and the anonymous-fallback note.

Both agree on hosts, paths, and auth shape, which is the strongest corroboration available short of
capturing traffic. Where a value below is inferred rather than quoted, this document says so.

The model catalog is not from either: `GET https://api.kilo.ai/api/gateway/models` answers
unauthenticated, and every id, price, and limit in *Catalog* was read from it on 2026-08-15.

Note that both references model Kilo as **two** provider ids (`kilocode` for OAuth,
`kilo-gateway` for API keys). This design deliberately does not — see *Provider Identity*.

## Provider Identity

`ProviderId` gains `"kilo"` (`packages/ir/src/request.ts:1`). That single edit makes the compiler
enumerate every exhaustive `Record<ProviderId, …>` in the monorepo, which is the intended way to
find the work rather than a list maintained by hand.

One id, not two. Kilo serves OAuth and API-key traffic from the same host on different paths, which
is exactly the case `CLAUDE.md` rule 7 describes: select the URL by credential type inside the
adapter and assert the split in a test. Two ids would double every exhaustive record, every
dashboard label map, the theme's oklch pairs, and every hardcoded id list in the test suite, in
exchange for expressing a difference the `CatalogAuth` field on a model choice already expresses.

- `PROVIDER_CAPABILITIES.kilo = { tools: true, images: true, reasoning: true }`
  (`packages/ir/src/capabilities.ts:40`). Kilo fronts Claude, GPT, and Gemini, all of which accept
  images and emit reasoning. Under-claiming is not the safe direction: `router` drops a target whose
  provider lacks `images` from any request carrying an image block, so a wrong `false` makes kilo
  targets vanish the moment a client pastes a screenshot. The same reasoning is already recorded
  against `grok` at `capabilities.ts:44-47`.
- `ANTHROPIC_NATIVE_TOOLS.kilo = false` (`capabilities.ts:23`). Kilo speaks the OpenAI chat
  completions wire even for Anthropic-vendored models, so an `AnthropicToolDef` or an
  `anthropicNative` history block excludes kilo at routing.

## Transport

Host is `api.kilo.ai` for both credential types. The path is chosen by credential type:

| credential | chat completions                        | model list                     |
| ---------- | --------------------------------------- | ------------------------------ |
| `oauth`    | `/api/openrouter/chat/completions`       | `/api/openrouter/models`       |
| `apiKey`   | `/api/gateway/chat/completions`          | `/api/gateway/models`          |

Crossing the two does not fail loudly. An OAuth token sent to the gateway path — or an API key sent
to the OpenRouter path — surfaces as a billing or entitlement error from Kilo, which reads as
anything but a routing bug. The split therefore gets a dedicated test asserting both directions,
mutation-checked by inverting the selection and confirming the test fails.

Auth is `Authorization: Bearer <token>` in both cases; the two credential types differ only in the
URL. Two additional headers:

- `X-KILOCODE-EDITORNAME` — required by the gateway per OmniRoute's comment, harmless on the
  authenticated path. Value comes from `env("OMNI_KILO_EDITOR_NAME")` with a compiled-in default, so
  a value Kilo starts rejecting is an operator fix rather than a release (`CLAUDE.md` rule 5).
- `X-Kilocode-OrganizationID` — sent only when the credential's `providerData` carries an `orgId`.
  See *OAuth*.

`PROFILES.kilo` (`packages/providers/src/profile.ts:264`) is **constructed, not captured from real
traffic**; its comment says so, following the precedent the kimi profile sets. `BODY_ORDER.kilo`
(`packages/providers/src/body.ts:10`) likewise.

## Adapter

`packages/providers/src/kilo/` holds `index.ts` (transport), `wire.ts` (IR → request), `decode.ts`
(stream → IR), and `models.ts` (catalog entry). No `device.ts`: Kilo asks for an editor name, not a
machine fingerprint, so there is no synthetic device identity to mint or freeze.

`wire.ts` and `decode.ts` are **forked from `kimi/`, not imported from it**. Both providers speak
OpenAI chat completions today and the two files will start out nearly identical, which is precisely
the situation `CLAUDE.md` rule 4 warns about: vendors look alike on paper and diverge in practice,
and a shared encoder collects a branch per quirk. `custom/` is the standing counterexample — it
imports `../kimi/` and `../openai/` and pays for it with a regex that rewrites degradation prefixes
afterwards. Shared infrastructure stays shared: `usageFromPromptTotal`, `parseSse`, `httpError`,
`orderHeaders`, `mergeHeaders`, `orderFields`.

Cache control has no expression on the OpenAI chat wire. A request carrying cache-control
breakpoints routed to kilo records a degradation, exactly as kimi does today.

Reasoning crosses the wire in both directions. The encoder forwards IR reasoning as OpenRouter's
`reasoning` field — `{max_tokens}` for a budget, `{effort}` for adaptive, clamped at `high` with a
`kilo:reasoning-effort-clamped` note. The decoder reads it back under the three spellings the
OpenRouter family has used, in precedence order, first non-empty winning: `reasoning`,
`reasoning_content`, then `reasoning_details[].text`/`.summary`. **The precedence is load-bearing,
not tidiness**: OpenRouter sends `reasoning` and `reasoning_details` in the same delta describing
the same tokens, so an implementation that reads every shape it recognises doubles every thinking
token.

Decoded thinking is **never marked signed**, even when `reasoning_details` carries a `signature` and
`format: "anthropic-claude-v1"`. That signature was minted over the request *Kilo* made on *Kilo's*
account, not over ours. `apps/gateway/src/egress/anthropic.ts:85-88` records the consequence: an
Anthropic-shaped client stores the assistant turn and replays it verbatim, and an unrecognised
signature fails that request with `Invalid signature in thinking block`, poisoning the conversation
from that point on. Unsigned is the truthful claim — displayable, not replayable — and it matches
what the grok decoder reports for the same reason. Both egresses discard unsigned thinking today, so
decoding does not by itself put reasoning in front of a client; what it buys is an IR that is
complete and a capability flag the router can trust.

An unrecognised reasoning shape contributes no text and does not throw. This is a deliberate
exception to the rule that unknown block types fail visibly, and the adapter carries the argument in
a comment: on the Anthropic surface an unknown block type means the response shape itself was
misread, so continuing yields wrong content, whereas here it means one display-only field is missing
while text, tool calls, stop reason, and usage all decoded correctly. Kilo proxies 361 models that
move weekly; failing the turn would discard a good, fully billed response every time a vendor adds a
field.

Thinking blocks are emitted strictly non-overlapping — a thinking block closes before text or a tool
call opens, and text closes if reasoning resumes — because the Anthropic egress renders these as
`content_block_start`/`content_block_stop` pairs and a start arriving while another block is open is
malformed on that wire.

Usage accounting follows the existing OpenAI-chat rules: `stream_options.include_usage` is required
or a streaming response reports no usage at all, and `Usage.inputTokens` stays uncached input with
cache reads counted as their own disjoint class.

## OAuth

Kind is `"device"`. `packages/control/src/oauth/kimi.ts` is the closest existing model — it is the
only current device-code provider, and it already exports `isAuthorizationPending` for the poll
loop.

**`begin()`** — `POST https://api.kilo.ai/api/device-auth/codes` with no body. Response:

```json
{ "code": "...", "verificationUrl": "https://...", "expiresIn": 300 }
```

`code` serves as both the device code and the user code. `verificationUrl` is what the operator
opens. `expiresIn` defaults to 300 seconds when absent. Poll interval is 3 seconds. A `429` means
too many pending authorizations and is surfaced as such rather than as a generic failure.

**`exchange()`** — one poll of `GET https://api.kilo.ai/api/device-auth/codes/<code>`:

| status                          | meaning                                       |
| ------------------------------- | --------------------------------------------- |
| `202`                           | authorization pending — keep polling          |
| `403`                           | denied by the user — terminal                 |
| `410`                           | code expired — terminal                       |
| `200` + `{status:"approved"}`   | success; `token` and `userEmail` on the body  |
| `200`, any other `status`       | treated as still pending                      |

On approval, `GET https://api.kilo.ai/api/profile` with the new bearer token reads
`organizations[0].id` and freezes it onto `providerData.orgId`. This read is **best-effort**: an
account with no organization is normal, and a failure here must not fail the connect flow and must
never be reported as `AUTH`, since `AUTH` disables the credential. A missing `orgId` simply means the
adapter omits the `X-Kilocode-OrganizationID` header.

**No refresh.** Kilo returns a bare token with no refresh token and no expiry. `FlowResult` carries
`expiresAt: null` and `CredentialSecrets.refreshToken: null`. `refresh()` is still required by the
`OAuthProvider` interface; it throws `GatewayError("AUTH", …)` stating that Kilo tokens cannot be
refreshed and the account must be reconnected.

Two consequences worth testing rather than assuming:

1. A credential with `expiresAt: null` must never be handed to `createRefresher`. If some path does
   send it, `refresh.ts:38` throws `AUTH` on the null refresh token first, which disables a
   perfectly good credential. The test asserts the refresher is not reached.
2. The OAuth scheduler (`apps/gateway`) must skip kilo credentials rather than treating a null
   expiry as "expired long ago".

## Quota Surface

`usage()` is **omitted**. `OAUTH_PROVIDERS` is `Partial`, so this is a supported shape, and per
`CLAUDE.md` rule 6 an omitted probe makes accounts read as *unknown* rather than as *unlimited*.

Kilo does expose an account balance through `/api/profile`, but a prepaid dollar balance is not a
rolling window. `UsageWindowReport` is window-shaped — `used`, `limit`, `resetsAt`, `windowType` —
and filing a balance under a window name would have the quota poller treat credit exhaustion as a
cooldown that resets on a schedule it never actually resets on. `quota_windows` stores provider
observations; recording a non-observation there is worse than recording nothing.

## Catalog

`KILO_MODELS` lives in `packages/providers/src/kilo/models.ts` and is assembled into
`PROVIDER_MODEL_CATALOG` at `packages/providers/src/catalog.ts:33`. It stays a browser-safe leaf:
model lists and types only, no runtime imports.

Kilo proxies a catalog of 361 models (read live on 2026-08-15) that changes without notice. The
catalog holds a curated subset in Kilo's OpenRouter-style `vendor/model` id form: the newest model
of each class, every free model Kilo serves, and the `kilo-auto/*` routers.

Prices are `$` per million tokens and limits are tokens, both as `GET /api/gateway/models` reported
them on 2026-08-15. Kilo passes list price through unchanged — its Anthropic rows match Anthropic's
own published rates exactly, including Sonnet 5's introductory $2/$10 — so these figures are the
upstream vendor's, not a Kilo markup.

**Frontier, one per class**

| id | in | out | cache read | context | max out |
| --- | ---: | ---: | ---: | ---: | ---: |
| `anthropic/claude-fable-5` | 10 | 50 | 1 | 1M | 128K |
| `anthropic/claude-opus-5` | 5 | 25 | 0.5 | 1M | 128K |
| `anthropic/claude-sonnet-5` | 2 | 10 | 0.2 | 1M | 128K |
| `anthropic/claude-haiku-4.5` | 1 | 5 | 0.1 | 200K | 64K |
| `openai/gpt-5.6-sol` | 5 | 30 | 0.5 | 1.05M | 128K |
| `openai/gpt-5.6-terra` | 2 | 12 | 0.2 | 1.05M | 128K |
| `openai/gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | 1.05M | 128K |
| `google/gemini-3.1-pro-preview` | 2 | 12 | 0.2 | 1.05M | 64K |
| `google/gemini-3.7-flash` | 0.75 | 3.75 | 0.075 | 1.05M | 64K |
| `moonshotai/kimi-k3` | 3 | 15 | 0.3 | 1.05M | — |

Kilo also serves `-pro` variants of each `gpt-5.6-*` and `-fast` variants of the Anthropic models.
They are left out: an operator who wants one types the id into a target, and listing every variant
turns a curated table into a mirror of a catalog that moves weekly.

**Free tier** — all twelve models Kilo currently serves at zero cost, priced `0` because that is
their real price:

| id | context | max out |
| --- | ---: | ---: |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | 64K |
| `nvidia/nemotron-3.5-lightning:free` | 1M | 64K |
| `dots-studio/dots-3-note-preview:free` | 512K | 512K |
| `cohere/north-mini-code:free` | 256K | 64K |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | 64K |
| `stepfun/step-3.7-flash:free` | 256K | 256K |
| `nvidia/nemotron-3-super-120b-a12b:free` | 256K | 256K |
| `tencent/hy3:free` | 256K | 128K |
| `poolside/laguna-s-2.1:free` | 256K | 32K |
| `poolside/laguna-xs-2.1:free` | 256K | 32K |
| `liquid/lfm-2.5-2.6b:free` | 128K | 8K |
| `nvidia/nemotron-3.5-content-safety:free` | 128K | 8K |

**Routers** — `kilo-auto/*`, which pick an upstream per request:

| id | in | out | context | max out |
| --- | ---: | ---: | ---: | ---: |
| `kilo-auto/frontier` | *unpriced* | *unpriced* | 1M | 128K |
| `kilo-auto/balanced` | *unpriced* | *unpriced* | 1M | 64K |
| `kilo-auto/efficient` | *unpriced* | *unpriced* | 1M | 64K |
| `kilo-auto/small` | 0.05 | 0.4 | 256K | 32K |
| `kilo-auto/free` | 0 | 0 | 256K | 10K |

`frontier`, `balanced`, and `efficient` report `"prompt": "-1"` upstream — Kilo declines to state a
price because the model is chosen per request. The catalog records `0`, which the router's scorer
reads as *unpriced* and drops from the cost term rather than treating as free
(`packages/router/src/resolve.ts:24-29`). That is the correct behaviour and the reason this design
does not invent a tier figure, but it makes `kilo-auto/free` and `kilo-auto/frontier` carry the same
stored price for opposite reasons — each needs a comment saying which it is, and `README.md` warns
operators to set a real `costPerMTok` on any `kilo-auto` target they intend to cost-rank.

Cache-write prices are recorded from the single `input_cache_write` figure Kilo reports, with
`cacheWrite5m` and `cacheWrite1h` set equal. The split is nominal: the OpenAI chat wire cannot
express a cache-control TTL at all, so a request carrying breakpoints records a degradation and
neither figure is ever charged (see *Adapter*).

Anything outside these tables is still reachable: an operator
creates a target with a hand-typed model id, and the router prices it from the target rather than
from this table. This is how `kimi` and `grok` already work; the only difference is that Kilo's
upstream list is larger and moves faster.

Two distinct auth facts live in the catalog, and they are easy to confuse because they share a type:

- `ProviderModelChoice.auth` — which backend serves *this model*. `kilo-auto/*` and the `:free`
  models are gateway-only (`apiKey`); the vendor-namespaced models are on both.
- `ProviderModelCatalogEntry.authTypes` — which kinds of credential the gateway can hold for *this
  provider*. Required, so the compiler asks the next provider author. Kilo is `["oauth","apiKey"]`
  at provider level while individual rows are `["apiKey"]`, which is exactly why one field cannot
  serve both questions. It could not be derived from the model list either: `custom` has `models:
  []`, and deriving would say "no way in at all" for the one provider whose only way in is a key.

`auth` is **enforced, not merely recorded**. `catalogModelAuths()` in the catalog leaf is the pure
lookup both surfaces share; the rule itself lives in `packages/control/src/models.ts` beside the
sibling `custom`-endpoint credential check, because `PUT /api/models/:id` and `omni models` both
write through it and a rule enforced only in the dashboard is not enforced (rule 5). The dashboard
filters its model picker and shows an inline note on top of that.

Reachability is installation state, not catalog state, so the cases are spelled out rather than
inferred:

| operator holds | outcome |
| --- | --- |
| both credential types | allowed |
| only the type that cannot reach the model | refused, naming both sets |
| no credential for that provider yet | allowed — composing models before connecting accounts is a normal order, and there is no evidence yet |
| a model the catalog does not list | allowed — unknown is not forbidden; the curated list is a few dozen of several hundred |
| a credential that is disabled | still counts — a transient `AUTH` failure must not make an unrelated target unsavable. Deliberately unlike `resolveModelLimits`, which filters on `enabled` because it answers "what can serve a request *now*" |
| a credential removed after the target was stored | that stored target is exempt, judged by id plus provider plus model; editing either field re-judges it |

New targets are refused; stored ones are grandfathered. The dashboard's warning must therefore state
the routing consequence ("requests routed here will fail") rather than predicting a refusal — for a
grandfathered target the refusal never comes, and that is precisely the operator most likely to be
reading it.

Every figure above was read from the live endpoint rather than recalled, but a proxied catalog moves:
re-read `GET /api/gateway/models` when the catalog file is written and record what it says then. The
implementation plan carries that as an explicit step, and the table above carries its read date so a
later reader can tell how stale it is.

## Routing

**`PREFIX_PROVIDER` is not changed** (`packages/router/src/resolve.ts:12-21`).

Bare-model-name inference matches prefixes like `claude-` and `gpt-`. Kilo's ids are
`anthropic/claude-sonnet-4.6` and `openai/gpt-5.5`, which match none of them, so nothing collides
today and no entry is needed. Adding one would be actively harmful: an `anthropic/ → kilo` mapping
puts a vendor-namespaced string one edit away from capturing traffic meant for the Anthropic
adapter. Kilo is reachable through configured virtual models only. This paragraph exists so the next
reader does not "fix" the omission.

`claude/<id>` alias normalization and `[1m]` handling are unaffected; `claude/` remains reserved.

## Storage

No migration. `credentials.provider` is `TEXT` with no `CHECK` and `providerData` is free-form
(`CLAUDE.md` lines 96-97), so the `orgId` field needs no schema change. The `ProviderId`-typed
columns in `packages/store/src/types.ts` follow from the union edit automatically.

## Fan-out

The compiler flags these once `ProviderId` gains `"kilo"`:

`ir/capabilities.ts:23,40` · `providers/profile.ts:264` · `providers/body.ts:10` ·
`providers/registry.ts:9` (`ADAPTERS`) · `providers/catalog.ts:33` ·
`gateway/dispatch/price.ts:17` (`WRITE_OVER_INPUT`) · `cli/command.ts:46` (`PROVIDER_TONE`) ·
`testkit/index.ts:275,288-294` (`stubAdapters`) · dashboard `theme/tokens.ts:74`,
`features/accounts/ConnectDialog.tsx:21,30`, `features/accounts/AccountsBoard.tsx:39`

It flags none of these:

- `control/src/schemas.ts:41` (`providerIdSchema`) and **`:58`**, the target discriminated union,
  whose `z.enum` lists providers explicitly and excludes `custom`. Missing `:58` produces a build
  that connects kilo credentials but cannot create a target against them.
- `control/src/connect.ts:8` (`PROVIDER_IDS`, backing `isProviderId` at `:54`), `:29` (`CALLBACKS`),
  `:172` (free-text `"anthropic, openai, kimi, grok"`)
- `control/src/oauth/index.ts:13` (`OAUTH_PROVIDERS`)
- `cli/src/commands/connect.ts:17` and `cli/src/commands/credentials.ts:224`, two more free-text
  lists that disagree with each other today
- dashboard `theme/tokens.ts:41-47` (provider token map) and `:71-72` (a second hand-rolled
  `PROVIDER_IDS`). **Not** `ConnectDialog.tsx:45` (`CODE_PLACEHOLDER`) — it is `Partial` and holds
  loopback-redirect shapes only, so a device flow has no entry there and kimi has none either.
  Adding one would be dead data.
- `theme/GlobalStyle.ts:34-42` (light) **and** `:71-75` (dark) — both halves of the `--p-kilo` oklch
  pair, placed per the hue-spacing rationale recorded in the comment at `:39`
- `README.md:143` and the provider list in `CLAUDE.md`

One deliberate widening beyond the list above: `ConnectDialog`'s key-entry form was branched on
`provider === "custom"`, which would have left Kilo connectable by device code alone. It is now
driven by `authTypes`, so every provider that can hold an API key offers one in the console. This is
a user-facing change to four providers that have nothing to do with Kilo, approved separately from
this design. `provider === "custom"` survives in exactly one place — the endpoint-metadata fields,
which are custom's own data rather than an auth capability. Verified before shipping: no provider
now offers a credential the gateway rejects, and each adapter genuinely carries a raw key on the
wire.

Tests that assert exact key sets and will fail loudly, which is the desired behaviour — each is
updated deliberately, not blanket-widened: `providers/test/catalog.test.ts:5,7-31`,
`providers/test/kimi.test.ts:263` and `providers/test/custom.test.ts:84` (both assert
`Object.keys(ADAPTERS)` equals the current five), `control/test/oauth/kimi.test.ts:280`
(`Object.keys(OAUTH_PROVIDERS)`), `gateway/test/routes/proxy.test.ts:154,762`.

One test needs more than an update: `cli/test/connect.test.ts:135` asserts the free-text provider
list, and the comment at `:133` warns that the assertion still passes by prefix. After adding kilo,
mutate the string to confirm the assertion actually fails.

## Testing

Behaviour tests at the narrowest stable boundary, stub `HttpClient` throughout, no live calls. Per
`CLAUDE.md` rule 9 each anchor below is mutation-tested — break the behaviour, confirm the test goes
red — because a green suite is not evidence of coverage.

- URL selection by credential type: oauth → `/api/openrouter/*`, apiKey → `/api/gateway/*`, both
  directions
- Streaming and non-streaming on both paths
- Usage-token arithmetic, including that a streaming request without `stream_options.include_usage`
  reports no usage rather than zero
- Tool call and tool result round-trip
- Mid-conversation system message stays in place and is not folded into request-level `system`
- Device flow: `202` / `403` / `410` / approved, plus code expiry
- Null-expiry credential never reaches the refresher; `refresh()` raises `AUTH`
- Reasoning round-trips: budget encodes to `{max_tokens}`, adaptive to `{effort}`; each decoder
  spelling produces thinking blocks; a delta carrying two spellings is read once, not twice;
  thinking is never marked signed; an unreadable shape costs the text, not the response
- Thinking, text, and tool-call blocks never overlap — assert the open/close *order*, not the count
  of each, which survives an overlap
- The Anthropic-tool filter drops an `AnthropicToolDef` rather than forwarding it malformed, and
  records no tool degradation when every tool is portable
- Per-model auth enforcement across every row of the reachability table above, including the two
  that only discriminate when an enabled credential of one type is paired with a disabled
  credential of the other
- `X-Kilocode-OrganizationID` present when `providerData.orgId` is set, absent when it is not; a
  failing `/api/profile` read still completes the connect
- Degradation recorded for cache-control breakpoints the chat wire cannot express

## Open Questions

None blocking. The one deferred decision is the anonymous free tier: Kilo serves a subset of models
to `Bearer anonymous` with no account, which would let an operator use the gateway before connecting
anything. It needs a credential-less dispatch path that does not exist today, so it is deliberately
out of scope here rather than unresolved.
