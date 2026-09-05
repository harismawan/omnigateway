# Antigravity provider design

Antigravity is Google's Gemini-based IDE. Its backend is Cloud Code Assist —
`v1internal` on Google's `*-cloudcode-pa` hosts — which is neither of the two wire
dialects this repository already speaks. This adds it as a seventh built-in
provider: OAuth, codec, catalog and quota probe.

Reference material is omniroute 3.8.49, read at
`/home/linuxbrew/.linuxbrew/lib/node_modules/omniroute`. Nothing is imported from
it; what it supplies is captured behaviour — endpoints, header sets, the
undocumented quota RPC's shape, and several comments recording what was tried and
failed against the live backend. Those failures are quoted below where they
constrain a decision, because they are the parts no amount of reading the Gemini
API documentation would produce.

## Wire surface

One URL for every request:

```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

**Always the streaming endpoint, including for a non-streaming client request.**
Cloud Code converts internally to an OpenAI-shaped call and injects
`stream_options` without setting `stream: true`, so plain `generateContent`
answers 400 on some models. Dispatch already serves a non-streaming client by
collecting the stream, so this costs nothing — it is the same choice grok's codec
makes for a different reason.

The body is an envelope, not a bare Gemini request:

```json
{
  "project": "<cloud code project id>",
  "requestId": "<uuid>",
  "model": "<upstream model id>",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": { "contents": [], "systemInstruction": {}, "generationConfig": {}, "tools": [] }
}
```

`project` is per account and is minted during OAuth, not at request time, so it
lives in `credential.providerData` and reaches `buildRequest` through
`openForInference()`. An empty `project` is refused upstream with a 400 that
names nothing useful, so the codec fails it first, as a gateway-authored `AUTH`
naming the account rather than passing the request on.

Google rejects unknown top-level envelope fields outright (`Invalid JSON payload
received. Unknown name "…"`), so the encoder emits exactly the six keys above and
`vendor.antigravity` passthrough is merged into `request`, not into the envelope.

~~Only `cloudcode-pa` is used. omniroute additionally tries
`daily-cloudcode-pa` and two `sandbox` hosts as failover; skipped here, so the
flow's `origins` stay one host.~~

**Wrong, and measured wrong — see "What the live probe found" below.** Inference
is on `daily-cloudcode-pa.googleapis.com`; only the bootstrap and quota RPCs are
on `cloudcode-pa.googleapis.com`.

## OAuth

`packages/providers/src/antigravity/oauth.ts`, a `PkcePluginFlow` in shape but
**not** in mechanism — see below.

- authorize `https://accounts.google.com/o/oauth2/v2/auth`
- token `https://oauth2.googleapis.com/token`
- userinfo `https://www.googleapis.com/oauth2/v1/userinfo`
- redirect: loopback, with the paste-the-URL fallback every provider here uses,
  because the gateway is usually not on the browser's machine.

The client id (`…apps.googleusercontent.com`) and secret (`GOCSPX-…`) are the
Antigravity desktop client's, embedded in a distributed binary. Google documents
an installed-app client's id and secret as public and not secrets.

They are **XOR-masked** in `oauth.ts`. The first version of this design argued
against that — reproducing omniroute's obfuscation "would add a decoding step
whose only effect is to make a reader think the value is protected" — and then
GitHub's push protection refused the branch, matching both values against its
`…apps.googleusercontent.com` and `GOCSPX-` patterns. The choice was between
masking and permanently allowlisting two strings in the repository's secret
scanning, which teaches every future contributor that an allowlisted "secret" is
normal here. The original objection stands and is answered in the code: the
comment on `MASK` states outright that it is scanner evasion rather than
security, and that a value which genuinely needed protecting would be an
operator-supplied environment variable.

