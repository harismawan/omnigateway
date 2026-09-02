# OpenAI Responses ingress

*Status: implemented. The `developer`-role change of step 5 was probed live against the Codex OAuth
leg on 2026-09-02 — the same request differing only in that role returned 200 with nine events and
`response.completed` both times — and shipped. The other three legs named below were not probed: the
machine had no OpenAI API key and no xAI credential of either kind.*

*Phase 0's capture has not been run either: it needs a real Codex pointed at a running gateway. The
route, the schema and the refusal list were written from Codex's own source and both peer gateways,
and the field list below is the one both peers converged on. What the capture is still owed is the
key-set check — the specific discipline this repository has twice been burned for skipping.*

`POST /v1/responses` becomes a third client surface, beside `POST /v1/messages` (Anthropic) and
`POST /v1/chat/completions` (OpenAI chat). It is an ingress and an egress over the existing core, not
a new provider and not a passthrough.

The driver is Codex CLI. Codex speaks only the Responses API — `wire_api = "chat"` is a hard error in
it — so today it cannot connect to this gateway at all. Section 6 of
[agent client context and setup](2026-08-09-agent-client-context-and-setup-design.md) reserved this
work and deferred it; this design supersedes that section.

Two peer gateways that already serve this surface were read before writing this, and the constraints
they encode are cited inline throughout — omniroute (TypeScript, `open-sse/executors/codex.ts` and
`open-sse/translator/{request,response}/openai-responses.ts`) and 9router (JavaScript,
`src/app/api/v1/responses/route.js`, `open-sse/handlers/responsesHandler.js`). Where both agree on a
number or a pattern, that is two independent implementations having met the same backend, which is
worth more than either one alone. Their code was read as evidence, not copied.

## Decisions

Five choices shape everything below. Each is stated with what it costs, because each has a cheaper
alternative that was rejected for a specific reason.

1. **Codex is the fidelity bar.** The accepted request shape is whatever Codex actually sends,
   measured. Generic SDK calls are served where they overlap, but no field is supported on the
   strength of the documentation alone.
2. **Stateless only.** No response is stored, so `previous_response_id`, `GET /v1/responses/{id}` and
   `item_reference` do not exist here. Storing them would put prompt text on disk by default, which
   collides with the body-logging opt-out contract, and would add a retention policy the other two
   surfaces do not have.
3. **Any target, via IR.** A Responses request parses to `ChatRequest` and routes like any other, so
   Codex can run on Anthropic, kimi, kilo or grok — the mirror of `/v1/messages` already reaching
   OpenAI. This is the property that makes the work worth doing; a Codex-to-Codex passthrough would
   have no routing, no failover, no usage accounting, no RTK and no ponytail.
4. **Capture before the schema is frozen.** No Codex ingress capture can exist today, because Codex
   cannot connect. The field list is measured first and written second.
