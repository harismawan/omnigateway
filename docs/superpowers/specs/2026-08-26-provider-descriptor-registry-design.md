# Provider descriptor registry

One record per provider, replacing the closed `ProviderId` union's sixteen
satellite tables. This is the first of several sub-projects whose end state is a
provider that ships as a plugin; it is also worth doing on its own, and is
specified so that it can be shipped and stopped at.

## Problem

Adding a provider today means editing sixteen files. The compiler finds eight of
them, because they are total `Record<ProviderId, …>` tables that stop compiling
until the new key is filled. It does not find the other eight, which are
hand-written arrays, zod enums and CSS blocks that go stale in silence.

The sixteen:

| Site | Kind | Compiler catches? |
|---|---|---|
| `packages/ir/src/request.ts:1` | the `ProviderId` union itself | — |
| `packages/ir/src/capabilities.ts:23` `ANTHROPIC_NATIVE_TOOLS` | total record | yes |
| `packages/ir/src/capabilities.ts:43` `PROVIDER_CAPABILITIES` | total record | yes |
| `packages/providers/src/registry.ts:10` `ADAPTERS` | total record | yes |
| `packages/providers/src/body.ts:10` `BODY_ORDER` | total record | yes |
| `packages/providers/src/profile.ts:297` `PROFILES` | total record | yes |
| `packages/providers/src/catalog.ts:44` `PROVIDER_MODEL_CATALOG` | total record | yes |
| `apps/gateway/src/dispatch/price.ts:17` `WRITE_OVER_INPUT` | total record | yes |
| `apps/dashboard/src/theme/tokens.ts:75` `PROVIDER_LABEL` | total record | yes |
| `packages/control/src/connect.ts:8` `PROVIDER_IDS` | hand-written array | no |
| `packages/control/src/schemas.ts:42` | zod enum | no |
| `packages/control/src/schemas.ts:59` | zod enum, five ids — see the correction below | no |
| `packages/control/src/oauth/index.ts:9` `OAUTH_PROVIDERS` | partial record | no |
| `apps/dashboard/src/theme/tokens.ts:72` `PROVIDER_IDS` | second id list + a **second `ProviderId` type** at `:73` | no |
| `apps/dashboard/src/features/accounts/AccountsBoard.tsx:38` `PROVIDER_ORDER` | third id list | no |
| `apps/dashboard/src/theme/GlobalStyle.ts:34,80` | CSS custom properties, light and dark | no |

Five of those are independent hand-written copies of the same six names. The
project has been bitten by this before: `packages/control/src/oauth/index.ts:22-25`
carries a comment recording that two such lists had already drifted, which is why
`OAUTH_PROVIDER_IDS` is derived from `Object.keys` rather than restated. This
design applies that same fix to the remaining fifteen sites.

Two of the uncaught ones fail in ways that read as something other than a missing
table entry:

- `AccountsBoard.tsx:38` — a provider absent from `PROVIDER_ORDER` renders **no
  accounts module at all**, even when it has credentials. The board filters its
  rows through that array at `:221`.
- `apps/dashboard/src/features/overview/ModelTraffic.tsx:113` and
  `ActivityTail.tsx:68` interpolate `` `var(--p-${provider})` ``. An id with no
  CSS custom property resolves to nothing, and the element renders colourless
  with no error.

## Goal

One `ProviderDescriptor` per provider, holding everything the sixteen sites hold
today, with a registry that is the single place any of it is read from.

Non-goals for this sub-project, each owned by a later one:

- Widening `ProviderId` beyond its six literals. The union stays closed here and
  the registry is keyed by it, which keeps this change behaviour-preserving with
  a green suite on both sides.
- Loading a provider from disk, publishing a contract, or moving kilo and kimi.
- Serving the model catalog over `/api/*` (its own sub-project, since it
  rewrites architectural boundary rule 9).

## The tier boundary, stated once