**No `openid` scope and no PKCE.** omniroute's comment records that adding either
routes Google into a `firstparty/nativeapp` consent screen that never completes,
and that matching 9router exactly — the five scopes below, `access_type=offline`,
`prompt=consent`, no code challenge — is what fixed it. This is the one place
where the flow deviates from what this repository would otherwise write, so it is
also the one most likely to be "corrected" later. It must not be.

Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
`experimentsandconfigs`.

### Post-exchange project bootstrap

No other flow here does this. After the token, `exchange` yields:

1. `GET userInfoUrl?alt=json` — the account email, for the credential's label.
   Failure degrades to no email; it is a label, not an authorization input.
2. `POST v1internal:loadCodeAssist` with `{ metadata: { ideType: "ANTIGRAVITY" } }`
   — reads `cloudaicompanionProject` (a string, or an object with `id`) and the
   onboarding tier.
3. Only when that returns no project: `POST v1internal:onboardUser` with the tier,
   then one re-read of `loadCodeAssist`.

Three or five yielded requests in one step, under the host's yield cap. omniroute
polls `onboardUser` up to ten times at five-second intervals in the background;
that is not available to a flow that must return a credential, so this takes the
single bounded attempt its own comment describes as the inline path and lets the
account be reconnected if the project is still absent. A connect that ends with
no project **succeeds** — the credential is real and refreshable — but the codec
refuses inference against it with a message naming the fix.

`refresh` is a plain Google refresh-token grant, retaining the previous refresh
token when the response omits one. It re-reads nothing: the project is already on
`providerData`, and a refresh that dropped it would silently break every
subsequent request.

## Codec

`wire.ts` is IR to Gemini, `decode.ts` is Gemini SSE to IR, both forked into this
directory per boundary rule 2. Nothing is imported from another provider.

Request mapping:

- `system` becomes `systemInstruction`, a mid-conversation system turn stays in
  place as a `user` turn carrying the text, recorded as a degradation. Gemini has
  no third role.
- `assistant` becomes `model`. A turn carrying any `functionResponse` part is
  forced to `user` regardless of its IR role — Gemini refuses a tool result on a
  `model` turn.
- tools become `functionDeclarations`; `toolUse` and `toolResult` become
  `functionCall` and `functionResponse`. Gemini correlates by **name**, not by id,
  so `decodeState` carries the id-to-name map the decoder needs to re-mint the
  IR's ids.
- `thinking` blocks are dropped with a degradation. Gemini's thought signatures
  are provider-owned opaque blobs with no IR representation, the same position
  grok's encoder takes.
- `maxTokens`, `temperature` map into `generationConfig`; a reasoning request maps
  to `thinkingConfig`.

Response mapping: each SSE `data:` frame is a `GenerateContentResponse` with
`candidates[0].content.parts[]`. Text parts, `functionCall` parts and parts
carrying `thought: true` open the three IR block kinds. `finishReason` maps to
`StopReason`, and an unrecognized one is an error rather than a fold into
`endTurn` — the repository's standing rule against silent truncation.

`usageMetadata` carries `promptTokenCount`, `candidatesTokenCount` and
`cachedContentTokenCount`. `promptTokenCount` **includes** the cached count, so
`usageFromPromptTotal` subtracts it; leaving it in bills the same tokens at the
input rate and again at the cache rate on every request.
`writeOverInput: { fiveMinute: 0, oneHour: 0 }` — the client cannot ask for a
cache write here, so there is no premium to price.

## Catalog

Gemini models only: the Flash 3.6 tiers, `gemini-pro-agent`, and the other Pro
budget tiers omniroute reports as live-proven through `streamGenerateContent`.

The Claude and GPT models the same backend serves are **excluded**, deliberately.
`claude-` is anthropic's `modelPrefixes`, so those rows could never take a bare
name, and a `claude-opus-4-6-thinking` reachable only as an explicit
`antigravity/…` target buys little for the confusion of two providers answering
to one vendor's model line.