5. **Hosted tools become first-class provider tools**, rather than being dropped. This widens
   `ToolDef` in `@omni/ir` — see *Widening provider tools*. The cost is that tools count as owners in
   `requiredProviders`, so a request declaring one pins to OpenAI targets from **turn 1**, not turn 2.
   The alternative — dropping them — was measured wrong by both peers: dropping `tool_search` "hid
   the tool from the model entirely and broke Codex's lazy/deferred tool-loading protocol"
   (omniroute, issue #7532), and Codex Desktop injects `image_generation` into every request.

## Surface and route

`Surface` in `apps/gateway/src/routes/proxy.ts:104` grows a third arm:

```ts
type Surface = "anthropic" | "openai" | "responses";
```

One route, registered beside the other two:

```ts
.post("/v1/responses", ({ request, server }) => {
  server?.timeout(request, 0);
  return handle(dispatchDeps, rateLimiter, "responses", request);
})
```

Everything inside `handle` is inherited unchanged: `authenticateApiKey`, `rateLimiter.admit`,
`bodyCollectorFor`, the model allowlist check, `dispatch` with its `onRoute` →
`beginLog`/`routeLog`, `finishLog`, `sseResponse`, and the `finally` that releases the concurrency
gauge. Only the four existing dialect switches gain a third arm — `errorBody` (`:145`),
`rateLimitHeaders` (`:159`), parse (`:529`), and the stream/response render (`:631`, `:698`).

Three widenings outside `proxy.ts`:

- `LogFields.surface` (`packages/ir/src/logger.ts:24`) and the `surface` parameter of
  `reportRejection` (`apps/gateway/src/logging.ts:124`). This is a core edit and it is the permitted
  kind: `CLAUDE.md` rule 16 names `surface` as core-held *vocabulary*, in the same family as
  `ErrorCode` and `StopReason`. `LogFields` does not become extensible.
- `quiesceResponse` (`apps/gateway/src/app.ts:162`) is keyed on the **path string**, not on the
  surface, and falls through to the Anthropic error shape. A new `/v1/*` route inherits the quiesce
  latch automatically through `isClientTraffic` (`app.ts:180`) but would serve Anthropic-shaped
  errors during a database swap. It gets the new path. The path-keying itself is left alone — see
  *Rejected alternatives*.
- `readConversationHeader` (`apps/gateway/src/ingress/schemas.ts:116`) gains `session-id`, the header
  Codex sends. The comment above it currently justifies excluding that name on the grounds that
  "this gateway exposes no Responses ingress, so it cannot arrive here at all". That justification
  expires with this change, so the comment is deleted rather than amended.

`/v1/models` and `/v1/messages/count_tokens` are unchanged and stay Anthropic-parsed. There is no
Responses-dialect `count_tokens` in the real API, so adding one would be inventing an endpoint rather
than being compatible with one.

Errors on this surface render in the Responses error shape — `{error: {message, type, code, param}}`
— with this surface's own `type` values, not the chat-completions ones.

## Ingress: `apps/gateway/src/ingress/responses.ts`

One export, the same shape as its two peers:

```ts
export function parseResponsesRequest(body: unknown, headers?: Headers): ChatRequest
```

The zod schema lives in the file; the shared toolkit in `ingress/schemas.ts` supplies `parseOrThrow`,
`extraFields`, `parseDataUrl` and the sidecar-image helpers. The parser ends exactly as the other two
do: `extraFields(body, KNOWN)` → `request.vendor = {openai: extras}` → `validateRequest(request)`.

### Top-level fields

| Responses | IR |
|---|---|
| `model` | `normalizeClientModel(model).model` |
| `instructions` | `system: [TextBlock]` |
| `input` (string) | a single user message |
| `input` (items) | messages and blocks, below |
| `tools` | `function` → `CustomToolDef{kind:"portable"}`; `custom` (freeform) → portable with a permissive schema, its name recorded (below); hosted → `ProviderToolDef{provider:"openai"}` |
| `tool_choice` | `"auto"`/`"none"` unchanged; `"required"` → `{type:"any"}`; `{type:"function", name}` → `{type:"tool", name}` |
| `max_output_tokens` | `maxTokens` |
| `temperature` | `temperature` |
| `reasoning.effort` | `{mode:"adaptive", effort}`; `reasoning.summary: "none"` adds `display: "omitted"` |
| `stream` | `stream` (absent is false) |
| `prompt_cache_key`, else the `session-id` header | `conversationId` |
| `text` (`verbosity`, `format`), `service_tier`, `client_metadata`, `include` | `vendor.openai` |
| anything else | `vendor.openai` |

`KNOWN` starts from the field list both peers converged on — `model`, `input`, `instructions`,
`tools`, `tool_choice`, `stream`, `store`, `reasoning`, `service_tier`, `include`,
`prompt_cache_key`, `client_metadata`, `text` (omniroute `executors/codex.ts:1404-1422`, 9router
`codex.js:42-46`) — and is then confirmed against a real capture before it is frozen.

`[1m]` is normalized off the model name before the allowlist check, exactly as on the other two
surfaces, so any spelling of a pool reaches key policy as the pool's own id.

The vendor bag is the same one `packages/providers/src/openai/wire.ts:227` merges verbatim into an
upstream Responses body, so on an OpenAI target a passthrough field returns to its own dialect
unchanged. On a non-OpenAI target it is ignored and no degradation is recorded — that is the existing
behaviour of the chat surface, not something this change introduces.

### Input items

| Item | IR |
|---|---|
| `message` with `input_text` / `output_text` | `TextBlock` on that role |
| `input_image` (data URL or base64) | `ImageBlock` via `parseDataUrl`; a remote URL is never fetched, and is dropped with a degradation |
| `function_call` | `ToolUseBlock{id: call_id, name, input: JSON.parse(arguments)}` |
| `function_call_output` | `ToolResultBlock{toolUseId: call_id, content: output}` |
| `custom_tool_call` / `custom_tool_call_output` | the same two blocks; a freeform call has no JSON arguments, so its `input` is carried as `{input: <string>}` |
| `reasoning` | `ProviderNativeBlock{provider: "openai", blockType: "reasoning", data: <item verbatim>}` |
| `local_shell_call` / `local_shell_call_output` | the same `providerNative` treatment: model-produced, replayed verbatim, never reinterpreted |
| `item_reference` | `BAD_REQUEST` |
| an item with no `type` but a `role` | treated as `message` |

`function_call.arguments` that does not parse as JSON is a `BAD_REQUEST`, not a silent `{}`. It names
a real client bug, and the alternative is a tool call dispatched with no arguments at all.

The typeless-item fallback is measured, not defensive programming: Droid CLI sends role-bearing items
with no `type` field, and both peers carry the same fallback (omniroute
`request/openai-responses.ts:232-234`, 9router `openai-responses.js:62-64`).

Three constraints on ids and names, each of which both peers hit independently:

- `call_id` is clamped to **64 characters**, deterministically, so a `function_call` and its matching
  `function_call_output` keep the same id after clamping. The Responses API rejects longer ones.
- Tool names are bounded at **128 characters** matching `^[A-Za-z0-9_-]+$`.
- A `function_call` with an empty `name` or an empty `call_id` is dropped rather than carried: an
  empty name produces placeholder-tool loops, and an empty `call_id` can never be matched to its
  output, so the upstream rejects the orphaned result instead.

### Refusals and degradations

Refused with `BAD_REQUEST` naming the field: `previous_response_id`, `item_reference`, and
`store: true` **when explicitly set**. An omitted `store` is treated as false. That split is
deliberate: the real API defaults `store` to true, so refusing on absence would reject every stock SDK
call, while refusing on an explicit `true` catches the client that actually asked for server-side
state. Codex sends `store: false` explicitly, so it is unaffected either way.

Dropped with a recorded degradation: `background: true` and remote image URLs. The turn is still
answerable without either, which is the line between the two policies — a request that cannot be
answered correctly is refused, a request that can be answered less well is degraded and the loss is
recorded.

`background` is on the degrade side against the first instinct, and the reason is measured: omniroute
warns and strips it because "clients that set `background=true` opportunistically (Capy Captain Pro,
**Codex agents**) work unchanged" (`request/openai-responses.ts:189-208`). Refusing it would reject
real Codex traffic over a field the client does not depend on. `previous_response_id` stays a refusal
even though both peers strip it silently — silence there answers a question with no history and calls
it a success, which is the one failure this surface should not have.

