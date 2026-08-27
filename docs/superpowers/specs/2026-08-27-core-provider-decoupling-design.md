# Core/provider decoupling

Removing provider-specific behaviour from `ir`, `router`, `store`, `control`,
`ratelimit` and `rtk` by making IR values carry their own provenance.

This design also specified a closed set of named extension points for whatever
that could not reach. On implementation there was nothing left for them to do —
see Outcome 3. No hook was built.

Sub-project 1b. Depends on
[the provider descriptor registry](2026-08-26-provider-descriptor-registry-design.md),
which moves per-provider *data* out of core and supplies the registry this design
uses as its carrier.

## Problem

Sub-project 1 moves per-provider tables into descriptors. It does not touch the
places where core packages contain provider-specific *logic*: a branch on a
provider id, a literal vendor delta-type inside stream folding, a health policy
written for one vendor's refusal. Those are what make a provider unmovable, and
they sit in the two packages that are supposed to be the most provider-neutral
in the repository.

The load-bearing example is the pure router:

```ts
// packages/router/src/filters.ts:20-23
export function needsAnthropicNative(request: ChatRequest): boolean {
  if (request.tools?.some((t) => t.provider === "anthropic") === true) return true;
  return request.messages.some((m) => m.content.some((b) => b.type === "anthropicNative"));
}
```

Read at `filters.ts:49,59-64` against `ANTHROPIC_NATIVE_TOOLS[target.provider]`,
a per-provider truth table in `packages/ir/src/capabilities.ts:23`. A vendor name
decides routing, inside the package whose entire contract is that it does not
know about providers.

## Direction

Core cannot scan providers: `packages/providers` imports `@omni/ir`, so the
reverse import is a cycle, and boundary rules 1 and 3 forbid it independently.
Everything here is therefore **injection** — providers register into the
descriptor registry, and core receives it as a parameter, exactly as the router
already receives its snapshot.

Each provider-specific core site gets one of three outcomes, in this order of
preference:

1. **Descriptor data.** Sub-project 1's job; nothing to do here.
2. **Make the value self-describing, and the branch deletes.** Preferred wherever
   possible: a deleted branch cannot drift, and needs no contract, no
   registration and no test of its own.
3. **A named extension point.** A closed, enumerated set. Adding one is a
   deliberate core change with a name and a doc comment.

Outcome 2 was expected to be most of this design and Outcome 3 deliberately
small. It turned out to be all of it: every site the third outcome was drafted
for had an answer in the second, or an argument for staying in core. The
preference order is the part that earned its place.

## Outcome 2: values that carry their own provenance

### `anthropicNative` → `providerNative`

`AnthropicNativeBlock` (`packages/ir/src/request.ts:70-83`) is already a generic
escape hatch wearing one vendor's name: `{ type, blockType, data }`, payload
opaque, excluded by contract from tool-id correlation, orphan removal,
cross-provider translation and RTK. Nothing about it is Anthropic-shaped except
the name and the fact that only Anthropic currently produces one.

Add the producing provider to the value:

```ts
export type ProviderNativeBlock = {
  type: "providerNative";
  provider: ProviderId;   // the adapter that produced it
  blockType: string;
  data: unknown;
};
```

The routing rule then reads off the data rather than off a table:

```ts
// a native block or provider-defined tool routes only to the provider that owns it
function requiredProvider(request: ChatRequest): ProviderId | undefined
```

**This deletes three things**: `needsAnthropicNative()`, the
`ANTHROPIC_NATIVE_TOOLS` table (`ir/capabilities.ts:23`), and the
`!ANTHROPIC_NATIVE_TOOLS[target.provider]` read at `filters.ts:59-64`.

Behaviour is preserved exactly. `ANTHROPIC_NATIVE_TOOLS` is `true` for
`anthropic` and `false` for all five others, so "exclude every provider whose
entry is false" and "admit only the producing provider" select the same targets
for every request expressible today.

The same rename applies to the two delta variants (`ir/stream.ts:110-111`), the
`ContentBlockStart` arm (`:98`), the `Accum` arm (`:143-149`) and the
`collect()` cases (`:180-186`, `:203-210`, `:236-241`), `ANTHROPIC_NATIVE_BLOCK_TYPES` was to become descriptor data — the set of block
types *that provider* treats as native — and did **not**. It stays in
`packages/providers/src/anthropic/tools.ts`, read by the Anthropic ingress. It is
a provider's own vocabulary held inside that provider's directory, which is where
this design wants provider knowledge to live; moving it onto the descriptor would
only matter once a second provider produced native blocks. Left for whoever adds
one.

### `ToolDef.provider` — and a footgun to fix while we are here

The rule covers tools as well as blocks: `filters.ts:21` tests
`t.provider === "anthropic"`. So `ToolDef` generalizes too
(`ir/request.ts:139-174`).

It carries an existing trap. `CustomToolDef.provider` is the literal `"custom"`
— **the same string as the `custom` provider id, meaning something entirely
different**. `apps/gateway/src/ingress/openai.ts:285` and
`packages/control/src/dryRun.ts:59` both write `provider: "custom"` as the
tool-kind discriminant, not as a provider. A grep for the custom provider finds
both and is wrong about both.