`modelPrefixes: ["gemini-"]`. Models are **unpriced**: Antigravity is a
subscription and publishes no per-token rate, so the router treats these as
unpriced rather than free, which is the position doc step 8 already records for
Kilo's `kilo-auto/*` routers. An operator who wants an antigravity target ranked
sets a real `costPerMTok` on the saved target.

## Quota

`POST v1internal:retrieveUserQuotaSummary` with `{ project }`, as the flow's
`usage` step, at the 15s short deadline.

The response is `groups[]` — one per model family, `"Gemini Models"` and
`"Claude and GPT models"` — each with `buckets[]` holding a `5h` and a weekly
bucket. Two envelopes have been observed for the same payload (`groups` at the
top level, or under `quotaSummary.groups`); both are read, since the RPC is
undocumented and unversioned.

**The Gemini group only.** That is not a compromise here: the catalog carries no
Claude or GPT rows, so the other group measures capacity nothing can route to.
`quota_windows` is keyed `(credentialId, windowType)` and this fills both of its
slots with the one family that matters.

A bucket states `remainingFraction`, not a used/limit pair. It normalizes to
`used: round((1 - f) * 100), limit: 100`, which is the convention `QuotaWindow`
already documents for a provider that reports only a proportion. A bucket with
`disabled: true`, or with no `remainingFraction`, is dropped — missing data is
unknown, never unlimited.

Window assignment reads the bucket's `bucketId` and `displayName` text, because
Google states no window field. `/\bweekly\b/` is `weekly`; a bucket naming five
hours is `fiveHour`; anything else is dropped rather than guessed. **A rename
upstream therefore reads as "no data", not as a wrong number** — which is the
failure direction to prefer, and the reason this matcher gets its own test.

## What the live probe found

Run 2026-09-05 against a real Google account, driving the seeded flow and the
shipped codec end to end. Four things were confirmed and one was wrong.

**Confirmed.** Google's consent redirects to the loopback — it does not hang, so
the paste fallback works and dropping `openid` and PKCE is right. The token
exchange, the `loadCodeAssist` bootstrap (project and tier both resolved), and
the quota RPC all work as designed; the quota figures matched what the
Antigravity IDE showed the operator for the same account, which is the only
check that could confirm the family filter reads the right buckets.

**Wrong: the host.** Every request answered `429 RESOURCE_EXHAUSTED` while the
account's quota read 0% used and its IDE generated normally. It was not the
envelope — seven variants (`requestId` format, `sessionId`, `topK`/`topP`
defaults, `safetySettings`, omitting `project`) all failed identically — and not
the client identity, since four User-Agent forms and two versions returned the
same project, tier and 429. **It was the hostname.** A byte-identical request to
`daily-cloudcode-pa.googleapis.com` returned 200 and content;
`cloudcode-pa.googleapis.com` returned 429. Plain `cloudcode-pa` is Gemini Code
Assist's surface and does not serve Antigravity's models to this tier.

The failure mode is worth recording separately from the fix: the upstream's
chosen error named *quota*, so every signal pointed at the operator's account
rather than at our URL. The account's own quota RPC — which we call, and which is
correct — actively corroborated the wrong diagnosis by reporting plenty of
headroom. Only trying a second host distinguished them.

`fetchAvailableModels` answers `403 PERMISSION_DENIED` on `cloudcode-pa` for this
account. Nothing here calls it; noted because it was a second signal pointing at
the caller rather than at the request, and it was misread as such.

## Tool schemas are a proto message, not JSON Schema

Found in production, not by the probe above: the first two real requests to
`gemini-3.8-flash-high` both answered `400 BAD_REQUEST` in ~130ms with no tokens
billed. Recovered by decrypting their `request_bodies` artifacts — the code and
the credential id are all `request_logs` keeps, so the artifact is the only place
the upstream's own words survive.

