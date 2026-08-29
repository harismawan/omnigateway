# The provider capability's auth half

A plugin supplies its provider's OAuth flow. `OAUTH_PROVIDERS` stops being a
closed table of five literals in core, and adding a provider stops requiring a
core edit.

The auth half sub-project 4 deferred, and the last thing standing between an
operator's own provider and "no core files touched".

## The goal, stated as the thing that is wrong today

Adding a provider **as a built-in** touches six core files: `descriptors.ts`,
`registry.ts`, `profile.ts`, `body.ts` and `catalog.ts` in `packages/providers`,
plus `oauth/index.ts` in `packages/control`. Five of those are hand-written
literals a deletion passes `tsc` on — only lint and one test catch it. That is
the regression surface this exists to remove.

Adding a provider **as a plugin** touches none of them. `registerProvider`
mutates the two tables that matter at boot, and
`apps/gateway/test/e2e/pluginProvider.test.ts` routes a real request through a
plugin-supplied provider with no adapters injected.

**So the mechanism already exists and works — for API keys only.** The gap is one
sentence, and `apps/cli/src/commands/credentials.ts` states it: an API key is
"the only way in a plugin-supplied provider has at all, since a plugin declares
no OAuth flow."

## What is already in place, and is easy to under-count

Three things that would otherwise look like work and are not:

- **`OAUTH_PROVIDERS` is already injected, never read as a global.** `app.ts`
  (twice), `apps/gateway/src/index.ts` (twice), the CLI's `run.ts` and
  `credentials.ts` all take `providers:` as a parameter. The threading that made
  the descriptor registry pluggable is already done here.
- **The CLI can already read a plugin's declaration without running it.**
  `readPluginProviders` exists and `apps/cli/src/commands/plugins.ts` already
  calls it. The CLI must never call `loadPlugins` — `setup` opens channels, runs
  migrations and registers routes, none of which a diagnostic should do — but it
  does not need to. So `omni credentials connect` can reach a plugin's flow on
  the same terms the gateway does, and this design has no console-only limitation.
- **`net:outbound` is implemented.** `capabilities.ts` already hands a plugin an
  origin-scoped `fetch`. This design does not use it, but it means "a plugin
  cannot reach the network" was never the rule; the rule is that it never holds
  the gateway's own `HttpClient`.

## The decision: invert, as the codec does

Each OAuth step is an **async generator that yields described requests and
receives responses**. The host performs every request.

```ts
type AuthStep<T> = AsyncGenerator<AuthRequest, T, AuthResponse>;
// AuthRequest  = { url, method, headers, body? }  — the CodecHttpRequest shape
// AuthResponse = { status, headers, body }        — body as text, already read
```

Chosen over the two alternatives for one reason: **it keeps one mechanism.** A
plugin author who has written a codec already knows this shape, and rule 15 keeps
its "never `HttpClient`" without gaining a footnote. The alternatives were an
origin-scoped `HttpClient` — which would have been a second exception to state —
and the plugin using its `net:outbound` `fetch`, which loses header order and so
would let a provider authenticate with a different client identity than it infers
with. That mismatch is a louder signal to an upstream than either call alone,
which is exactly why `OAuthDeps.http` is order-preserving today.

**A generator rather than a build/parse pair**, because the pair cannot express
what the shipped flows do. Measured:

| step | requests | note |
|---|---|---|
| `anthropic.start` | 0 | pure |
| `grok.start` | 1 | OIDC discovery, then builds the URL locally |
| `kilo.begin` | 1 | |
| `kilo.exchange` | **2** | polls for a token, then reads the org id **with** it |
| `exchange` / `refresh` / `usage` elsewhere | 1 | |

`kilo.exchange`'s second request depends on the first response's body, so a
single build/parse pair per step is not enough. Yields are **capped per step** —
a plugin must not be able to hold a connect flow open indefinitely.

## What the host supplies, and why each one exists

Beside the request-performing itself, four helpers on the step's input. Each is
here because the plugin cannot or should not do it:

- **`fail(code, message, opts?)`** — constructs the `GatewayError`. See below;
  this one fixes a live defect rather than serving OAuth.
- **`pending(reason)`** — the device-poll "not approved yet" signal. Today that
  is a `GatewayError` carrying a private marker symbol that a plugin has no way
  to set, so without this a device flow cannot say "keep polling" at all.
- **`pkce()`** and **`randomState()`** — so a plugin needs no crypto, and its
  `start` stays testable. `packages/control/src/oauth/pkce.ts` is 21 lines and
  already shared by every flow.

`start` is **not** required to be pure, and that is a deliberate difference from
`buildRequest`. A codec must be pure because the host may rebuild its request on
every attempt; `start` runs once per authorization, and PKCE requires fresh
randomness by definition.

## `fail()` closes a defect that already exists