This sub-project — and the ones after it — make a provider addable without core
edits **only for providers the current IR can already express**. That covers
OpenAI-compatible wire formats, OAuth and API-key credentials, and any provider
whose content blocks, tool definitions, stop reasons and cache vocabulary are
already modelled.

It does not cover a provider that extends what the gateway can *express*.
`packages/ir` encodes Anthropic's dialect as the canonical one, deliberately, in
at least these places: the `anthropicNative` block variant (a member of
`ContentBlock`, `ContentBlockStart`, `Delta` and `Accum`, with dedicated handling
in `collect()` and `tokens.ts`), `AnthropicToolFamily` and its eleven members,
`ToolDef = CustomToolDef | AnthropicToolDef`, `CacheControl.ttl` restricted to
`"5m" | "1h"`, `StopReason`'s `pauseTurn`, signed-thinking signature
accumulation, and the `citations_delta` and `compaction_delta` literals inside
core stream folding.

A provider needing a new member of any of those edits `@omni/ir`. That is correct
and should not be designed away — it is the difference between a provider the
contract covers and one that changes what the gateway can say. Every document
that describes this work should state the boundary rather than claiming "no core
edits" unconditionally.

## The descriptor

```ts
export type ProviderDescriptor = {
  readonly id: ProviderId;

  /** Was PROVIDER_CAPABILITIES (ir/capabilities.ts:43). */
  readonly capabilities: Capabilities;

  /** Was ANTHROPIC_NATIVE_TOOLS (ir/capabilities.ts:23). */
  readonly anthropicNativeTools: boolean;

  /** Was BODY_ORDER (providers/body.ts:10). */
  readonly bodyOrder: readonly string[];

  /** Was PROFILES (providers/profile.ts:297). */
  readonly profile: ClientProfile;

  /** Was WRITE_OVER_INPUT (gateway/dispatch/price.ts:17). */
  readonly writeOverInput: { fiveMinute: number; oneHour: number };

  /**
   * Was PROVIDER_MODEL_CATALOG[id] (providers/catalog.ts:44) — the whole value
   * that map holds for this id, not a bare model list. Consumers index it as
   * `.models` today (`apps/dashboard/src/features/models/draft.ts:190`), so the
   * shape is preserved rather than flattened.
   */
  readonly catalog: ProviderCatalogEntry;

  /** Was PREFIX_PROVIDER (router/resolve.ts:12). Empty for most providers. */
  readonly modelPrefixes: readonly string[];

  /** Was the CALLBACKS entry (control/connect.ts:36). Absent unless loopback. */
  readonly callback?: { uri: string; label: string };

  /** Was the secret-shape rule in store/bodies/mask.ts. Absent unless distinctive. */
  readonly secretPattern?: { pattern: RegExp; keep: number };

  readonly presentation: {
    /** Was PROVIDER_LABEL, in three copies. */
    label: string;
    /** Was PROVIDER_ORDER (AccountsBoard.tsx:38). */
    order: number;
    /** Was theme.provider.<id> plus --p-<id> in light and dark. */
    colour: { light: string; dark: string };
    /**
     * Was PROVIDER_TONE (cli/command.ts:46). Declared as the tone *name*, not
     * the CLI's `Tone` type: `packages/providers` must not import from
     * `apps/cli`, and the CLI already owns the name-to-escape-code mapping.
     */
    tone: string;
    /** Was PASTE_HINT / CODE_PLACEHOLDER (ConnectDialog.tsx:54,70). */
    pasteHint?: string;
  };

  readonly adapter: ProviderAdapter;

  /** Was the OAUTH_PROVIDERS entry (control/oauth/index.ts:9). */
  readonly auth?: OAuthProvider;
};
```

Every field is required except `auth`, `callback`, `secretPattern` and
`presentation.pasteHint`. Each optional field is optional because its absence is
a real state some current provider is in — `custom` has no OAuth flow, only
`openai` and `grok` use a loopback redirect, only xAI has a distinctive key
prefix — and not because a provider might forget to supply it.