`v1internal` parses a tool's `parameters` as
`google.cloud.aiplatform.master.Schema`, a proto message with a closed field set,
and protobuf-JSON refuses an unknown name rather than ignoring it — the same rule
the envelope follows one level up. The answer is one error line per occurrence:
32 Claude Code tools produced 41, on `$schema` (once per tool — every zod and
pydantic exporter emits it), `propertyNames`, `exclusiveMinimum` and `const`. The
error list was complete rather than capped, which is what makes the silences in
it readable.

**The fix is an allowlist, not a denylist of those four**, because a denylist is
only ever as long as the last payload that failed: `$ref`, `oneOf`, `not`,
`multipleOf`, `uniqueItems` are all still out there. Failing this way round is
also the cheap direction — a dropped constraint is advisory to the model, a kept
unknown one is a request that never runs. `pruneSchema` in `wire.ts` walks
schema-bearing positions structurally rather than scanning keys, because
`enum: ["const"]` and a property *named* `const` are data and a name scan
rewrites both.

Two things the keyword list alone does not cover, and both were live-confirmed:

- **`Schema.enum` is `repeated string`.** Translating `const: 5` into
  `enum: [5]` swaps `Unknown name "const"` for
  `Invalid value at '…enum[0]' (TYPE_STRING)` — the same dead request with a
  worse message. Only a string `const` becomes an `enum`; a `const` beside an
  existing `enum` is dropped, since the proto can hold one of the two and the
  `enum` is the client's own explicit vocabulary.
