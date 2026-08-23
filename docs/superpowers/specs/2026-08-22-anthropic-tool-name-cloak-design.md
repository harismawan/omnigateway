# Anthropic tool-name cloak

Status: implemented on `feat/anthropic-tool-name-cloak`.
Date: 2026-08-22.

Implemented as designed, with one seam the design did not name. The `cloakedTools` count has to
reach `LogFields`, and the adapter holds no logger — so `AdapterResult` carries the number out and
dispatch emits it beside the degradation it already collects, in the shape
`routing candidate excluded` set. The count and never the names, for the reason the design gives.

## The problem, measured

Anthropic's first-party Messages API refuses some requests carrying a Claude subscription OAuth
credential with HTTP 400 and this body:

```json
{"type":"error","error":{"type":"invalid_request_error",
 "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}
```

The message is wrong. Nothing about the account is exhausted. The refusal is a fingerprint check on
the **names of the tools in the request**, and the billing text is the placeholder it is surfaced
through.

This was established empirically against the live gateway on 2026-08-22, replaying a captured hermes
payload (22 custom tools, streaming, `max_tokens: 128000`, 7.5KB system prompt):

- Removing `tools` — request succeeds. Everything else held constant.
- Each of the 22 tools alone — all 22 succeed.
- `delegate_task` + `session_search` — refused. Reduced to stubs (`"description": "x"`,
  `input_schema` of one string property) — still refused. So the trigger is the **name**, not the
  schema, the description, the payload size, or the token count.
- `delegate_taskX` + `session_search`, `delegate_task` + `session_searchX`,
  `DELEGATE_TASK` + `SESSION_SEARCH`, `delegate_task` + `foo_bar` — all succeed. Exact match,
  case-sensitive.
- Order-independent: swapping the two still fails.
- Full 231-pair sweep of the 22 names found exactly two failing pairs:
  `delegate_task`+`session_search` and `clarify`+`session_search`.
- Delta-minimisation over the remaining names found a third, higher-order signature:
  `skill_manage` + `skill_view` + `skills_list`. Removing any one member clears it.
- Ruled out by probe, all returning 200 on the same credential: `max_tokens` 32k/64k/128k, thinking
  enabled, 187k-token input, 24 fat tools in a 486KB body, `anthropic-beta: context-1m-2025-08-07`,
  `interleaved-thinking-2025-05-14`, streaming, and the stale `cc_version` in the billing system
  block.
- Concurrent traffic on the same credential succeeded throughout, and `quota_windows` read 30/100
  (5h) and 47/100 (weekly) at the time. The account was not out of anything.

OmniRoute reached the same conclusion independently. From
`open-sse/services/claudeCodeToolRemapper.ts:180-197`:

> Anthropic fingerprints third-party agent harnesses by their tool NAMES on the first-party Messages
> API (native Claude OAuth). Two failure modes, both surfaced as a misleading `400 out of extra
> usage` placeholder (the SSE stream is refused, not a real billing event):
> 1. Specific blacklisted names (e.g. `mixture_of_agents`) are refused even in isolation.
> 2. A large enough SET of recognizable snake_case agent tool names is refused collectively, even
>    though each name passes on its own.

Our measured sets are smaller than "large enough" implies — two and three names — so the collective
threshold is lower than that comment suggests. Treat the signature set as unknown and unstable: it
is Anthropic-side, undocumented, and can change without notice. This design therefore does not
enumerate bad names. It renames every custom tool into a shape the fingerprint does not match.

## Decision

Rename client-supplied tool names to PascalCase on the outbound Anthropic OAuth leg, and restore the
original names on the way back, entirely inside the Anthropic adapter. Everything outside the
adapter — the client, RTK, the router, token counting, both egress surfaces — continues to see the
names the client sent.

Decisions taken during design, with the alternatives rejected:

| Decision | Chosen | Rejected because |
| --- | --- | --- |
| Gate | Anthropic OAuth credentials only | API-key traffic hits a surface that does not fingerprint; mutating it would change bodies for no reason |
| Alias style | Mechanical PascalCase, no canonical map | Mapping `patch`→`Edit` asserts a semantic equivalence that may be false and misleads the model; opaque hashes strip meaning the model needs to choose tools |
| Collisions | Every member of a colliding group takes a hash suffix | Position-ordered `Name2`/`Name3` makes a tool's alias depend on array order |
| Residual 400 | New `FINGERPRINT_REFUSED` code; client response unchanged | Passing through unnamed loses the diagnosis; rewriting the body would break the rule that client errors mirror upstream |
| Record | Degradation entry plus a numeric log field | Silence leaves a misbehaving cloak with no signal at all |
| Scope | Tool names only | Schema sanitising and system-prompt scrubbing address triggers not observed on this gateway |

## Where the names cross the boundary

Established by reading the current code; line numbers are as of this commit and will drift.

Request side, `packages/providers/src/anthropic/wire.ts`:

- `wire.ts:83` — history `tool_use` blocks, in `encodeBlock`.
- `wire.ts:155` — custom tool definitions, in `encodeTool`.
- `wire.ts:172` — `tool_choice` of `{type: "tool", name}`, in `encodeToolChoice`.

Response side, `packages/providers/src/anthropic/decode.ts`:

- `decode.ts:161` — `content_block_start` for `type: "tool_use"`. This is the **only** site in the
  streaming decoder that carries a client tool name. The adapter always streams (`index.ts:37`
  forces `stream: true`), so there is no separate non-streaming decode path; a non-streaming client
  request is folded by `collect()` in the IR. Restoring here makes all six downstream readers
  correct for free: `packages/ir/src/stream.ts:177` and `:243`,
  `apps/gateway/src/egress/anthropic.ts:103` and `:195`, `apps/gateway/src/egress/openai.ts:110`
  and `:184`.

Sites that must **not** be touched:

- `wire.ts:149` — `AnthropicToolDef` names. Fixed by Anthropic, validated against a table at
  `apps/gateway/src/ingress/anthropicTools.ts:106-110`. Renaming one breaks both ingress
  re-validation and upstream.
- `wire.ts:97` and `decode.ts:170` — `anthropicNative` block `data`. `mcp_tool_use` and
  `server_tool_use` carry a name *inside* the opaque payload; those are Anthropic's own tool names,
  not the client's, and the payload is contractually verbatim.

Hard ordering constraint: `signAnthropicBody` (`packages/providers/src/body.ts:217-221`) hashes the
finished bytes and substitutes a length-preserving `cch` token. The rename must therefore happen
before the `JSON.stringify` at `packages/providers/src/anthropic/index.ts:86`. Mutating the
serialized string afterwards invalidates the signature.

## Design

### The cloak module

New file `packages/providers/src/anthropic/cloak.ts`. Pure: no I/O, no clock, no randomness, in the
style of `ir` and `router`.

```ts
export type ToolCloak = { toWire: Map<string, string>; fromWire: Map<string, string> };

export function buildToolCloak(request: ChatRequest): ToolCloak | null;
export function cloakName(cloak: ToolCloak | null, name: string): string;
export function uncloakName(cloak: ToolCloak | null, name: string): string;
```

`buildToolCloak` takes the whole request rather than `tools` alone, because a name can reach the
wire from two places: a `CustomToolDef` in `tools[]`, and a `toolUse` block in message history. It
scans both, so the map is complete before serialization begins and `cloakName` stays a pure lookup
with an identity fallback. Building from `tools[]` alone would have left a history `tool_use` whose
tool has since been dropped going out under its original name — the exact shape the cloak exists to
prevent, arriving through the door nobody was watching.

It returns `null` when neither source contributes a name that needs renaming, so the non-OAuth and
no-tools paths allocate nothing and the call sites read as a no-op. `cloakName` and `uncloakName`
are identity functions on a `null` cloak and on any name absent from the map.

### Alias derivation

Split the original name on every run of non-alphanumeric characters, capitalise each segment, join:

```
session_search  -> SessionSearch
web-extract     -> WebExtract
delegate_task   -> DelegateTask
```

Two names pass through unchanged and get no map entry:

- Anything already matching `^[A-Z][A-Za-z0-9]*$`. It is already in the target shape.
- Anything starting with `mcp__`. The prefix carries MCP routing semantics that a rename would
  destroy.

A name with no alphanumeric characters at all becomes `Tool` plus its hash suffix.

Every alias satisfies Anthropic's `^[a-zA-Z0-9_-]{1,128}$` by construction. Names longer than 128
characters after transformation are truncated to 124 and given a hash suffix, which also makes them
collision-safe.

### Collisions

Two names can derive the same alias (`read_file` and `readFile` both give `ReadFile`), and an alias
can collide with an `AnthropicToolDef` name present in the same request (a custom `bash` alongside a
real `bash_20250124`).

There is a third case this design originally missed, found in review and fixed before merge: an
alias can collide with an **exempt** client name. `ReadFile` passes through unrenamed, so if the
client also sends `read_file`, both reach the wire as `ReadFile` — a duplicate Anthropic rejects,
and, in the branch where it does not, a restore that hands the client the other tool's name. This is
ordinary traffic, not a corner: PascalCase built-ins beside snake_case customs is the shape of the
harnesses this cloak exists for. The rule that fixes it is the general one the other two cases were
already instances of: **every name that reaches the wire unrenamed claims its spelling**, whether it
is Anthropic's or merely exempt.

Resolution is two-pass and position-independent. Derive every candidate alias first, including the
reserved set of Anthropic-defined names in this request. Then, for any alias claimed more than once,
**every** member of the group takes a suffix — nobody keeps the bare name:

```
read_file -> ReadFileA3f9
readFile  -> ReadFile7b21
```

The suffix is four lowercase hex characters of the xxHash64 of the *original* name, capitalised,
using the same primitive `body.ts:205` already uses for `cch`. Because it derives from the source
name rather than from array position, a tool's alias is stable no matter how the client reorders
`tools[]`. Suffixing all members rather than the later ones removes any dependence on iteration
order, which is what makes the scheme genuinely position-independent rather than merely
deterministic.

### Integration

`send()` in `packages/providers/src/anthropic/index.ts` derives the cloak once, gated on the OAuth
signal that already exists at `index.ts:20` (`req.credentials.accessToken !== null`), and threads it
into both directions:

```ts
const cloak = oauth ? buildToolCloak(req.request) : null;
// toWire(req.request, model, { oauth, cloak })   -> wire.ts:83, :155, :172
// decodeAnthropic(stream, { cloak })             -> decode.ts:161
```

The cloak lives in the `send()` call frame and nowhere else. It is never attached to
`dispatchRequest`.

That last point is the load-bearing one. `dispatchRequest` is a single shared IR object across every
attempt (`apps/gateway/src/dispatch/index.ts:86`), and `adapter.send` rebuilds the whole wire body
from it on each call (`wire.ts:297`, then `JSON.stringify` at `index.ts:86`). So a cloak derived
inside `send()` is idempotent by construction: failover, the AUTH-refresh inner retry, and a second
Anthropic credential each re-derive it from pristine IR. A cloak that mutated `dispatchRequest` in
place would instead persist across failover and leak aliases into a non-Anthropic second candidate —
the OpenAI, Kimi, Grok and Kilo encoders all read the same `.name` field — and would corrupt RTK's
shell/non-shell classification (`packages/rtk/src/index.ts:84-87`) and the `count_tokens` estimate,
both of which key on the real names.

### History names not in `tools[]`

A `tool_use` block can name a tool the client has since dropped from `tools[]`. Because
`buildToolCloak` scans message history as well, such a name is already in the map and takes part in
collision detection like any other — a history-only name colliding with a live tool's alias makes
both take a hash suffix. Only the live tool's alias can come back in a response, so the extra
entries cost one map insert and nothing else.

## Error classification