`writeOverInput` in particular is required with no default. It is `{1.25, 2}` for
Anthropic and `{0, 0}` for everyone else, and a default of zero underprices cache
writes silently and permanently. It is the field most worth failing loudly over.

### Where the descriptors live

Built-in descriptors live in `packages/providers/src/<id>/descriptor.ts`, one per
adapter directory, assembled by `packages/providers/src/registry.ts` into a
`ProviderRegistry`. This preserves architectural boundary rule 2: no adapter
directory imports another's, and a descriptor is the file a future extraction
moves out wholesale.

`auth` is the exception worth noting, because it inverts a current dependency.
The OAuth flows live in `packages/control/src/oauth/` today and import from
`@omni/providers` (`PROFILES`, `mintKimiDevice`, `kimiDeviceHeaders`). Relocating
each flow file beside its adapter removes that import, and removes core `control`
reaching into provider internals by key — `packages/control/src/oauth/grok.ts:109`
reads `PROFILES.grok` today, which is exactly the coupling the descriptor exists
to end. `packages/control` keeps the flow *runner* (`connect.ts`, `refresh.ts`,
`quota/poll.ts`), all of which already take an injected provider table and hold
no id list of their own beyond `PROVIDER_IDS`.

This is a move **within the monorepo** — `packages/control/src/oauth/kilo.ts`
becomes `packages/providers/src/kilo/oauth.ts` — and is distinct from extracting
kilo to a plugin, which is a later sub-project. The two are separated on purpose:
this one is a relocation with no behaviour change and its existing tests
(`packages/control/test/oauth/{kilo,kimi}.test.ts`) move with it, and the
extraction is then a directory move rather than a redesign.

An alternative worth recording: leave the flows where they are and have
descriptors import them. That keeps this sub-project smaller, but preserves the
`PROFILES.grok` coupling and leaves a provider's code split across two packages —
which makes the later extraction the redesign this move is meant to avoid.

## Replacing compile-time exhaustiveness

Eight of the sixteen sites are safe today because the compiler refuses to let a
provider be added without filling them. Collapsing them into one record keeps
that property while the union stays closed: `ProviderRegistry` is typed
`Readonly<Record<ProviderId, ProviderDescriptor>>`, so a seventh id is a type
error in exactly one place instead of eight.

When a later sub-project widens `ProviderId`, that guarantee is replaced by
**load-time validation**, not by defaults at each lookup site. The registry
validates that a descriptor is complete when it is registered; an incomplete one
is refused and reported the way every other plugin load failure is reported. No
call site acquires a `?? default`, because a default is how a missing
`writeOverInput` becomes a pricing bug rather than a load failure.

The registry also refuses an id already held by a built-in, so a third-party
provider cannot claim `anthropic`.

## Migration, per site

Behaviour-preserving throughout. Each step replaces a read, not a value.

1. **Define the descriptor type and registry** in `packages/providers`, assembled
   from six descriptor files whose contents are moved verbatim from the existing
   tables.
2. **`packages/ir`** — `PROVIDER_CAPABILITIES` and `ANTHROPIC_NATIVE_TOOLS` move
   into descriptors. `packages/ir` must not import `packages/providers`
   (boundary rule 1), so the two tables become registry reads at their consumers:
   `packages/router/src/resolve.ts:53`, `packages/router/src/filters.ts:60`, and
   `apps/cli/src/commands/models.ts:166`. The router stays pure — it reads a
   record it is handed, exactly as it reads the snapshot today.
3. **`packages/providers`** — `BODY_ORDER`, `PROFILES`, `PROVIDER_MODEL_CATALOG`
   and `ADAPTERS` become views over the registry. The `@omni/providers/catalog`
   subpath keeps its current shape and its leaf status; it is derived from the
   descriptors at module scope, so the dashboard's four static importers are
   untouched by this sub-project.
