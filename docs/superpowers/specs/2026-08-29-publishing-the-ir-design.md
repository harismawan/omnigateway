# Publishing the IR, and moving the codec contract onto it

Sub-project 7. The last one the `provider` capability deferred, and the one that
makes a third-party provider plugin possible at all.

`packages/ir` becomes `@omnigateway/ir` on npm. `ProviderCodec` moves out of
`packages/providers` into `@omnigateway/plugin-api`, where a stranger can import
it. A codec stops constructing `GatewayError` and calls a host-supplied `fail()`
instead, which removes the only runtime coupling a plugin had to the IR.

## What this is for, stated narrowly

Today a plugin can supply a provider and the host will route to it — that shipped
in sub-project 4, and `apps/gateway/test/e2e/pluginProvider.test.ts` proves it end
to end. What a plugin **cannot** do is type against the contract: `ProviderCodec`
is written in terms of `ChatRequest` and `StreamEvent`, those live in `@omni/ir`,
and that package is private. The fixture in that test is untyped JavaScript for
exactly this reason.

So the goal is one sentence: **a third-party plugin author can write a provider in
TypeScript, against types they can install.** Everything below is in service of
that and nothing else.

## Why the IR is worth publishing at all

An intermediate representation is what stops two client surfaces and six providers
from being twelve translators. Everything parses into `ChatRequest`, every
provider emits from it, and the middle of the system — routing, RTK, ponytail,
the token estimate — is written once against a shape that knows no vendor.

A plugin provider is a new emit target. That is why it needs the IR: not to reach
gateway behaviour, but to describe a request in the one shape the host understands.

## The decision, and its cost

**`packages/ir` is renamed wholesale and published entire**, rather than split
into a public subset and a private remainder.

The alternative was a split: a published `@omnigateway/ir` holding
`request.ts`, `stream.ts`, `errors.ts`, `capabilities.ts` and `betas.ts`, with a
private package keeping `logger.ts` and `tokens.ts` and re-exporting the rest.
That would have left 263 files untouched and kept `LogFields` genuinely
unreachable.

The wholesale rename was chosen for a simpler mental model: one package, one
version, no re-export shim whose only job is to hide two modules. **The cost is
real and is accepted rather than argued away.** `LogFields` — a closed allowlist
and a redaction boundary — becomes public API, as do the token estimators in
`tokens.ts`. A third party may depend on their shape, and narrowing later is a
major version bump.

**The no-promise note is a signpost, not a wall, and must be documented as one.**
Anything in the tarball is reachable by anyone who types the path. A doc saying
"`logger` carries no compatibility promise" changes what a reasonable consumer
expects; it does not change what a consumer *can* do. Writing it as though it were
enforcement is the class of false claim this repository keeps a check for.

## Where the contract lives, and the dependency it inverts

`ProviderCodec`, `CodecInput`, `CodecRequest`, `CodecHttpRequest`,
`CodecDecodeInput` and `CodecErrorInput` **move into `@omnigateway/plugin-api`**.
`codecAdapter` — the host half, which performs the request — stays in
`packages/providers`.

That inverts one edge: `packages/providers` will import
`@omnigateway/plugin-api`. Core depending on the published SDK reads oddly at
first, and the direction is deliberate: **the SDK defines the contract and the
host implements it.** The reverse — providers defining it and plugin-api
re-exporting — puts two names on one type and gives a plugin author a second place
to look. The sub-project-4 spec placed the contract in `packages/providers` only
because `@omni/ir` was unpublished; that reason expires here.

`plugin-api` may now import `@omnigateway/ir` because it is published. The rule it
appears to break — "nothing a plugin imports may reach a core package" — was never
about core-ness. It is about **unresolvable `workspace:*` in a stranger's
dependency tree**, and a published package resolves. CLAUDE.md states it by the
wrong proxy today and must be restated: *nothing a plugin imports may reach an
unpublished package.*

## `fail()`, and the hazard it removes

A plugin install performs **no dependency resolution and creates no
`node_modules`** — `packages/control/src/plugins.ts` calls a plugin "a
self-contained tree", deliberately, because everything that makes `npm install` a
code-execution event is absent by construction.

The consequence decides this design. A third-party codec cannot `import
"@omnigateway/ir"` and have it resolve at runtime; it must bundle what it needs
into its server entry. Bundling a **type** is free — types are erased. Bundling a
**class** produces a second copy.

`GatewayError` is a class, and it is the only runtime coupling a codec has:
`buildRequest` returns plain objects, `decode` yields plain objects, and only
constructing an error needs a constructor. `codecAdapter`'s `guard` asks
`error instanceof GatewayError` to decide whether a codec's classification is
deliberate. **Against a bundled copy that check is false**, so a codec's
`AUTH` — thrown when a credential carries no token — flattens to `UPSTREAM`, and
dispatch gates its credential-refresh retry on `code === "AUTH"`. The refresh
silently stops happening. That is the exact failure the `instanceof` passthrough
was written to prevent, reintroduced by publication.

So the host supplies the constructor:

```ts
fail(
  code: ErrorCode,
  message: string,
  opts?: { status?: number; retryAfterMs?: number; degradations?: readonly string[] },
): GatewayError;
```

on both `CodecInput` and `CodecErrorInput`. A codec calls `input.fail("AUTH", …)`
and never imports the class, so no `instanceof` crosses a package boundary and the
IR is **type-only for plugin authors** — which also makes bundling it harmless.

