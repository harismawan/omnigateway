# Core/provider decoupling

Removing provider-specific behaviour from `ir`, `router`, `store`, `control`,
`ratelimit` and `rtk` — by making IR values carry their own provenance where that
is possible, and by a closed set of named extension points where it is not.

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

Outcome 2 is most of this design. Outcome 3 is deliberately small.

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
`collect()` cases (`:180-186`, `:203-210`, `:236-241`), and to
`ANTHROPIC_NATIVE_BLOCK_TYPES`, which becomes descriptor data — the set of block
types *that provider* treats as native.

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
string. `Excluded` gains a discriminator and dispatch tests `e.kind ===
"capability"`.

**The emitted string still changes**, because the concept is renamed:
`excluded:capability:anthropicTools` becomes
`excluded:capability:providerNative`.

That string is persisted in `request_logs.degradations`, which makes it a storage
contract in the same class as `RTK_FILTER_IDS`. The decision is: **rename, do not
migrate.** Degradations are a forensic set rendered for operators, not parsed on
read the way `isRtkFilterId` parses filter ids, so old rows stay readable and
nothing drops. Rows written before this release carry the old spelling; rows
after carry the new one; both are documented in `ARCHITECTURE.md`, and the old
spelling ages out with retention. A migration was considered and rejected: it
would rewrite a table that is very large on a busy install, synchronously,
for cosmetics.

## Outcome 3: the closed extension-point set

Four points, and the intent is that this list stays four. Each is optional on a
descriptor; a provider that implements none behaves exactly as today.

```ts
export type ProviderHooks = {
  /**
   * Whether a content block may carry a cache breakpoint.
   * Replaces the thinking-block exclusion hard-coded into
   * `cacheControlOf` (ir/request.ts:90-95), which exists because Anthropic
   * rejects a marker on a thinking block.
   */
  cacheEligible?(block: ContentBlock): boolean;

  /**
   * Folds a provider-native delta into its accumulator.
   * Replaces the `citations_delta` (ir/stream.ts:204) and `compaction_delta`
   * (:238) literals inside core stream folding. Returning undefined means
   * "fold as an opaque append", today's default for every other delta type.
   */
  foldNativeDelta?(blockType: string, deltaType: string, accum: NativeAccum, delta: unknown): NativeAccum | undefined;

  /**
   * Health penalty for an error code this provider raises.
   * Replaces the FINGERPRINT_REFUSED entry in `router/breaker.ts:26-38`, whose
   * "none" penalty exists because a fingerprint refusal says nothing about the
   * credential's health.
   */
  breakerPenalty?(code: ErrorCode): Penalty | undefined;

  /**
   * An extra condition on whether an account serves a target, beyond provider
   * identity and the pin. Replaces the `endpointId` branch in
   * `servesTarget` (store/types.ts:388).
   */
  servesTarget?(target: TargetAddress, account: ServingAccount): boolean;
};
```

### Constraints on hooks, each of which has already been broken once elsewhere

- **Hooks called from `ir` or `router` must be pure.** No I/O, no clock, no
  randomness — the same contract those packages hold themselves to (boundary
  rules 1 and 3). Not compiler-enforceable; enforced by review and by tests that
  run each hook twice and assert identical output.
- **Resolved once, not per call.** `collect()` runs per stream event. The hook is
  looked up by provider id from a record — one map read — and never by scanning
  the registry.
- **`servesTarget` stays one rule in one place.** CLAUDE.md records that five
  sites once asked "can this account serve this target" separately and three
  asked less than the router did, so a target pinned to another provider's
  account saved clean, hard-failed every request, and `doctor` called it healthy.
  The hook does **not** reintroduce that: `servesTarget` in `@omni/store/types`
  remains the single copy and the single call site, and consults the descriptor
  from inside itself. Nothing else may call the hook directly. This is the one
  extension point where the invariant is more important than the extensibility,
  and it is included only because the `custom` endpoint branch is otherwise
  permanent.
- **`LogFields` does not become extensible, ever.** It is a closed allowlist and
  the redaction boundary; `cloakedTools` stays a core field. A provider that
  wants new telemetry does not get a hook for it. Stated here because it is the
  obvious next request and the answer must be no.

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
- **Each hook has a negative test.** A descriptor implementing none of the four
  produces today's behaviour exactly. Without this, a hook that is never invoked
  looks identical to one that works.
- **Each hook has a purity test**: invoked twice with equal input, equal output,
  no observable side effect.
- **The `kind: "portable"` rename gets a collision test**: a tool defined by the
  `custom` *provider* and a portable tool are distinguishable, which they are not
  today.
- **Degradation spelling** is pinned on both sides: the new string is emitted,
  and a fixture row carrying the old string still renders in the console.
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
- **The hook set will be asked to grow.** Four is a deliberate number. Each
  addition should require the same evidence this design required: a specific core
  site, a provider that cannot work without it, and no self-describing
  alternative.
- **`servesTarget` is the dangerous one.** If a second call site to the hook ever
  appears, the bug CLAUDE.md records comes back. A test asserting the hook has
  exactly one caller is worth its cost.

## Out of scope

- Widening `ProviderId`; the plugin host; publishing a contract; moving kilo or
  kimi.
- `autoCache` and `cloakedTools` on the adapter contract — vendor-specific fields
  on a shared type, decided when the published contract is designed.
- Generalizing `AnthropicToolFamily`, `CacheControl.ttl`, or any other closed
  vocabulary listed above.
- The ingress `surface` union. A provider cannot register a client-facing dialect;
  that is a much larger decision about the client contract.