4. **`packages/router`** — `PREFIX_PROVIDER` (`resolve.ts:12`) is rebuilt from
   `descriptor.modelPrefixes`. `PROVIDERS` (`resolve.ts:6`) already derives from
   `Object.keys`; it derives from the registry instead.
5. **`apps/gateway`** — `WRITE_OVER_INPUT` (`price.ts:17`) becomes a registry
   read at `price.ts:61`.
6. **`packages/control`** — `PROVIDER_IDS` (`connect.ts:8`), `providerIdSchema`
   (`schemas.ts:42`) and `CALLBACKS` (`connect.ts:36`) derive from the registry.
   `OAUTH_PROVIDERS` (`oauth/index.ts:9`) becomes a projection of descriptors
   that carry `auth`.

   **Correction, found during implementation.** An earlier draft of this spec
   read `schemas.ts:59` as drift — a hand-written enum that had fallen out of
   sync by omitting `custom` — and scheduled "regaining `custom`" as this
   sub-project's one deliberate behaviour change. That was wrong, and acting on
   it would have been a regression. `targetSchema` is a
   `z.discriminatedUnion("provider", …)`: the enum at `:59` is the **non-custom
   arm**, and `custom` is absent because it has its own arm requiring
   `endpointId`. Adding it to the first arm would let a custom target save with
   no endpoint id, which is precisely the field `servesTarget` matches an
   account on.

   So `:59` is not derived from the registry. Deriving it would also weaken the
   discriminated union: zod infers the arm's `provider` type from the schema, and
   a runtime-built enum widens it from the five literals back to `ProviderId`,
   costing the exhaustiveness that makes the union worth having. It gets a
   **pin** instead — a test asserting the two arms together cover exactly the
   registry's ids, so a seventh provider fails loudly without the union being
   rebuilt at runtime.

   The general lesson is worth more than the fix: a five-of-six enum next to a
   six-member list looks like drift and is sometimes a discriminant. Read what
   the missing member does elsewhere before calling a difference a bug.
7. **`packages/store`** — the `xaiKey` rule in `bodies/mask.ts:122,155,191`
   derives from `descriptor.secretPattern`. `MaskRuleId` stops enumerating
   vendor names. `@omni/store` may not import `@omni/providers`, so the patterns
   are injected where the masker is constructed, the same way clocks and loggers
   are injected elsewhere.
8. **`apps/cli`** — `PROVIDER_TONE` (`command.ts:46`) becomes a registry read.
9. **`apps/dashboard`** — the second `ProviderId` type (`tokens.ts:73`), the
   three `PROVIDER_LABEL` copies, `PROVIDER_ORDER`, `PASTE_HINT`,
   `CODE_PLACEHOLDER` and the light/dark `--p-<id>` blocks all derive from one
   source. The console already imports `@omni/store/types` directly for
   `servesTarget`, and `@omni/providers/catalog` for the model catalog; the
   presentation slice follows the second precedent as a leaf subpath carrying
   labels, ordering and colours and nothing else.

Runtime CSS custom-property injection — needed once a provider's colour is not
known at build time — is deferred to its own sub-project. Here the descriptors
still emit the same static blocks `GlobalStyle.ts` holds today.

## Testing

The bar is that no behaviour changes, so the tests are pins rather than new
assertions.

- **Per-map equivalence.** For each of the eight replaced tables, a test asserting
  the registry yields values deep-equal to the literal it replaced, for all six
  providers. These are written *before* the literal is deleted and are the reason
  the deletion is safe.
- **Completeness.** Every descriptor has every required field populated; a
  fixture descriptor missing `writeOverInput` is refused. The negative case is
  the point — absent it, the test passes against a validator that does nothing.
- **Derivation, not restatement.** `packages/providers/test/catalog.test.ts:7`
  re-enumerates the six ids by hand today; it derives them from the registry
  instead. A test asserting the registry has six entries is the one place the
  count is written down.
