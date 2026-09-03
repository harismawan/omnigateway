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

## History

Forensic narrative moved here from `CLAUDE.md` rule 17 on 2026-09-03. The rule keeps the
invariants; this section keeps how they were found.

### OAuth seeding

`seedBuiltinOAuth()` sat inline in gateway `main()` first, and that is the trap: **no test calls
`main()`**, so the only guard was a test grepping the source, and a substring match passes on a
commented-out call — measured, commenting it out left all 3347 tests green while a booted gateway
would have had no OAuth at all. It now lives on `installPluginProviders` because that function is
called unconditionally at boot and is reachable from a harness.

Moving it there was not enough, and the second failure is the more instructive one. The
replacement guard read `OAUTH_PROVIDERS` — process-wide module state, one Bun process for the
whole suite — so `logging.test.ts` and `apps/cli/test/connect.test.ts` seeded first and the
assertion passed on *their* seed. Measured: deleting the seed left `bun test`,
`bun test apps/gateway` and `bun test packages/control` green; only that one file alone caught
it. A module-scope `seeded` boolean made it unfixable in place — it latches, so clearing the table
does not help. The registry is therefore threaded: `registerOAuthProvider`, `seedBuiltinOAuth` and
`installPluginProviders` all take one, defaulting to the global, and the test drives
`Object.create(null)`.

Idempotence is a `WeakMap` of which id we installed into which registry, and the second iteration
matters: a `WeakSet` of seeded *registries* makes a deleted built-in unrecoverable — measured, a
reseed leaves it at four providers — so "nothing ever deletes a built-in" became a load-bearing
unstated invariant while two test files delete from the shared registry in `afterEach`. Recording
the id lets a reseed tell three cases apart: ours and present (skip), ours and gone (reinstall),
someone else's (throw). Repair restores membership, not position — object key order is insertion
order, so a repaired id lands last; production never deletes one, so the order an operator sees is
the seed's own.

`installPluginProviders` must stay unconditional: wrapping it in `if (providers.length > 0)` kills
OAuth on every plugin-less install, which is most of them — a tidy-up the function's own name
invites. That edit left the suite green when first measured; `oauthSeed.test.ts` now catches it,
single-line and block form both, by asserting the call sits at two-space indent — a top-level
statement of `main()`. Its `|| Object.hasOwn(registry, id)` disjunct is defence-in-depth, not
coverage: every seeded id is in `PROVIDER_DESCRIPTORS` too and a plugin enters both tables in one
iteration, so the first disjunct always fires first. An earlier version of the rule claimed that
check "stopped being vacuous"; measured false.

`providerCoverage.test.ts` broke the "seed first" rule in the very commit that wrote it and passed
green over an empty set when run alone.

### Porting the five OAuth flows

Porting the five flows found three things the fixture could not, each because a fixture written
to fit a contract cannot disagree with it. Built-ins use two deadlines — 30s for a token call an
operator waits on, 15s for a usage probe nothing waits on — so `AuthRequest.timeoutMs` is optional
and clamps to the host ceiling; one constant would have quadrupled the second silently. A
delegated step must be `async function*`: a sync generator yielded through from an async one runs
fine, every test passes, but `TNext` widens to `AuthResponse | undefined` and only the compiler
sees it. And `PluginOAuthFlow` is a discriminated union with `oauthAdapter` overloaded on `kind`,
because the flat shape flattens the return type — `kiloOAuth` stops being a `DeviceOAuthProvider`
and every consumer reading `begin`/`needsDeviceId` loses it.

`requests.ts` holds pure builders that replaced `postJson`/`getJson` — same profile, same merge
and order, stopping before the send — so ported flows emit the bytes their own golden tests
already pin. Those two were deleted once the last flow stopped calling them: an exported, tested
way to send with `deps.http` directly is a way to bypass the yield cap, the origin check and the
return-shape validation the adapter exists to impose.

Each provider's test file is unchanged, which is the proof; mutants against all five (dropped
`client_id`, dropped beta header, state check off, kilo's second request unauthenticated, kilo's
org read skipped, grok's host check off, kimi's device headers dropped, openai's content type
changed) each kill tests — verified by mutation from the new location. Two files changed beyond
their import line: kimi's registry test, which now reads the seed's own result, and grok's, whose
`OAUTH_PROVIDERS.grok === grokOAuth` became `x === x` once `builtins.ts` defined one as the other.
They stay in `control/test/oauth/` because they drive the *adapted* provider and `oauthAdapter` is
control's — a test in `packages/providers` reaching for it would invert the package graph. They
read the five through `test/oauth/builtins.ts`, off the seeded registry: strictly stronger than the
named import it replaced, since a seed that drops one, installs the wrong flow or forgets `trusted`
now fails all five suites.

An earlier version of the type-only rule claimed `leafSubpaths.test.ts` would catch a value import
of `@omni/store`; measured false — turning one into a value import left the whole suite green,
because those modules are outside both leaf graphs regardless of import kind. What enforces it is
`packages/providers/test/oauthStoreEdge.test.ts`.

### Registry threading sweeps

Three review rounds in a row each found partial threading in the previous round's fix: the
prototype sweep covered `@omni/providers` and left `OAUTH_PROVIDERS`, `CALLBACKS` and the
console's `heldAuths`; injection covered `resolveModel` and `rank` and left `priceOf`, so a $12.50
cache write billed $0.00 with no throw and no log; then the test pinning *that* covered the
injected path and not the default, because `??` only fires on `undefined`. Every one found by
hand, by someone thinking to try that one site. The sentinel-registry test in
`apps/gateway/test/dispatch/dispatch.test.ts` replaced per-site tests for that reason.

The module-scope snapshot count went three, then five, then six, because each sweep stopped at
the sites the previous bug had made visible: `providerCatalog` served a console missing every
plugin provider, `providerIdSchema` was `z.enum(PROVIDER_IDS)` and would have refused their
credentials, `isProviderId` reported them as not existing, `PREFIX_PROVIDER` made a provider's own
`modelPrefixes` unreachable while `provider/model` for the same provider resolved, `CALLBACKS`
redirected nowhere, and `OAUTH_PROVIDER_IDS` gated `omni connect`.

### Prototype-keyed provider ids

`resolveModel` replaced a `Set.has` — which never consults a prototype — with an index check, and
`model: "constructor/foo"` returned 500 carrying an internal source expression where `nope/foo`
correctly returned 503. Same keys defeated four more readers including the `provider:missing`
guard and `omni doctor`'s check. An `Object.hasOwn`-at-readers version was written, and every one
of its mutants survived removal. An earlier version of the rule enumerated the tables, and
`OAUTH_PROVIDERS` in `@omni/control` went on leaking for another review round — a raw `TypeError`
out of `refresh.ts` — plus `CALLBACKS` and the console's `heldAuths` map.

An earlier version of the `ProviderId` rule claimed deleting a built-in's line from a provider
table was a compile error. Measured false for all five hand-written tables.