`include: ["reasoning.encrypted_content"]` is accepted and lands in the vendor bag. It is a request
for something the round trip below has to make true; unknown `include` members are ignored.

## Egress: `apps/gateway/src/egress/responses.ts`

```ts
type ResponsesRender = { requestId: string; created: number; customToolNames: ReadonlySet<string> };

export async function* responsesStream(events, render: ResponsesRender): AsyncGenerator<SseFrame>
export function responsesResponse(collected: CollectedResponse, render: ResponsesRender): unknown
export function responsesErrorBody(code: ErrorCode, message: string): unknown
export function responsesRateLimitHeaders(headroom: HeadroomByDimension, now: number): Record<string, string>
```

`sseResponse` is already dialect-agnostic — it takes rendered `{event, data}` frames — so a new
surface needs a renderer and nothing else. Rate-limit headers are the chat surface's, rendered as
durations rather than RFC3339 instants.

The response id is `resp_<requestId>`. Nothing is stored, so it is an echo handle, not a lookup key.
Every event carries an incrementing `sequence_number`.

`customToolNames` is the set of tool names the client declared as freeform `custom` tools, taken from
the parsed request and threaded through `handle`. The egress needs it because **the same tool call
renders two different ways depending on how the client declared it**: omniroute records a live
incident where `apply_patch` was emitted as a `custom_tool_call` to a client that had registered it as
a function tool and dispatched only `function_call`, "so the tool call was silently never executed"
(`response/openai-responses.ts:529-545`). It is an argument and **not** a `vendor.openai` entry: that
bag is merged verbatim into the upstream body by `wire.ts:227`, so a private marker parked there would
be sent to the provider.

**Item indices come from one counter, and closing is checked.** `output_index` is allocated by a
single monotonic `open()` and released by a `close()` that refuses anything but the open item;
`content_index` is `0`. omniroute computed indices per item kind and shipped a **live incident
(2026-08-08)**: a short preamble message before a tool call took the slot the tool-call arithmetic
assumed was free, the two items collided on one `output_index`, and clients keying per-item state by
that index "silently dropped" the tool call. They now use exactly this stack discipline
(`utils/responsesOutputIndexStack.ts:3-18`).

### Item assembly

IR is a flat indexed block stream; Responses needs items containing parts. One state machine does the
conversion: a text block opens a `message` item if none is open and becomes a content part inside it;
a `thinking`, `toolUse` or `providerNative` block first closes any open message item, then opens its
own.

| IR event | Responses |
|---|---|
| `start` | `response.created`, then `response.in_progress` |
| `blockStart{text}` | `response.output_item.added` (message, if not already open) and `response.content_part.added` |
| `blockDelta{text}` | `response.output_text.delta` |
| `blockStart{thinking}` | `response.output_item.added` (reasoning) and `response.reasoning_summary_part.added` |
| `blockDelta{thinking}` | `response.reasoning_summary_text.delta` |
| `blockDelta{thinkingSignature}` | dropped; it is Anthropic-only and has no Responses spelling |
| `blockStart{toolUse}`, name not in `customToolNames` | `response.output_item.added` (`function_call`, `call_id` from the IR block id) |
| `blockDelta{toolJson}`, same | `response.function_call_arguments.delta` |
| `blockStart{toolUse}`, name in `customToolNames` | `response.output_item.added` (`custom_tool_call`) |
| `blockDelta{toolJson}`, same | buffered, then `response.custom_tool_call_input.delta` and `.done` **at close only** |
| `blockStart` / `blockDelta` for `providerNative` owned by openai | replayed as its own item, verbatim |
| `blockEnd` | the matching `…_text.done`, `…_part.done`, `output_item.done` |
| `end` | `response.completed` or `response.incomplete`, then `data: [DONE]` |
| `error` | `response.failed` carrying `response.error{code, message}` |