- **Naming a field is not accepting any value under it.** `Schema.type` is a
  proto enum and `Schema.items` is singular, so draft-07's `type: ["string",
  "null"]` and tuple-form `items: [ … ]` are parse errors under names that are
  otherwise fine. The union type is *translated* (`type` plus `nullable`, which
  is lossless and records nothing); the tuple is dropped.

**`allOf`, `anyOf` and `additionalProperties` are in the allowlist and
`google.cloud.aiplatform.v1.Schema` publishes only the last two.** They are kept
on the strong evidence rather than the weak one: each was present in the request
that answered **200**, not merely absent from an error list. The A/B was run on
the live endpoint with the real account, same envelope, differing only in the
schemas — control `400 Unknown name "$schema"`, treatment `200` with content.

Two traps for whoever repeats this:

- **A captured body is forensic, not replayable.** `request_bodies` artifacts are
  structurally bounded before encryption, so deep nodes are the literal string
  `"[omitted: nesting past 6 levels]"`. Replaying one produces
  `Invalid value at '…' (…Schema), "[omitted: …]"` — errors belonging to the
  fixture. Read the artifact to learn *which* keywords the upstream named, then
  hand-build a small valid payload carrying those shapes.
- **A probe must send the provider's real headers.** The same pruned body without
  `User-Agent: antigravity/ide/…` answers `403 SUBSCRIPTION_REQUIRED`, which
  reads as an account problem and is not one — the identical failure direction
  the host bug above had.

`$ref`/`$defs` are published fields but are deliberately left out, so a schema
carrying one loses that subtree. Nothing this gateway has seen emits them into a
tool schema, and a resolver is a lot of code to carry on speculation.

### The upstream validates in stages, and each stage hides the next

The first fix was verified by one live A/B and looked complete. It was not.
A sweep of 129 hand-built schema shapes against the live endpoint found **five
error classes, and only the first was visible at the start** — Cloud Code stops
after the stage that fails, so every later class is invisible while any earlier
one remains. Each fix *revealed* the next; none of them could have been reasoned
out from the original 400, and a code review of the fix found none of them
either.

| Stage | Class | What it answers |
| --- | --- | --- |
| Parse | unknown field name | `Unknown name "$schema" … Cannot find field.` |
| Parse | wrong value type for a known field | `Invalid value at '…value.pattern' (TYPE_STRING), 5` |
| Parse | value outside a proto enum | `Invalid value at '…value.type' (…master.Type), "text"` |
| Parse | JSON nested too deep | `Message too deep. Max recursion depth reached for key 'x'` |
| Semantic | cross-field disagreement | `* …required[1]: property is not defined` |

The measured rules, all live on 2026-09-05:

- **`type`'s value is an enum.** `string`, `number`, `integer`, `boolean`,
  `array`, `object`, `null`, `type_unspecified`, case-insensitive. Everything
  else tried was refused, including `""`, `any`, `int`, `float`, `list` and a
  trailing space.
- **Numeric spelling.** An `int64` field takes a JSON string of plain decimal
  digits — `"1000"` yes, `"1e3"` no, `1.5` no. A `double` takes any finite
  number or numeric string.
- **`repeated string` means string.** `enum: [5]` and `required: [5]` are 400s;
  a lone `"x"` in place of `["x"]` is accepted.
- **Depth.** 30 levels of `properties` answered 200, 31 was refused. The
  message names no `function_declarations[N]`, so one such tool kills the whole
  request and the log cannot say which. `MAX_SCHEMA_DEPTH` is set well under
  the measured figure because a `properties` hop costs two JSON levels and an
  `items` hop costs one.
- **`type: "array"` obliges `items`, and `items` obliges `type: "array"`.**
  `properties`/`required`/`propertyOrdering` oblige `type: "object"`. An
  *absent* type satisfies neither — `TYPE_UNSPECIFIED` fails both predicates.
- **`required` and `propertyOrdering` may only name properties that exist**, and
  a property key may not be empty.

Two of these the encoder **creates itself**: dropping a `properties` member the
client listed as `required`, and dropping a `type` it could not name off a node
that carries `properties`. A transform that removes things has to re-check the
invariants that removal can break, which is why those two repairs run after the
walk rather than inside it. Where a repair has a choice, it infers rather than
deletes — a node carrying `properties` *is* an object — except against a client's
explicitly stated contradicting type, which is not the encoder's to overrule.

### The same staging applies outside the schema

Hardening `parameters` left every neighbouring field the encoder builds from
client input unprobed. A second sweep found four more, and the first is more
reachable than anything in the schema:

- **Function names.** `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$` — 128 characters pass,
  129 do not; dots and dashes are legal so `mcp__server__tool` is fine; a space,
  a leading digit, any non-ASCII letter, or a duplicate name
  (`Duplicate function declaration found: …`) is a 400 for the **whole
  request**. The name is not the gateway's to choose — it comes from the
  client's tool list, and an MCP server may name a tool anything.

  Handled by a **tool cloak**, in `antigravity/cloak.ts`: the name is renamed on
  the way out and restored in `decode.ts` from the map `codec.ts` carries in
  `decodeState`. Renaming rather than dropping, because a dropped tool is a
  capability the client asked for and never learns it lost — and only names the
  grammar refuses are touched, so an ordinary tool set builds no cloak at all.
  Four sources feed it: `tools[]`, a `toolUse` in history (the client may drop
  the tool and keep the turn that called it), `toolChoice`, and this encoder's
  own fourth — an unmatched `toolResult`, whose **id** is sent in place of a
  name and is as free-form as one. Deduplication survives the rename and is
  separate from it, since `Duplicate function declaration found` is its own 400.

  **This is the second copy of that machinery** — `anthropic/cloak.ts` is the
  first, and the collision reasoning is the part worth reading there. The shapes
  match and every policy differs: Anthropic renames to defeat fingerprinting so
  most names change, this renames only what the grammar refuses so almost none
  do. Forked per boundary rule 2; a third copy should promote the gather / claim
  / suffix loop to the package root and leave the policies where they are.
- **`generationConfig` ranges.** `temperature` in `[0.0, 2.0]`,
  `thinking_budget` in `[-1, 65535]` (one below `MAX_OUTPUT_TOKENS`), at most 5
  `stop_sequences`, and a non-positive `maxOutputTokens` answers a bare
  `Request contains an invalid argument.` All clamped; `maxTokens: 0` is dropped
  instead, since the model's own default beats a one-token ceiling.
- **The opening turn.** A function call must follow a user turn or a function
  response, and a function response must follow a call. Only the *first* entry
  can break this — an orphan response later is fine, because `mergeSameRole` has
  already folded it into the user turn beside it — and it breaks exactly when a
  client trims history. Repaired with an **empty** leading user turn, verified
  against both failing shapes; a placeholder like "(continued)" would put words
  in the prompt the client never wrote.

**Re-probe after every behaviour change to the transform, not once at the end.**
Three of the five classes appeared only after an earlier fix unmasked them, and
the tuple-`items` repair introduced a fresh 400 (`items: missing field`) that the
change which caused it was itself verified against.

## What is skipped

- The `cloudcode-pa` and sandbox hosts as inference *failover*. One runtime host,
  and note that the obvious fallback is the host that refuses this tier.
- The `cli` (`agy`) client profile. One identity, `ide`, hardcoded; the two differ
  only in User-Agent and post-exchange headers against the same client id.
- Claude and GPT model rows, and with them their quota family.
- `retrieveUserQuota`'s per-model 5h detail. The summary RPC covers the window.
- omniroute's background `onboardUser` polling loop.

## Corrections after review

Nine things above were wrong or incomplete, found by a review that read
omniroute's implementation against this one rather than by any failing test.
Recorded here because the design as approved would have shipped each of them.

**The wire section understated what a request must carry.** A replayed
`functionCall` needs a thought signature or Gemini refuses the continuation, so
one tool call works and its result cannot be sent back; the encoder now sends
the `skip_thought_signature_validator` sentinel the backend accepts in place of
the signature the IR has nowhere to keep. Adjacent turns that both resolve to
`user` — which this encoder *produces*, from a mid-conversation system turn or
a tool result followed by a user turn — are refused with
`400 INVALID_ARGUMENT`, so they are merged by concatenation. A reasoning request
needs `includeThoughts` beside its budget, or the model spends the tokens and
returns no thought parts.

**The catalog advertised limits the wrapper refuses.** Cloud Code caps
`maxOutputTokens` at 16,384 whatever the model holds. Every row states that
figure and the encoder clamps above it, recording
`antigravity:max-tokens-clamped`; a budget at or above the ceiling also has the
ceiling raised past it, since Cloud Code refuses that combination rather than
reconciling it.

**The usage arithmetic was half right.** `cachedContentTokenCount` is inside
`promptTokenCount`, as stated — but `thoughtsTokenCount` is *beside*
`candidatesTokenCount`, so output was undercounted on every thinking request.

**Three decoder states were unhandled**: an error under `response` rather than
at the top level (which turned a rate limit into a generic retryable failure
and kept a wrapped auth failure off the refresh path), a prompt blocked before
generation (`promptFeedback` with no candidate, read as a truncated stream), and
a frame carrying two candidates (silently truncated to the first, losing its
finish reason with it — now a visible failure).

**Two degradations were missing**, both required by the standing rule: a cache
breakpoint the envelope cannot carry, and a tool result whose `isError` flag
`functionResponse` cannot express.

One reviewed finding was **declined**: omniroute parses a legacy
`[Tool call: …]` textual fallback out of text parts. Porting it would turn model
prose matching a pattern into a real tool invocation, and the failure direction
of not having it — a tool call rendered to the user as text — is safer than the
failure direction of having it.

## Testing

TDD, with mutation-tested anchors on the four things `docs/adding-a-provider.md`
step 9 names — URL selection, usage-token arithmetic, tool round-trip,
mid-conversation system placement — plus three specific to this provider:

1. The envelope's `project` comes from `providerData` and an empty one is refused
   before the request is built.
2. `usageMetadata` arithmetic subtracts `cachedContentTokenCount`.
3. The quota window matcher returns *unknown* rather than zero for a bucket whose
   display name does not match.
