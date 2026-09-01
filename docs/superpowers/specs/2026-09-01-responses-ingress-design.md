# OpenAI Responses ingress

*Status: designed, not implemented.*

`POST /v1/responses` becomes a third client surface, beside `POST /v1/messages` (Anthropic) and
`POST /v1/chat/completions` (OpenAI chat). It is an ingress and an egress over the existing core, not
a new provider and not a passthrough.

The driver is Codex CLI. Codex speaks only the Responses API — `wire_api = "chat"` is a hard error in
it — so today it cannot connect to this gateway at all. Section 6 of
[agent client context and setup](2026-08-09-agent-client-context-and-setup-design.md) reserved this
work and deferred it; this design supersedes that section.

## Decisions

Four choices shape everything below. Each is stated with what it costs, because each has a cheaper
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
| `tools` | `function` → `CustomToolDef{kind:"portable"}`; `custom` (freeform) → portable with a permissive schema; hosted tools dropped with a degradation |
| `tool_choice` | `"auto"`/`"none"` unchanged; `"required"` → `{type:"any"}`; `{type:"function", name}` → `{type:"tool", name}` |
| `max_output_tokens` | `maxTokens` |
| `temperature` | `temperature` |
| `reasoning.effort` | `{mode:"adaptive", effort}`; `reasoning.summary: "none"` adds `display: "omitted"` |
| `stream` | `stream` (absent is false) |
| `prompt_cache_key`, else the `session-id` header | `conversationId` |
| anything else | `vendor.openai` |

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

`function_call.arguments` that does not parse as JSON is a `BAD_REQUEST`, not a silent `{}`. It names
a real client bug, and the alternative is a tool call dispatched with no arguments at all.

### Refusals and degradations

Refused with `BAD_REQUEST` naming the field: `previous_response_id`, `background: true`,
`item_reference`, and `store: true` **when explicitly set**. An omitted `store` is treated as false.
That split is deliberate: the real API defaults `store` to true, so refusing on absence would reject
every stock SDK call, while refusing on an explicit `true` catches the client that actually asked for
server-side state. Codex sends `store: false` explicitly, so it is unaffected either way.

Dropped with a recorded degradation: hosted tools (`web_search`, `file_search`, `code_interpreter`,
`computer_use`) and remote image URLs. The turn is still answerable without them, which is the line
between the two policies — a request that cannot be answered correctly is refused, a request that can
be answered less well is degraded and the loss is recorded.

`include: ["reasoning.encrypted_content"]` is accepted and lands in the vendor bag. It is a request
for something the round trip below has to make true; unknown `include` members are ignored.

## Egress: `apps/gateway/src/egress/responses.ts`

```ts
export async function* responsesStream(events, requestId, created): AsyncGenerator<SseFrame>
export function responsesResponse(collected: CollectedResponse, requestId: string, created: number): unknown
export function responsesErrorBody(code: ErrorCode, message: string): unknown
export function responsesRateLimitHeaders(headroom: HeadroomByDimension, now: number): Record<string, string>
```

`sseResponse` is already dialect-agnostic — it takes rendered `{event, data}` frames — so a new
surface needs a renderer and nothing else. Rate-limit headers are the chat surface's, rendered as
durations rather than RFC3339 instants.

The response id is `resp_<requestId>`. Nothing is stored, so it is an echo handle, not a lookup key.
Every event carries an incrementing `sequence_number`.

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
| `blockStart{toolUse}` | `response.output_item.added` (`function_call`, `call_id` from the IR block id) |
| `blockDelta{toolJson}` | `response.function_call_arguments.delta` |
| `blockStart` / `blockDelta` for `providerNative` owned by openai | replayed as its own item, verbatim |
| `blockEnd` | the matching `…_text.done`, `…_part.done`, `output_item.done` |
| `end` | `response.completed` or `response.incomplete`, then `data: [DONE]` |
| `error` | `response.failed` carrying `response.error{code, message}` |

The Responses API terminates on `response.completed` rather than a sentinel, but the real backend
sends `[DONE]` anyway and this repository's own decoder already tolerates one
(`packages/providers/src/openai/decode.ts:127-132`). Emitting it costs nothing and matches the
backend a client was written against.

Downstream `: keepalive` comments are unchanged — they come from `withKeepalive` in `sseResponse` and
are surface-independent.

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
| `pauseTurn` | `status: "completed"`, degradation `responses:pause-turn-flattened` |

`pauseTurn` is Anthropic-only and is reachable here precisely because decision 3 lets a Responses
request route to an Anthropic target. Inventing an `incomplete_details.reason` the API does not
define would put an unknown string exactly where clients switch; flattening loses the "continue me"
signal but keeps the response parseable, and the degradation is what keeps the loss visible.

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
is `openai` is pushed back into `input` verbatim; anything else keeps the existing drop and
degradation. `requiredProviders` in `packages/router/src/filters.ts:56-75` guarantees the foreign arm
is unreachable, so it stays as the honest record it already is.

No router change is needed. `requiredProviders` reads `block.provider` off the data and requires
*every* named owner, so an openai-owned block restricts routing to openai targets by itself. This is
the same "make the value carry its own provenance" shape that let `needsAnthropicNative` be deleted.

**The consequence, stated plainly because it belongs in the operator docs and not in a request log:
from turn 2, a Codex conversation is pinned to OpenAI targets.** Turn 1 routes anywhere. Once the
client replays reasoning items, `requiredProviders` excludes every non-OpenAI target with
`excluded:capability:providerNative`, and failover mid-conversation stops being available. That is
the price of decision 3. A client that never receives reasoning items — anything not asking for
`include` — is unaffected.

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
  preserves reasoning items, tool calls and images.
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
2. Ingress, egress, route wiring, and the three widenings.
3. The provider round trip.
4. Documentation.

The round trip is last because it is the only part that changes behaviour for traffic that already
exists, so it lands with its regression test already in the tree.

## Documentation to update

`README.md:24-25, 290-292, 318` (endpoint table), the client-surface list in `CLAUDE.md`,
`ARCHITECTURE.md:24, 41, 66` (the "dialect is a parameter" sentences), and the status line of
[agent client context and setup](2026-08-09-agent-client-context-and-setup-design.md), whose section
6 stops being deferred. The turn-2 routing pin goes in the operator-facing docs, not only here.

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

**Dropping reasoning items, as the IR path does today.** Keeps every target routable on every turn.
Rejected because the Codex backend loses its own reasoning chain across turns under `store: false`,
degrading both answer quality and cache hit rate, with nothing upstream reporting it.

**Carrying `encrypted_content` in `ThinkingBlock.signature`.** Keeps cross-provider routing on turn 2
and needs no new block type. Rejected because `signature` means "Anthropic signature" everywhere
else, and Anthropic replay preserves signatures rather than dropping them — so a foreign blob would
be replayed at Anthropic and rejected upstream. Making this work would mean growing the field to
carry provenance, which is a larger change than the one it avoids.