A custom tool's input is buffered and emitted whole, never streamed: the IR carries it as
`{"input": "<program>"}`, and streaming those JSON fragments would show the client the envelope
instead of the freeform program it expects (9router `response/openai-responses.js:315-317`).

The Responses API terminates on `response.completed` rather than a sentinel, but the real backend
sends `[DONE]` anyway and this repository's own decoder already tolerates one
(`packages/providers/src/openai/decode.ts:127-132`). Emitting it costs nothing and matches the
backend a client was written against. Codex itself closes the socket on `response.completed` and
never reads it.

**A stream that ends without a terminal event gets one synthesized.** If the IR event generator
finishes with neither `end` nor `error`, the egress emits `response.failed` carrying
`error: {type: "stream_error", code: "stream_disconnected"}` followed by `[DONE]`. Both peers do this
and 9router logs four separate issues for it (#1648, #1680, #1688, #1618): without a terminal event a
Codex client hangs until its own timeout rather than failing.

**Keepalive must be under five seconds on this surface.** `KEEPALIVE_MS` is `10_000`
(`proxy.ts:115`), and Codex's HTTP client "drops the connection if no bytes arrive within ~5s"
(omniroute `src/app/api/v1/responses/route.ts:87-89`, which is why they emit an early filler event at
all). Every Codex request whose first token is slower than that would die before the first byte. The
constant becomes per-surface, and this surface sends `: keepalive` comments at a shorter interval —
SSE comments, not a fabricated event. omniroute's opening filler is a **fake reasoning item**, which
their own code then has to keep index-balanced; a synthetic reasoning block is also content the client
may render, so it is not copied.

### Usage

`Usage.inputTokens` in this codebase is the **uncached remainder**, while the Responses API's
`input_tokens` is the total prompt. The parts are added back exactly as `promptTokens()` does:

```
input_tokens                           = promptTokens(usage)   // inputTokens + cacheRead + cacheWrite
input_tokens_details.cached_tokens     = usage.cacheReadTokens
output_tokens                          = usage.outputTokens
output_tokens_details.reasoning_tokens = 0
total_tokens                           = input_tokens + output_tokens
```

Getting this wrong under-reports the prompt on every Codex session, silently, in the direction that
looks like good news.

`reasoning_tokens` is emitted as `0` rather than omitted, because SDKs read the field. It is a stated
imprecision, not a measurement: IR does not separate reasoning tokens from output tokens, so the
honest value is unavailable rather than zero. Nothing downstream should be changed to agree with it —
in particular, the gateway's own cost arithmetic must keep using `Usage`, not this field.

### Status

| IR `stopReason` | Responses |
|---|---|
| `endTurn`, `toolUse`, `stopSequence` | `status: "completed"` |
| `maxTokens` | `status: "incomplete"`, `incomplete_details.reason: "max_output_tokens"` |
| `contentFilter` | `status: "incomplete"`, `incomplete_details.reason: "content_filter"` |
| `pauseTurn` | `status: "completed"` |

`pauseTurn` flattens to `completed`, which is what the chat surface already does with it
(`egress/openai.ts:30-34` renders `"stop"`), and it carries the same comment for the same reason. Two
earlier drafts of this section were wrong about it in two different ways, and both are worth stating
so neither comes back.

**It is not "reachable precisely because decision 3 routes to Anthropic".** `pause_turn` is emitted by
Anthropic for server-tool turns; server tools reach IR only as `AnthropicToolDef`; and only the
Anthropic ingress builds those. So an OpenAI-shaped client never declares one and never sees the stop
reason — the same guard the chat surface already relies on, reached by the same chain. The
hosted-tool widening does not open it either: those tools name `openai`, so they pin away from
Anthropic rather than toward it. The honest description is a theoretically-reachable case with a
structural guard in front of it, not a consequence of this design.

**It cannot carry a degradation, and an earlier draft said it did.** Degradations are collected inside
dispatch, from an `AdapterResult` or a `GatewayError` (`dispatch/index.ts:147-151`). The egress runs
after dispatch has finished and has no channel to append one, so `responses:pause-turn-flattened` was
unimplementable as written. Adding that plumbing to record a fact about a case with a structural guard
in front of it is not worth a new mutation path into the request log.

An invented `incomplete_details.reason` was the alternative — omniroute has precedent, using
`adapter_eof` and `upstream_stall_timeout` for its own transport cases. Declined: an unknown reason
string lands exactly where clients switch, and consistency with the chat surface's existing reading
matters more than expressing a signal the client has no way to act on.

**The chat surface is not changed, because it already agrees.** `"stop"` and `"completed"` are the
same reading in two dialects, not two readings — and the full tables are parallel, arm for arm:

| IR | chat `finish_reason` | Responses |
|---|---|---|
| `endTurn`, `toolUse`, `stopSequence` | `stop`, `tool_calls`, `stop` | `completed` |
| `maxTokens` | `length` | `incomplete` + `max_output_tokens` |
| `contentFilter` | `content_filter` | `incomplete` + `content_filter` |
| `pauseTurn` | `stop` | `completed` |

So there is nothing to align, and aligning the *spellings* would be the error: a Responses client
reading `finish_reason` or a chat client reading `status` is a client that has been handed the wrong
dialect. What the two surfaces must share is the **reading** — which IR stop reason means "finished
normally" — and they do. If one ever changes its mind about `pauseTurn`, both change together, or the
same turn is a success on one surface and a truncation on the other.

## Widening provider tools

`AnthropicToolDef` in `packages/ir/src/request.ts:209-221` is already all but generic: its `provider`
field is a `ProviderId`, not the literal `"anthropic"`, and its own comment says "whose schema this
is, and therefore the only provider that may receive it". The single Anthropic-specific field is
`family`. So the widening is one field, not a rewrite:

```ts
export type ProviderToolDef = {
  kind: "provider";
  provider: ProviderId;
  type: string;                    // exact wire type, never upgraded
  name: string;
  wire: Record<string, unknown>;   // every other validated field, verbatim
  cacheControl?: CacheControl;
  family?: AnthropicToolFamily;    // present only for tools whose schema Anthropic owns
};

export type AnthropicToolDef = ProviderToolDef & { family: AnthropicToolFamily };
export type ToolDef = CustomToolDef | ProviderToolDef;
```

`AnthropicToolDef` survives as the narrowed alias, so `ingress/anthropicTools.ts` and the Anthropic
encoder are unchanged and still get `family` non-optionally. A hosted OpenAI tool is
`{kind: "provider", provider: "openai", type: "tool_search"|"local_shell"|"web_search"|…, name, wire}`
with the declaration carried verbatim in `wire`, and `openai/wire.ts` re-emits it into `tools`.

This is the third outcome from rule 16's list — a named extension point — and it is chosen over the
first two because the alternatives do not reach: a descriptor cannot carry a tool the *client*
declared, and there is nothing to delete. The provenance is already on the value, which is why the
router needs no change: `requiredProviders` (`packages/router/src/filters.ts:56-59`) adds an owner for
every `kind: "provider"` tool it sees, so a hosted tool restricts routing by the same rule a native
block does.

The consequence, and it is larger than the reasoning one: **a request declaring a hosted tool pins to
OpenAI targets from turn 1.** Reasoning items only appear from turn 2, but tools are declared on the
first request, so a Codex session configured with `web_search` never has failover available at all.
`requiredCapabilities.tools` also becomes true for such a request, so a target without the `tools`
capability is excluded on top of that. Both are correct — a target that cannot receive the tool cannot
serve the turn — and both must be in the operator docs rather than discovered from an exclusion list.

## The provider round trip

Without this part, the ingress preserves reasoning items and the response throws them away: turn 2
carries turn 1's reasoning and turn 3 carries nothing. Two edits, both driven by the data, so no
provider learns what a client surface is.

**`packages/providers/src/openai/decode.ts`.** A `reasoning` item whose payload carries
`encrypted_content` becomes a `ProviderNativeBlock{provider: "openai", blockType: "reasoning"}`
holding the item verbatim, with `response.reasoning_summary_text.delta` riding as `providerNative`
deltas (`fold: "merge"`) so the summary still streams live. A reasoning item **without**
`encrypted_content` keeps today's behaviour exactly: `blockStart{thinking}` and thinking deltas.

That condition is the entire gate, and it needs no flag. Upstream returns `encrypted_content` only
when the request asked for it through `include: ["reasoning.encrypted_content"]`, and the only
ingress that sets that is this one — through the vendor bag `wire.ts:227` already merges. So Claude
Code on an OpenAI target sees byte-identical behaviour to today, and no code branches on the caller.

**`packages/providers/src/openai/wire.ts`.** The `providerNative` case currently drops every block
with `openai:anthropic-native-block-dropped` (`wire.ts:166-172`). It splits: a block whose `provider`
is `openai` is pushed back into `input`; anything else keeps the existing drop and degradation.
`requiredProviders` in `packages/router/src/filters.ts:56-75` guarantees the foreign arm is
unreachable, so it stays as the honest record it already is.

**Not verbatim: the item's `id` is stripped on replay.** Under `store: false` the backend cannot
resolve a server-assigned id, so a replayed item carrying one is rejected. Both peers strip the same
prefix pattern independently — omniroute `services/responsesInputPolicy.ts:3,28-30,49-51` and 9router
`codex.js:28-29,58-69`, both `/^(rs|fc|resp|msg)_/` — and both also drop bare id strings appearing as
items. What is replayed is `encrypted_content` and `summary`, without `id`. An earlier draft of this
spec said "verbatim", which would have 400'd every turn after the first.

The blob is **never decrypted, never inspected, never regenerated**, and no summary is fabricated for
an item that lacks one. omniroute records three issues on that last point (#7176, #7243): overwriting
the item to add a synthesized summary destroys the `encrypted_content` Codex needs for the next
request, and an invented "reasoning unavailable" paragraph gets echoed back by the model as its own
reasoning, which ended turns early (#9573, #9610).

**Orphaned tool calls are repaired.** The Codex backend rejects an `input` array containing a
`function_call` or `custom_tool_call` with no matching output item. IR strips orphaned tool *results*
in `validateRequest`, but nothing strips or completes an orphaned *call*, so `openai/wire.ts` inserts
a synthetic `{type: "<call type>_output", call_id, output: ""}` immediately after any call it emits
that has no result in the history (omniroute `executors/codex/toolCallRepair.ts:42-46`).

No router change is needed. `requiredProviders` reads `block.provider` off the data and requires
*every* named owner, so an openai-owned block restricts routing to openai targets by itself. This is
the same "make the value carry its own provenance" shape that let `needsAnthropicNative` be deleted.

**The consequence, stated plainly because it belongs in the operator docs and not in a request log:
from turn 2, a Codex conversation is pinned to OpenAI targets.** Turn 1 routes anywhere. Once the
client replays reasoning items, `requiredProviders` excludes every non-OpenAI target with
`excluded:capability:providerNative`, and failover mid-conversation stops being available. That is
the price of decision 3. A client that never receives reasoning items — anything not asking for
`include` — is unaffected.

## Mid-conversation system turns become `developer` items (OpenAI and xAI)

`openai/wire.ts:115-133` currently renders a mid-conversation system message as a **user** turn whose
text is wrapped in `<system-reminder>…</system-reminder>`, recording `openai:system-turn-inlined`. The
comment explains the constraint correctly — the Codex backend refuses a `system` item inside `input`,
it supplies its own — but the documented fallback it names is not the only one. The Responses API
takes a `developer` role, and both peers use it for exactly this case; omniroute's reason is
cache-shaped: rewriting system turns to `developer` "keeps content in the cacheable prefix"
(`executors/codex.ts:49-56`), and they log a separate fix for having lost developer instructions in
this conversion at all (#6954/#7056).

So the encoder emits `{type: "message", role: "developer", content: [...]}` with the text unwrapped,
and records `openai:system-turn-as-developer` instead. This is strictly closer to the invariant this
repository already states — *keep mid-conversation system messages in place, never fold into
request-level `system`* — because a `developer` turn keeps both its position and its operator role,
where a `<system-reminder>` user turn kept only the position.

**`grok/wire.ts` changes the same way, and its own comment is why.** It carries identical inlining and
a `grok:system-turn-inlined` degradation, and says plainly that the behaviour was inherited rather
than measured: "No xAI source says whether the proxy accepts a system turn inside `input`, and the
OpenAI fork's answer is the safe one either way" (`grok/wire.ts:82-87`). xAI serves this same dialect
at `/v1/responses` on both legs (`grok/codec.ts:19-20`), so the fork's answer stops being the safe one
the moment the fork changes. It becomes `openai:system-turn-as-developer`'s sibling,
`grok:system-turn-as-developer`.

**Both encoders flip only behind a probe, and the probe is per leg.** Nothing in this work has
measured that either backend accepts a `developer` item — omniroute's evidence is about the Codex
backend specifically, and xAI has no published answer at all. So the step begins by sending one
`developer`-item request against each of the four legs that exist — OpenAI OAuth (Codex), OpenAI API
key, xAI OAuth proxy, xAI API key — and any leg that refuses keeps the inlined user turn it has today.
A leg-by-leg result is the point: `grok/codec.ts` names two different hosts, and a proxy built for one
CLI is exactly the kind of surface that accepts less than the documented API does. Recording "we did
not check" beats recording a guess, which is the state this code is in now.

**It changes traffic that exists today** — every Claude Code request carrying a mid-conversation
system turn on an OpenAI or xAI target — which is why it lands as its own step with before-and-after
golden tests rather than inside the ingress work. The old degradation strings stay readable in
`request_logs` without migration: degradations are forensic text, never parsed on read, the same
property that let `excluded:capability:anthropicTools` rows survive their rename.

`packages/providers/test/openai.test.ts:570-580` and `packages/providers/test/grok.test.ts:279-284`
pin the current behaviour and are rewritten with it; the golden bytes change in exactly one place per
encoder.

## Verification

No Codex ingress capture can exist before the route does, so the schema is measured, not assumed.

Phase 0 lands the route and a best-effort parser written from Codex's own source and the API
documentation, with body logging on. Captured client bodies already reach disk encrypted through
`bodyCollectorFor` → `captured.client.request`, so the capture needs **no new logging path** and none
is added: `LogFields` is a closed allowlist, and a "log the keys I saw" field is exactly the
free-text hole that rule exists to prevent. Real Codex is pointed at the route, and a throwaway
script reads the artifacts back and prints the **top-level key set of each body** and the `type` set
across `input` items. Only then are `KNOWN`, the zod schema and the refusal list frozen.

Printing the key set rather than one member's value is the specific discipline: this repository has
twice recorded a client field name wrong, in both directions, each time from a half-read capture, and
each time the error survived typecheck and the full suite because reading a name no client sends
falls through to a working fallback.

## Testing

- `apps/gateway/test/ingress/responses.test.ts` — the item matrix (`message`, `function_call`,
  `function_call_output`, `custom_tool_call`, `reasoning`, `local_shell_call`, `item_reference`);
  `store` omitted versus explicitly `true`; the `previous_response_id` and `background` refusals;
  non-JSON `arguments` refused; `[1m]` normalized before the allowlist; `conversationId` precedence
  of `prompt_cache_key` over the `session-id` header.
- `apps/gateway/test/egress/responses.test.ts` — event order and `sequence_number` monotonicity;
  `response.completed` followed by `[DONE]`; the usage arithmetic, which is the one assertion that
  catches the under-report; each status and `incomplete_details` arm; a mid-stream `error` rendering
  as `response.failed`.
- `apps/gateway/test/egress/roundtrip.test.ts` gains a Responses arm: Responses → IR → Responses
  preserves reasoning items, tool calls and images, and **drops the reasoning item's `id`**.
- Two failure shapes that hang a client rather than erroring, so neither is visible without its own
  test: an IR generator ending with no `end` or `error` event must still produce `response.failed`
  plus `[DONE]`, and a client that closes the socket immediately after `response.completed` — which is
  what Codex does — must still leave a usage row and a finished request log behind. The second is the
  bug 9router logged as usage side effects being cancelled with the reader (`stream.js:70-102`).
- Keepalive interval on this surface is under five seconds, asserted on the constant, since the
  failure it prevents is a client-side disconnect no gateway test would otherwise observe.
- A tool declared `custom` renders as `custom_tool_call` with its input emitted whole at close; the
  same tool declared as a `function` renders as `function_call` with streamed argument deltas.
- `output_index` never repeats within one stream, including the preamble-message-then-tool-call
  sequence that collided in omniroute's production incident.
- `openai/wire.ts` emits a synthetic empty output for a tool call with no result in history.
- A mid-conversation system turn encodes as a `developer` item with unwrapped text on both encoders,
  recording `openai:system-turn-as-developer` and `grok:system-turn-as-developer` — or, for any leg
  the probe showed refuses it, the inlined user turn it has today, with a test naming that leg and the
  refusal it encodes.
- `pauseTurn` renders `status: "completed"` with no `incomplete_details`; the chat surface still
  renders `"stop"` and the Anthropic surface still renders `pause_turn`, all three from one IR event.
  Asserting the three together is what stops a later change to one from silently disagreeing with the
  other two.
- `packages/providers/test/` — decode with and without `encrypted_content`, the second arm being the
  regression guard for Claude Code on OpenAI targets; wire re-emitting an openai-owned
  `providerNative` while still dropping a foreign one with its existing degradation.
- Routing — a Responses request with no reasoning reaches an Anthropic target; one carrying reasoning
  excludes it with `capability:providerNative`. The turn-2 pin is asserted, not discovered.
- The existing surface enumerations gain the third path: `apps/gateway/test/routes/proxy.test.ts:86`,
  `apps/gateway/test/routes/rateLimitHeaders.test.ts:43`, and `apps/gateway/test/latch.test.ts:162`,
  the last of which is what pins the `quiesceResponse` fix.

## Build order

1. Phase 0: route, skeleton parser, capture, freeze the schema.
2. `ProviderToolDef` in `@omni/ir`, with the Anthropic paths proved unchanged.
3. Ingress, egress, route wiring, and the three widenings.
4. The provider round trip: reasoning replay, id stripping, tool-call repair.
5. Probe the four legs for `developer`-item support, then move mid-conversation system turns on the
   legs that accept it. **Done for the OpenAI OAuth leg only** — measured, accepted, shipped. The
   OpenAI API-key host documents the role and was not reachable to check; both xAI hosts remain
   unmeasured, and `grok/wire.ts` says so at the line that would be reverted.
6. Documentation.

Steps 4 and 5 are last because they are the only parts that change behaviour for traffic that already
exists, and 5 is last of all because it is the only one that changes it for clients — Claude Code on
an OpenAI or xAI target — that are not asking for this feature at all. Each lands with its regression
test already in the tree. Step 5's probe comes before its edit, not after: the current inlining is
what a refusing leg keeps, so a probe run afterwards would be measuring a change already shipped.

Step 2 is first among the code steps because it is a core type change: everything downstream compiles
against it, and doing it after the ingress would mean writing the hosted-tool path twice.

## What the peers got that this design declines

Both peers normalize silently almost everywhere: `store` forced to false, `previous_response_id`
deleted, `item_reference` filtered, all without telling the client. This design keeps two refusals
(`previous_response_id`, explicit `store: true`) because answering a request for prior state with no
prior state is a wrong answer that reads as a model failure.

Neither peer's status handling is worth copying. 9router has no `incomplete_details` at all and passes
`finish_reason` through as the status string, so a truncated turn reports `status: "length"` — not a
value the API defines. omniroute does map `max_tokens` and `content_filter` correctly
(`vendor/codex-chatgpt-web/bridge.ts:849-864`, which is where this design's mapping was checked
against a second implementation) but also invents reasons for transport cases (`adapter_eof`,
`upstream_stall_timeout`). That is precedent for giving `pauseTurn` its own invented reason instead of
flattening it; this design still flattens, for the reasons under *Status*.

9router carries two contradictory usage comments in one tree — one asserting `input_tokens` already
includes cached tokens, the other reporting a measurement where it did not (2012 reported against a
real prompt of ~5344, 5332 of it cached). omniroute resolves the same question by discriminating on
which spelling arrived: nested `input_tokens_details.cached_tokens` is inclusive, flat
`cache_read_input_tokens` is exclusive and summed. This design is not exposed to the ambiguity —
`Usage` has one meaning and the egress adds the parts back — but the ambiguity is why the arithmetic
is written out in full above rather than left to the reader.

Two operational findings apply to this repository even though they sit outside this change, and
belong in follow-ups rather than here: omniroute's stream timeout is enforced **per read** rather than
per request, because "a 200 text/event-stream whose body never emits a byte" bypassed both of their
timeouts and hung for ~15 minutes (`executors/codex/bodyTimeout.ts:1-13`); and Codex embeds
`model_at_capacity` and overload errors **inside a 200-OK SSE body**, which both peers detect and
re-surface as real errors so account rotation happens (9router `codex.js:16-26`, omniroute
`CHANGELOG.md:1638`). The second decides whether a Codex capacity failure fails over here or is served
to the client as a successful stream carrying an error.

A third finding was folded into this design rather than deferred — see *Mid-conversation system turns
become `developer` items*.

## Documentation to update

`README.md:24-25, 290-292, 318` (endpoint table), the client-surface list in `CLAUDE.md`,
`ARCHITECTURE.md:24, 41, 66` (the "dialect is a parameter" sentences), and the status line of
[agent client context and setup](2026-08-09-agent-client-context-and-setup-design.md), whose section
6 stops being deferred. Both routing pins — hosted tools from turn 1, reasoning items from turn 2 —
go in the operator-facing docs, not only here.

`GET /api/agent-setup?client=` gains a Codex arm, and two of its details are measured rather than
guessed: Codex **requires** `wire_api = "responses"` (setting `"chat"` crashes it at startup since
v0.138), and it validates that the configured `env_key` exists *before* the first request leaves the
CLI, so the generated config needs a placeholder key even against a local gateway
(omniroute `docs/guides/CODEX-CLI-CONFIGURATION.md:58-60,80`).

## Rejected alternatives

**A shim onto the chat surface.** Rewrite a Responses body into a chat-completions body and reuse
`parseOpenAIRequest`. Cheapest by a wide margin, and rejected because reasoning items — the thing
decision 3 exists to preserve — have no chat-completions spelling at all, so they die in the shim.
Two lossy hops instead of one.

**A separate route module with its own handler.** Duplicates authentication, key policy, rate
limiting, body capture and logging. `CLAUDE.md` rule 5 puts those in one place for the reason that a
second copy diverges silently in the widening direction.

**Collapsing the four dialect switches into a record.** `{parse, stream, response, errorBody,
rateLimitHeaders}` keyed by surface, with `quiesceResponse` reading it instead of comparing path
strings, is a real improvement and is the right shape for a fourth surface. It is deliberately not
part of this change: it edits both existing surfaces, so a regression in `/v1/messages` and a bug in
`/v1/responses` would arrive in one diff with no way to tell them apart. `quiesceResponse` gets the
new path string here; the refactor is its own change with its own before-and-after evidence.

**Dropping hosted tools with a degradation**, which is what this spec said before the peers were
read. Cheapest, and it keeps every target routable. Rejected on their evidence: dropping `tool_search`
breaks Codex's deferred tool-loading protocol outright, and a Codex Desktop session sends
`image_generation` on every request including text-only ones — so the degradation would be recorded
constantly and mean nothing.

**Carrying hosted tools in the vendor bag** instead of widening `ToolDef`. Rejected because the bag is
merged wholesale into the upstream body, so it would collide with the `tools` array the encoder builds
from IR, and non-OpenAI targets would drop them with nothing recorded.

**Dropping reasoning items, as the IR path does today.** Keeps every target routable on every turn.
Rejected because the Codex backend loses its own reasoning chain across turns under `store: false`,
degrading both answer quality and cache hit rate, with nothing upstream reporting it.

**Carrying `encrypted_content` in `ThinkingBlock.signature`.** Keeps cross-provider routing on turn 2
and needs no new block type. Rejected because `signature` means "Anthropic signature" everywhere
else, and Anthropic replay preserves signatures rather than dropping them — so a foreign blob would
be replayed at Anthropic and rejected upstream. Making this work would mean growing the field to
carry provenance, which is a larger change than the one it avoids.