Add `FINGERPRINT_REFUSED` to the `ErrorCode` union at `packages/ir/src/errors.ts:14-30`.

The union is closed deliberately: consumers key exhaustive `Record<ErrorCode, …>` tables off it, so
the compiler enumerates every site that must decide something — `RETRYABLE`, the HTTP-status map,
the breaker penalty table, and both error renderers. Values:

- `RETRYABLE: false`. The same body is refused identically by every candidate, so failover would
  walk the whole pool to prove it. This is the reasoning already written for `BAD_REQUEST` at
  `errors.ts:36-38`.
- HTTP status 400, with the upstream message forwarded verbatim. The client sees exactly what it
  sees today. Only the gateway's own record improves.

Detection lives in `packages/providers/src/anthropic/decode.ts`. `ERROR_TYPE` (`decode.ts:47-54`)
currently maps by `type` alone, `invalid_request_error → BAD_REQUEST`. The refusal needs the message
too, so a narrow check runs ahead of the table: type is `invalid_request_error` **and** the message
matches `/out of extra usage|draw from extra usage/i`. Both phrasings, because OmniRoute records a
second variant of the same refusal (`Third-party apps now draw from extra usage, not plan limits.`,
`open-sse/services/systemTransforms.ts:155`).

**A genuine extra-usage exhaustion produces the same message and will be classified the same way.**
There is no way to distinguish them from the response — the text is identical. The consequence is
that a real exhaustion is not retried against another credential, where `QUOTA_EXHAUSTED` would
have been — **and it also forfeits that code's one-hour credential park**, since
`PENALTY.FINGERPRINT_REFUSED` is `"none"` where `PENALTY.QUOTA_EXHAUSTED` is `"soft"`. A genuinely
exhausted credential therefore keeps serving 400s and stays green in credential health rather than
yielding to a working one. No budget is burned — the request is refused before generation — but the
cost is larger than "one lost retry".

That is still the better trade: `"soft"` would park a healthy credential for an hour on every
fingerprint refusal, which is the case actually observed. An operator seeing repeated
`FINGERPRINT_REFUSED` on a credential should check `quota_windows` before assuming the cause.
Revisit this if genuine exhaustion is ever observed in the wild.

Detection is split across two predicates rather than one, because the two routes know different
things. The SSE route has the upstream `type` and checks it — load-bearing, since a `rate_limit_error`
carrying the same wording is a real limit and must stay retryable. The HTTP route has no type at all:
`httpError` reduces the body to a code and a message before this code sees it, so that caller pairs
the message test with `res.status === 400`. An earlier draft passed a hardcoded
`"invalid_request_error"` there, which read as a shared check while testing half of one.

`request_logs.error_code` is a text column, so a new value is additive. No migration; existing rows
are unaffected.

## Record

**Degradation.** `anthropic:tool-names-cloaked`, appended through the existing `note()` helper in
`toWire` (`wire.ts:273-277`, which dedupes), landing in `request_logs.degradations` beside
precedents like `anthropic:oauth-system-prefix`. The comment at `wire.ts:274` says a degradation
names something the request lost; the request does lose the client's chosen tool names on the
upstream leg, so the entry reads honestly rather than as a warning about nothing.

**The refusal path.** A `FINGERPRINT_REFUSED` is thrown, and both records above ride on
`AdapterResult`, which a throw never produces — so the one failure this record exists to explain was
the one failure that recorded nothing. `GatewayError` therefore carries a `degradations` array,
passed by the fingerprint throw and drained into `log.degradations` by dispatch. The seam is generic
because `degradations` already is: it exists on `AdapterResult`, `AttemptResult` and `RequestLog`,
and nothing about the new field names a provider. Exactly one throw site populates it today; every
other adapter still discards its degradations on failure, which is a scoped choice rather than an
oversight, and the field's own comment says so.

Dispatch dedupes on collection, at both sites. `note()` inside a single `toWire` cannot see across
attempts, so without it a two-attempt failover records the same entry twice — which it already did
for `anthropic:oauth-system-prefix` before this change.

