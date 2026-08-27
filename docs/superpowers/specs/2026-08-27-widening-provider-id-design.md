# Widening `ProviderId`

`ProviderId` stops being a closed union of six literals and becomes a validated
string. Compile-time exhaustiveness over the six is replaced by load-time
validation over whatever is registered, and a target naming a provider that is
not installed becomes a routing exclusion rather than an impossibility.

Sub-project 3a. Depends on
[the descriptor registry](2026-08-26-provider-descriptor-registry-design.md) and
[core/provider decoupling](2026-08-27-core-provider-decoupling-design.md). It is
the precondition for the plugin host: a provider loaded from `<root>/plugins/`
has an id that is not one of the six, and today the type system forbids one.

## Order, and why this is not the publishing sub-project

The published contract — `@omnigateway/ir` and `@omnigateway/provider-api` —
comes **after** the plugin host and after kilo and kimi are extracted onto it.
A published contract's cost is highest when it is wrong and it is hardest to
validate with no consumer; kilo and kimi loading from disk against an internal,
still-changeable contract are the two consumers that prove the shape. Publishing
first would freeze a guess.

This sub-project is what makes the host possible at all, so it comes first
regardless of when publication happens.

## Problem

```ts
export type ProviderId = "anthropic" | "openai" | "kimi" | "kilo" | "grok" | "custom";
```

Six literals, and the union is load-bearing in three ways that a plugin provider
runs into immediately:

- `ProviderAdapter.id` and `Target.provider` are `ProviderId`, so a plugin cannot
  name itself.
- `ChatRequest.vendor` is `Partial<Record<ProviderId, …>>`
  (`packages/ir/src/request.ts:258`) — the open value bag has a closed key, so a
  plugin cannot address its own passthrough.
- `ProviderDescriptors` is a **total** `Record<ProviderId, ProviderDescriptor>`,
  as are `ADAPTERS`, `PROVIDERS`, `BODY_ORDER`, `PROFILES` and
  `PROVIDER_MODEL_CATALOG`. A seventh entry does not typecheck.

The totality is not incidental — it is what has kept adding a provider safe.
Removing it without a replacement trades a compiler error for a runtime one, and
the runtime ones this repo has hit in this area were silent.

## What replaces exhaustiveness

Sub-project 1's spec already decided this, and the descriptor was built for it:
every field on `ProviderDescriptor` is required and there are no defaults, on the
stated grounds that `writeOverInput` defaulting to zero would underprice cache
writes silently and permanently.

So the replacement is **validation at registration**, not defaults at lookup:

- A descriptor missing a required field, or carrying an id that is not a usable
  identifier, fails to register and is reported. For a built-in that is a
  compile error as it is today, because the six are still written as literals.
  For a plugin it is a load failure, skipped and reported, never fatal — boundary
  rule 15.
- Lookups keyed on a registered id stay total **by construction**: `BODY_ORDER`,
  `PROFILES` and `PROVIDERS` are assembled by walking the registry, so they carry
  exactly the ids it holds.
- Lookups keyed on a *stored* id — a `Target.provider` read back from SQLite —
  become genuinely partial, because the database can name a provider that is no
  longer installed. Those are enumerated below and each gets a decision.

### The id rule

One rule, in `packages/providers`, matching the plugin manifest's:
`/^[a-z][a-z0-9-]{0,31}$/`.

It is restated rather than imported from `@omnigateway/plugin-api`, for the
reason `catalog.ts` already restates `CatalogAuth`: this is the *provider's*
requirement, the two coinciding today is not a reason for one to follow the other
silently, and that package is published while this one is not.

`packages/control/src/catalog.ts` already validates provider ids for the palette
with an identical expression. That becomes a re-export of the one rule; two
copies of an identifier grammar is exactly the shape this work has been removing.

## The stored-id problem

This is the substantive behaviour change, and the precedent for it already
exists.

A `Target.provider` read from `virtual_models.targets` — JSON parsed with no
validation — can name a provider that is not installed: a plugin removed, a
database restored onto a different installation, a hand edit. Today that is
impossible; after this it is ordinary.

**The rule is the one pins already follow.** `packages/store/src/types.ts`'s
`servesTarget` refuses an account that cannot serve a target, `eligible()` drops
the pair, and `pin:missing` is emitted once per target so the request fails with
a reason rather than an empty exclusion list. An uninstalled provider gets the
same treatment:

- **Router** — a target whose provider has no descriptor is excluded at
  `eligible()` with reason `provider:missing`, emitted once per target, `kind:
  "target"` so the degradation does not name a credential. It is a fact about the
  target, not about any account.
- **Dispatch** — `deps.adapters[candidate.target.provider]` at
  `apps/gateway/src/dispatch/index.ts:405` already handles absence with
  `INTERNAL "no adapter for provider …"`. That path stops being unreachable. It
  stays `INTERNAL` and stays a throw, because reaching dispatch means the router
  admitted a candidate it should have excluded — that is a gateway bug, not an
  operator one, and the two must not read alike.
- **Write paths stay permissive.** `putModel` accepts a target naming an
  uninstalled provider, for the reason it already accepts a dangling pin:
  removing a plugin must not make an unrelated edit unsavable. `providerIdSchema`
  validates the *format* of the id, never its installation.
- **`omni doctor` carries the weight**, as it already does for pins. It reports
  targets naming providers this installation does not have, which is the one
  place an operator finds out before a request does.

## Sites

**Total records that become registry-derived.** Their keys are whatever is
registered; the type is `Readonly<Record<string, …>>` and totality is a property
of construction rather than of the type:

| Site | Note |
|---|---|
| `providers/src/descriptor.ts` `ProviderDescriptors` | the registry itself |
| `providers/src/registry.ts` `ADAPTERS`, `PROVIDERS` | walk the registry |
| `providers/src/body.ts` `BODY_ORDER` | assembled from `<id>/profile.ts` |
| `providers/src/profile.ts` `PROFILES` | same |
| `providers/src/catalog.ts` `PROVIDER_MODEL_CATALOG` | assembled from `<id>/models.ts` |
| `apps/gateway/src/app.ts` adapters override | test injection point |

**Already `Partial`, so unaffected in shape**: `dispatch/index.ts` adapters,
`control/connect.ts` providers and `CALLBACKS`, `control/oauth/index.ts`
`OAUTH_PROVIDERS`, `oauth/refresh.ts`, `quota/poll.ts`.

**Schema.** `providerIdSchema` becomes a format-validated string.
`targetSchema`'s non-custom arm keeps its hand-written five-member enum — it is
already a documented core edit per provider, pinned rather than derived because
deriving widens the arm's inferred type and costs the discriminated union its
exhaustiveness. **That pin becomes more important, not less**: it is now the only
compile-time check that a new provider was thought about at all.

**`ChatRequest.vendor`** becomes `Record<string, Record<string, unknown>>`. This
is a published-shape change when publication happens, which is a reason to do it
now rather than after.

## Testing

- **Every derived table covers exactly the registered ids**, asserted by walking
  the registry rather than by a literal — the literal is what totality used to
  provide.
- **A descriptor with a bad id fails to register and is reported.** The palette
  already has this test in `packages/control`; it moves to where the rule lives.
- **A target naming an uninstalled provider is excluded with a reason**, and the
  exclusion list is not empty. The failure this guards against is the one
  `pin:missing` exists for: a request that fails with nothing explaining it.
- **`omni doctor` reports such a target.** Its `danglingPins` check is the model.
- **Dispatch's `INTERNAL` path is reachable and tested.** It has been dead code
  since it was written.
- **The 3a change is otherwise behaviour-preserving**, so each derived table is
  pinned against a checked-in copy of what it holds today, the same instrument
  sub-project 1 used.

## Risks

- **This removes a compiler guarantee.** Eight maps stopped a provider being
  half-added; after this, six of them cannot. The mitigation is that the
  descriptor is one required record rather than eight scattered tables, so the
  thing being validated is a single object with a single completeness check —
  but the guarantee is genuinely weaker, and saying otherwise would be false.
- **`Record<string, X>` invites a lookup that assumes presence.**
  `noUncheckedIndexedAccess` is on, which makes each one a compile error at the
  point of use — that is the compiler help that survives, and it should be
  leaned on rather than cast away.
- **The stored-id path is new and its failure mode is a request that does not
  route.** Every one of the four decisions above exists to make that loud.

## Out of scope

- Publishing anything. `@omnigateway/ir` and `@omnigateway/provider-api` come
  after the host and after kilo and kimi prove the contract.
- The plugin host, the `provider` capability, and any registration API. This
  sub-project makes a non-literal id *representable*; nothing yet creates one.
- `targetSchema`'s non-custom arm, which stays hand-written and pinned.
- `AuthType`, `WindowType`, `ErrorCode`, `LogFields` and the other closed
  vocabularies. A provider that needs a new member of those still edits core, by
  design.