Generalizing `AnthropicToolDef.provider` to a `ProviderId` would make the
collision real rather than merely confusing: `{ provider: "custom" }` would be
ambiguous between "a portable tool" and "a tool defined by the custom provider".
So the discriminant is renamed as part of this change:

```ts
type PortableToolDef        = { kind: "portable"; … };   // was provider: "custom"
type ProviderDefinedToolDef = { kind: "provider"; provider: ProviderId; … };
```

`AnthropicToolFamily` and its eleven members stay in `packages/ir` for now — the
versioned `type` strings are an Anthropic contract with its own rules
(`packages/providers/src/anthropic/tools.ts`, unknown dated types rejected rather
than prefix-matched), and generalizing them is a separate question from
generalizing the discriminant.

### `tokens.ts:85`

`toolTokens()` branches on `tool.provider === "anthropic"` to size a
provider-defined tool differently from a portable one. Under the rename this
becomes a test on `kind`, which is what it always meant.

### `Excluded.reason` becomes structured

`apps/gateway/src/dispatch/index.ts:260` string-matches the router's reason:

```ts
const capabilityOnly = e.reason === "capability:anthropicTools";
```

The `capabilityOnly` branch redacts `credentialId` from the degradation, and its
reasoning is sound and survives: a capability exclusion is a fact about the
target's provider, not about the account, so naming an account there would blame
one that is fine. What does not survive is discovering that by comparing a
string. `Excluded` gains a discriminator and dispatch tests it instead.

Its values shipped as `"target" | "account"`, not `"capability" | "credential"`
as first drafted. Three exclusions whose `reason` begins `capability:` —
`tools`, `images`, `reasoning` — are facts about the account, and the shipped
string match did not cover them. Naming the discriminator after the reason string
would therefore have described the opposite of what it does. It answers "is this
about the target or about the account", which is the only question the redaction
asks.

**The emitted string still changes**, because the concept is renamed:
`excluded:capability:anthropicTools` becomes
`excluded:capability:providerNative`.

That string is persisted in `request_logs.degradations`, which makes it a storage
contract in the same class as `RTK_FILTER_IDS`. The decision is: **rename, do not
migrate.** Degradations are a forensic set rendered for operators, not parsed on
read the way `isRtkFilterId` parses filter ids, so old rows stay readable and
nothing drops. Rows written before this release carry the old spelling; rows
after carry the new one; both are documented in `CLAUDE.md`'s client-contract rules, and the old spelling
ages out with retention. (`ARCHITECTURE.md` was named first and has no
degradations section to carry it.) A migration was considered and rejected: it
would rewrite a table that is very large on a busy install, synchronously,
for cosmetics.

## Outcome 3: the closed extension-point set — which turned out to be empty

**This section specified four named hooks and said the list should stay four. On
implementation all four dissolved, and none was built.** The section is kept
rather than deleted because the reasoning is the useful part: each hook was a
real provider-specific core site, and each turned out to have a better answer
than an extension point.

The four, and what happened to each:

**`cacheEligible(block)` — unnecessary.** It was to replace the thinking-block
exclusion in `cacheControlOf` (`ir/request.ts:90-95`), on the grounds that
"Anthropic rejects a marker on a thinking block" is Anthropic's rule. But
`ThinkingBlock` is `{ type: "thinking"; text: string; signature?: string }` — it
has no `cacheControl` field at all. The exclusion is type narrowing, and the
absence is a property of the type exactly as that function's comment already
said. Reading the comment as describing a rule rather than a shape is what put
this on the list.

**`foldNativeDelta(...)` — became data, not a hook.** `collect()` switched on
`citations_delta` and `compaction_delta`, two Anthropic wire strings inside
`packages/ir`. A hook would have needed injecting into `collect()`, which `ir`
cannot do — `packages/providers` imports `ir`, so `ir` cannot read the registry.
The decoder is the only thing that knows what its own delta names mean, so it
states the operation instead: `fold?: "merge" | "citation"` on the native delta,
performed by core, absent meaning "carry verbatim". The wire names now appear
only in `packages/providers/src/anthropic/decode.ts`.

This is outcome 2 again, and the pattern is worth naming: **a hook that has to be
injected into a pure package is usually a value that should have been on the
data.** The injection cost is what exposes it.

**`breakerPenalty(code)` — the wrong shape.** `router/breaker.ts`'s table is keyed
by `ErrorCode`, not by provider, and `ErrorCode` is core vocabulary this design
deliberately keeps core. The entry looks Anthropic-specific only because
Anthropic is the sole raiser of `FINGERPRINT_REFUSED` today. A hook here would
let a provider set the health policy for a shared failure code — a real
capability, with the obvious downside, and no current need. Vocabulary that stays
core keeps its policy in core.