- **Collision.** Registering an id a built-in holds is refused.
- **`schemas.ts:59` regains `custom`.** A target with `provider: "custom"` now
  validates through the non-custom arm's sibling; the existing custom arm keeps
  requiring `endpointId`.
- **Dashboard.** `apps/dashboard/test/theme/theme.test.tsx` gains an assertion
  that every provider in the registry has both a light and a dark colour, since
  a missing one renders colourless rather than failing.

Mutation-testing the pins is worthwhile here specifically, because an equivalence
test that compares a value to itself passes no matter what: change one
descriptor's `bodyOrder` and confirm the corresponding pin fails.

## Risks

- **The equivalence pins are the whole safety net.** A pin that reads through the
  registry on both sides asserts nothing. Each must compare the registry against
  a literal copy of the pre-change table, checked in as a fixture, not against
  the registry itself.
- **`packages/ir` cannot import `packages/providers`.** Step 2 moves two tables
  out of `ir` and must not reintroduce the dependency in the other direction.
  If a consumer turns out to need the capabilities table somewhere `ir` cannot
  reach, the fallback is to leave those two tables in `ir` and have descriptors
  reference them — worse, but it preserves the boundary.
- **This sub-project has no behaviour changes.** An earlier draft claimed one —
  `schemas.ts:59` regaining `custom` — and that claim was wrong; see the
  correction in step 6. Anything that looks like a behaviour change during
  implementation is a signal to re-read, not to proceed.
- **Scope creep toward the plugin host.** The union stays closed in this
  sub-project. Widening it here would make the change non-behaviour-preserving
  and cost the green-suite-on-both-sides property that makes it reviewable.

## Out of scope

- Widening `ProviderId`; the plugin host; publishing a contract; moving kilo or
  kimi.
- Serving the catalog over `/api/*`, which rewrites boundary rule 9.
- Runtime CSS custom-property injection for plugin-supplied colours.
- The tier-2 items: `OAuthProvider`'s two arms, `protocol`'s two members,
  `ToolDef`'s two arms, `AuthType`, `WindowType`, `StopReason`, `CacheControl.ttl`,
  `ErrorCode`, `LogFields`, and the closed `surface` union. Each is a closed set a
  provider might need a new member of; each is decided when the published contract
  is designed, not here.
- `autoCache` and `cloakedTools` on the adapter contract. Both are vendor-specific
  fields on a shared type — `autoCache` alone spans six core files — and both are
  arguments for the descriptor rather than problems it solves. Whether the
  published contract keeps them is a question for that sub-project.

## Sources

Four repository sweeps conducted 2026-08-26, covering: the adapter contract and
registration seams; Anthropic's core footprint; OpenAI, grok and custom; and the
gateway loops, CLI and console. Findings not otherwise cited above:

- The request hot path — `routes/proxy.ts`, `dispatch/`, `ingress/`, `egress/` —
  holds no provider-id branch. `dispatch/price.ts:17` is the sole exception, and
  `Surface = "anthropic" | "openai"` is the client dialect, not an upstream id.
- The store schema is already open: `credentials.provider` is `TEXT` with no
  `CHECK` and no enum, `provider_data` is JSON, and provider names appear in
  migrations only in comments. No migration is needed for a new provider.
  `sqlite/credentials.ts:159` casts `row.provider as ProviderId` on read, so an
  unrecognised value round-trips and is silently mis-typed.
- The background loops are row-driven, not list-driven. The refresh scheduler
  (`apps/gateway/src/oauth/scheduler.ts:40`) and the quota poller
  (`packages/control/src/quota/poll.ts:115`) both enumerate credential rows and
  look up capability on an injected table. `omni doctor`
  (`apps/cli/src/commands/service.ts:237`) performs zero per-provider checks.
- `packages/rtk` contains no provider name and preserves unknown block types by
  structural fall-through (`rtk/src/index.ts:302`).