**Log field.** `cloakedTools?: number` added to `LogFields` (`packages/ir/src/logger.ts:22`),
emitted once per cloaked request. A count, never the names: tool names are client-supplied free
text, and `LogFields` is the redaction boundary. The field's comment must say so explicitly, in the
manner of the existing `plugin` and `snapshotId` comments, so a later reader does not widen it to
carry the names themselves.

## Testing

New `packages/providers/test/anthropicCloak.test.ts`:

- alias derivation across separator styles;
- PascalCase names pass through with no map entry;
- `mcp__*` skipped;
- collision suffixes assigned to every group member and stable under array reordering;
- `AnthropicToolDef` names untouched;
- history `tool_use` and `tool_choice` renamed consistently with `tools[]`;
- a history `tool_use` naming a tool absent from `tools[]` is still renamed;
- `anthropicNative` block `data` byte-identical before and after;
- a fixture holding the three measured signatures — `delegate_task`+`session_search`,
  `clarify`+`session_search`, `skill_manage`+`skill_view`+`skills_list` — asserting none of those
  names reaches the wire body.

Extensions to existing suites:

- `packages/providers/test/anthropic.test.ts` — cloak present on the OAuth path, absent on the
  API-key path.
- `apps/gateway/test/egress/roundtrip.test.ts` — the client sees original names on both the
  Anthropic and OpenAI surfaces.
- `apps/gateway/test/dispatch/dispatch.test.ts` — a cross-provider failover sends original names to
  the second provider.

### Mutation checks

A green suite would otherwise hide the failure mode that matters: a cloak that renames but never
restores. Each mutation below must turn the suite red.

| Mutation | Must fail |
| --- | --- |
| Delete the `uncloakName` call at `decode.ts:161` | roundtrip tests, both surfaces |
| Make `aliasFor` the identity function | wire assertion that no `snake_case` name reaches the body |
| Drop collision suffixing | duplicate-alias test |
| Build the cloak from `tools[]` alone | history-only `tool_use` rename test |
| Apply the cloak on the API-key path too | API-key passthrough test |
| Cloak `AnthropicToolDef` names | `anthropicNativeWire.test.ts` |
| Restore at egress instead of at decode | RTK-sees-original-names test |

Any mutation that leaves the suite green means that test is decorative; rewrite it rather than
recording the result.

## Out of scope

- **Tool `input_schema` sanitising.** OmniRoute repairs malformed schemas
  (`open-sse/translator/helpers/schemaCoercion.ts:302-391`) and attributes the same 400 to them, but
  its sanitiser exists largely to undo its own truncation placeholders. This gateway does not
  truncate schemas on the outbound path, and no schema-triggered refusal has been observed here.
- **System-prompt scrubbing for third-party markers.** OmniRoute drops paragraphs naming other
  harnesses (`open-sse/services/systemTransforms.ts:159-191`). It silently edits the caller's prompt,
  changing model behaviour in ways the caller cannot see. Not justified by anything measured here.
- **Any change to what the client receives.** The cloak is invisible end to end.

## Risks

- **The signature set is Anthropic-side and can change.** A future check on descriptions, schema
  shape, or system-prompt content would not be caught by a name cloak. The mitigation is the
  `FINGERPRINT_REFUSED` classification: the next occurrence is named and greppable instead of
  costing another investigation.
- **Aliases change what the model reads.** PascalCase preserves the words, so the degradation in
  tool selection should be nil to slight, but it is not zero-risk. This is why no canonical mapping
  is applied: renaming `patch` to `Edit` would assert an equivalence that may not hold.
- **A collision bug surfaces as a client seeing a tool name it never sent.** The mutation checks
  target exactly this, and the `cloakedTools` count gives an operator something to correlate against.

## References

- Investigation transcript and probe results: this repository's session log for 2026-08-22.
- OmniRoute 3.8.48, `open-sse/services/claudeCodeToolRemapper.ts:180-214` (rationale and canonical
  map), `open-sse/executors/base.ts:794-822` (the six-pass tool pipeline).