**`servesTarget(...)` — became one word.** The rule was
`target.provider === "custom" && account.providerData.endpointId !== target.endpointId`.
It is now "a target naming an endpoint is served only by an account at that
endpoint", which is equivalent for every validly-saved target — the control
schema requires `endpointId` on the custom arm and offers it on no other — and it
removes the last provider name from `packages/store`. No hook, no second caller,
and the invariant this design was most worried about is untouched.

Two things that change surfaced, both now pinned:

- It is **stricter on data the schema never saw**. `sqlite/config.ts` reads
  targets back with `JSON.parse` and no validation, so a restored or hand-edited
  database can carry an `endpointId` on a non-custom target. That used to be
  ignored and now fails closed.
- The first version read `""` as an endpoint to match, which **broke the
  console's pin picker for every non-custom target**. `TargetDraft.endpointId` is
  a non-optional string holding `""` for none, and the control schema refuses
  `""` on the way in for the same reason: it is an id nothing matches, not a
  third state. Three dashboard tests caught it; the store's own tests did not,
  because none of them spelled "none" that way. This is precisely the failure
  mode CLAUDE.md records for this function — callers asking the question
  differently from the single copy — reproduced while generalising it.

### What this means for the next such design

The instinct to specify an extension surface up front was wrong here in every
case, and the corrective is cheap: **for each proposed hook, try to write the
value that would make it unnecessary first.** Three of the four had one. The
fourth had a reason not to exist at all.

`LogFields` still never becomes extensible, and redaction rules still never do —
those were never hooks in this design and are stated in CLAUDE.md rule 16.

## What stays in core, deliberately

`ErrorCode` (including `FINGERPRINT_REFUSED`), `LogFields`, `StopReason`,
`CacheControl.ttl`, `AuthType`, `WindowType`, the `surface` union, and
`AnthropicToolFamily`. Each is a closed set a provider might one day need a new
member of; each is a tier-2 core edit by design, and each is decided when the
published contract is designed rather than here. This design removes
provider-specific *logic* from core, not provider-shaped *vocabulary*.

## Testing

- **Routing equivalence is the central pin.** For every combination of
  (request with native block / provider-defined tool / neither) × (six
  providers), the target set selected by the new rule equals the set selected by
  `ANTHROPIC_NATIVE_TOOLS` today. Written before the table is deleted, against a
  checked-in copy of it.
- **The `fold` generalisation is tested with a provider that does not use it.**
  A `kimi` delta, spelled nothing like Anthropic's, gets both `merge` and
  `citation` behaviour, and a delta stating no fold is carried verbatim. Testing
  it only with Anthropic's own deltas would pass equally against a rename.
- **`servesTarget` is pinned on both the stricter case and the `""` case.** The
  first is the deliberate behaviour change on unvalidated data; the second is the
  regression that broke the console's pin picker and that the store's own tests
  missed, because none of them spelled "none" the way its callers do.
- **The `kind: "portable"` rename gets a collision test**: a tool defined by the
  `custom` *provider* and a portable tool are distinguishable, which they are not
  today.
- **Degradation spelling** is pinned where it is written — `dispatch.test.ts`
  asserts the new string is emitted. It is deliberately **not** pinned on the
  read side: nothing in the repository parses `degradations`, the console renders
  each entry as a raw chip with no lookup, so a console fixture carrying the old
  spelling would assert that a string renders as itself. An earlier draft of this
  section claimed such a fixture exists; it does not, and should not.
- **Mutation-test the equivalence pins.** Change one descriptor's native block
  types and confirm the routing pin fails. An equivalence test that reads through
  the registry on both sides asserts nothing.

## Risks

- **The rename touches ~20 sites across five packages** — `ir` (request, stream,
  tokens), `router` (filters), `gateway` (dispatch, ingress, egress), and the RTK
  fall-through test. It is mechanical but wide, and a partial application
  typechecks in places because `blockType` is a free string.
- **RTK is safe by structure, not by intent.** It preserves unknown block types
  by fall-through (`rtk/src/index.ts:302-312`), asserted from outside at
  `packages/rtk/test/anthropicNative.test.ts`. That test moves and keeps
  asserting byte-identical preservation; it is the only thing standing between a
  renamed variant and silent rewriting.
- **A hook set will be proposed again.** When it is, the corrective that worked
  here is cheap: for each proposed hook, write the value that would make it
  unnecessary first. Three of four had one; the fourth had an argument for
  staying in core.
- **`servesTarget` remains the dangerous one**, hook or no hook. It is still the
  single copy of a question five sites once asked separately, and generalising it
  reproduced that exact failure mode once before the dashboard tests caught it.

## Out of scope

- Widening `ProviderId`; the plugin host; publishing a contract; moving kilo or
  kimi.
- `autoCache` and `cloakedTools` on the adapter contract — vendor-specific fields
  on a shared type, decided when the published contract is designed.
- Generalizing `AnthropicToolFamily`, `CacheControl.ttl`, or any other closed
  vocabulary listed above.
- The ingress `surface` union. A provider cannot register a client-facing dialect;
  that is a much larger decision about the client contract.