`codecAdapter`'s `guard` asks `error instanceof GatewayError` to decide whether a
codec's classification was deliberate. A plugin is installed as a **self-contained
tree** — `packages/control/src/plugins.ts` performs no dependency resolution and
creates no `node_modules`, by construction — so a plugin's server entry carries
its own bundled copy of any class it imports.

**Against a bundled copy that check is false.** A plugin codec throwing
`new GatewayError("AUTH", …)` — which is what a credential with no token should
raise — is read as an unclassified failure and rewritten to `UPSTREAM`. Dispatch
gates its credential-refresh retry on `code === "AUTH"`, so the refresh silently
stops happening, and on a single-candidate pool the request fails outright where
it would have succeeded.

**This is live in the shipped provider capability, not a consequence of this
design.** It is fixed here because this is the sub-project that adds the second
place a plugin classifies an error, and shipping a second one onto a broken first
is how a defect becomes a pattern.

## Origins: making the manifest honest

Today a codec-described URL is checked for being a sendable `http(s)` URL and
nothing else, and the `provider` capability does not imply `net:outbound`. So a
plugin's *own* `fetch` is confined to declared origins while a plugin *provider*
can direct the host's client anywhere — and the destination appears nowhere in
its manifest.

Rule 15 is explicit that this is a guardrail rather than a sandbox, so a
determined plugin was never contained. What is broken is the stated value of the
guardrail: that a plugin's intent is auditable from its manifest. An operator
reading a provider plugin's manifest cannot currently see where their prompts
will be sent.

**The `provider` capability requires `origins`, and both the codec's URL and every
yielded `AuthRequest` URL are checked against it.** The check goes where the host
already validates the URL, so it costs one comparison and no new call site.

## Packaging

**Plugins are authored inside this repository** and shipped as built artifacts
into `<root>/plugins/`. Nothing is published: the types resolve locally at build
time, so `ProviderCodec` and the auth types stay in `@omni/providers` and
`@omni/control` where they are.

`docs/superpowers/specs/2026-08-29-publishing-the-ir-design.md` — publishing the
IR so a *third party* could type against the contract — is **deferred, not
cancelled**, and should be read as the record of a decision rather than as work
queued. It becomes live only if a provider is ever authored outside this
repository.

## Registration

A plugin's `providers` entry gains an optional `oauth` alongside `descriptor` and
`codec`. `readProviders` validates it structurally, field by field, the way it
already validates a descriptor and a codec — nothing is trusted because it
typechecked on the plugin's side.

Both readers then merge it into the map they already pass:

- the gateway, from `loadPlugins` through `installPluginProviders`, before
  `createApp` — the same ordering constraint `registerProvider` already obeys;
- the CLI, from `readPluginProviders`, without running `setup`.

`descriptor.id` must equal the plugin id, as it already must, so a plugin cannot
supply an OAuth flow for a provider it does not own.

## Testing

- **A plugin-supplied OAuth flow completes end to end**, against a stub transport:
  `start` → operator approves → `exchange` → an encrypted credential in the store
  that dispatch can then route on. Anything less tests registration rather than
  the flow working.
- **A two-request step works**, modelled on `kilo.exchange`: the second yielded
  request carries a value read from the first response's body.
- **`pending()` keeps a device poll polling**, and is distinguishable from a
  failure — the case a marker symbol currently carries and a plugin cannot.
- **A codec's `fail("AUTH", …)` survives as `AUTH`** through `codecAdapter`,
  asserted from a *bundled* plugin rather than an in-repo one, since the identity
  of the class is the whole point.
- **A yielded request to an undeclared origin is refused**, and so is a codec URL
  outside `origins`.
- **The yield cap is enforced**, so a flow that never returns is stopped rather
  than holding a connect open.

## What this does not change

- Storage stays host-owned. The plugin returns `FlowResult`; the host encrypts
  and stores it. Unchanged from sub-project 4's decision.
- `OAuthProvider`'s shipped shape for the five built-ins. They keep using
  `OAuthDeps.http` directly; this contract is what a *plugin* implements, and
  converting the built-ins onto it is a separate question with the same
  arguments — and the same evidence — as converting the adapters onto
  `ProviderCodec` had.
- Rule 15. The plugin still never holds an `HttpClient`, which is the whole
  reason the inversion was chosen over the two alternatives.

## Risks

- **A second inverted contract is a second thing to get right**, and it arrives —
  like the codec's optional hooks — with no consumer outside this repository to
  prove it. The mitigation that worked last time was converting a real provider
  early: porting one built-in flow onto this contract before the design is
  called finished would find what Anthropic's conversion found.
- **The generator is more rope than a build/parse pair.** It is justified by
  `kilo.exchange` genuinely needing two dependent requests, but it admits loops,
  which is why the yield cap is part of the contract rather than a later
  hardening.
- **`fail()` and the origins check both change already-shipped behaviour.** Each
  is a fix, and each is the kind of fix that is invisible when it works — the
  tests named above are what make them observable.