Two properties of `fail` are load-bearing:

- **`gatewayAuthored` is not settable through it.** A plugin's message is authored
  outside this repository and is unknown in exactly the way an upstream body is —
  the same reason `rebound` drops the flag and `codecFailure` sets it.
- **`degradations` is bounded on the way in**, by the same
  `boundedDegradations` the other two paths use. A third source of unbounded
  strings into `request_logs.degradations` is how the first two were found.

**All six in-repo codecs migrate to `fail()`.** A contract that holds for a plugin
and not for a built-in is the drift six conversions were spent removing, and the
in-repo codecs are the only consumers that would prove the path before a stranger
does.

## Versions, and what enforces compatibility

- `@omnigateway/ir` starts at **`0.1.0`**. It is not `1.0.0`: nothing about this
  surface has been exercised by a consumer outside this repository, and claiming
  stability before that is a claim nobody has tested.
- `@omnigateway/plugin-api` takes **`0.3.0`**. Moving `ProviderCodec` in is
  breaking for any plugin that had one.
- `@omnigateway/dashboard-sdk` takes **`0.1.4`**, carrying the `^0.3.0` range.
  A range repair a consumer never sees is not a repair — the release step skips a
  package whose version has not moved.
- **`PLUGIN_API_VERSION` goes to `3`.** The manifest gate already exists and
  already means "which runtime contract this host speaks", and the contract moved.

**Nothing enforces an IR generation at runtime, and `IR_VERSION` is deleted.**
Since the IR is type-only for plugins, a mismatch is a compile error in the
author's own build rather than a runtime hazard, and `api: N` already covers the
runtime contract. `IR_VERSION` has exactly one reader —
`packages/ir/test/smoke.test.ts`, asserting that it equals `1`, which is a
constant compared with its own literal and not a use. Keeping it while adding no
gate would be a second version number to hold in step for nothing, which is what
`CALLBACKS` was deleted for. Delete the smoke test with it rather than leaving a
test whose subject is gone.

## Release mechanics, including the step CI cannot do

The workflow publishes in dependency order, and IR goes **first**: plugin-api
depends on it, and every publish is irreversible after 72 hours, so the package
most likely to fail belongs where failing costs only a re-tag.

**`@omnigateway/ir` must be bootstrapped by hand once, before any tag.** Trusted
publishing is configured on a package's settings page and there is no settings page
until a version exists; npm has no pre-registration (npm/cli#8544). Both current
names went through this. So: publish `@omnigateway/ir@0.0.1 --tag bootstrap` with a
token, so it never becomes `latest`, then configure trusted publishing for the
repository. Until that is done the release step fails with a permissions error
that does not explain itself.

The existing loop already skips a package whose version is on npm, so the only
change is adding `packages/ir` to the front of it.

## Testing

- **A codec compiled against nothing but `@omnigateway/plugin-api` builds, loads
  and serves a request.** `pluginProvider.test.ts`'s fixture is untyped JavaScript
  today because it had to be; it becomes TypeScript with no `@omni/*` import, and
  that is the whole sub-project's success criterion expressed as one test.
- **`fail()` keeps a classification through `codecAdapter`**, asserted on `AUTH`
  specifically, because that is the code dispatch gates credential refresh on and
  the one the `instanceof` hazard silently broke.
- **`fail()` cannot set `gatewayAuthored` and cannot exceed the degradation
  bound**, beside the two tests that already assert this for the other paths.
- **The published packages resolve as a stranger would resolve them**:
  `publishable.test.ts` gains `packages/ir`, so its version, its `files`, and the
  range `plugin-api` puts on it are walked like the existing pair.
- **`bundleWeight.test.ts` gains the IR entries**, and the zod-free ceiling still
  holds: IR imports nothing, so the types erase and `/define` should not grow.

## What this does not change

- The gateway's own version and release cadence. The SDK versions are not the tag,
  for the reason already recorded: tying them to it republishes an identical
  contract on every patch and makes every manifest's `sdk` range meaningless.
- `codecAdapter` and the host half of the contract stay in `packages/providers`.
- Boundary rule 1. `@omnigateway/ir` stays provider-independent and side-effect
  free; publication changes who may import it, not what it may contain.

## Risks

- **The public surface is permanent.** `LogFields` and `tokens.ts` ship, and the
  spec's own no-promise note does not make them unreachable. If that becomes
  uncomfortable, the fix is a major bump and a split — the option this design
  declined, kept here so the decision is legible rather than rediscovered.
- **671 specifiers change in one commit.** `typecheck` is the proof and there are
  no tsconfig path aliases to disagree with it, so the mechanical risk is low —
  but the diff is large enough that a real change hidden inside it would not be
  noticed by a reader. The rename must land as its own commit containing nothing
  else.
- **The bootstrap is a manual step outside CI**, and the failure mode when it is
  skipped is a permissions error that names nothing. It belongs in the release
  runbook, not only in this spec.
- **`fail()` is a new contract surface** in a sub-project whose purpose is to
  freeze the contract for publication. It is justified by the `instanceof` hazard
  being unfixable any other way under a no-`node_modules` install model, but it is
  one more thing a stranger must get right, and it arrives with no third-party
  consumer to prove it — the same limitation sub-project 4 recorded about its own
  optional hooks, and the reason Anthropic was converted early there.
