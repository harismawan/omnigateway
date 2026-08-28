# The `provider` plugin capability

A plugin supplies a provider. The host owns every side effect: the HTTP request,
the retry loop, the credential, the deadline. The plugin supplies codecs — how to
build the request body and headers, how to read the stream back — and a
descriptor describing itself.

Sub-project 4. Depends on
[widening `ProviderId`](2026-08-27-widening-provider-id-design.md), which made a
non-literal provider id representable and every registry read call-time. Nothing
in that sub-project created one; this is what does.

## The decision, and what it rests on

Three shapes were considered for a plugin adapter's outbound HTTP:

1. A scoped `HttpClient` restricted to the manifest's `origins`.
2. The real `HttpClient`, with `origins` declared for audit only.
3. **The host performs every request; the plugin supplies codecs only.**

Three was chosen, on the strongest boundary argument: a plugin never holds a
client, so rule 15 needs no exception and "never `HttpClient`" stays true
without a footnote. The stated cost was that a provider needing unusual
transport might not fit.

**That cost was measured before the spec was written, and it is smaller than it
looked.** Every one of the six shipped adapters makes exactly one `http()` call:

| adapter | `http()` calls | lines |
|---|---|---|
| anthropic | 1 | 158 |
| openai | 1 | 60 |
| kimi | 1 | 55 |
| kilo | 1 | 77 |
| grok | 1 | — |
| custom | 1 | 81 |

None retries — dispatch owns that. None makes a second request. None inspects
the socket. `send()` today is already: read the credential, build a body, build
headers, pick a URL, call `http` once, check the status, decode the stream. The
codec contract is not a reduced adapter; it is a description of the adapter that
already exists.

That matters for a reason beyond convenience. Had it fit only plugins, the
gateway would carry two provider shapes — and a rule that holds for one shape
and not the other is precisely the drift this effort has spent three review
rounds paying for. **The contract below is intended to become the shape of every
adapter, built-in and plugin alike.** Converting the built-ins is out of scope
here and belongs with the kilo and kimi extractions, but the contract is
designed so that conversion is possible rather than assumed.

## Where the contract lives, and why not where this spec first said

An earlier draft of this section said the codec type goes into
`@omnigateway/plugin-api`. **It cannot, yet, and the reason is worth stating
because it decides the order of the remaining sub-projects.**

That package is published and has zero `@omni/*` imports by rule: a single one
would put an unresolvable `workspace:*` into a stranger's dependency tree, and
`packages/plugin-api/test/bundleWeight.test.ts` pins it against a real build. The
codec contract is defined in terms of `ChatRequest` and `StreamEvent`, which live
in `@omni/ir` — unpublished until sub-project 7, which was deliberately ordered
*after* the host so that kilo and kimi could prove the shape before it froze.

Mirroring the IR types into `plugin-api` is not an option worth taking:
`ChatRequest` is the largest type in the repository and a second copy of it is
the drift this whole effort exists to remove.

So `ProviderCodec` is declared in `packages/providers/src/codec.ts`, which
already imports `@omni/ir` freely, and `plugin-api` gains only the capability
*name* — a string, no type dependency. The consequence is precise and acceptable:
**an in-repo plugin can be typed against the contract today, a third-party one
cannot until sub-project 7 publishes `@omnigateway/ir`.** Every consumer this
sub-project and the next two have — the fixture plugin, then kilo, then kimi —
is in-repo, which is exactly the ordering that was chosen for other reasons.

The registration hook on `PluginContext` is therefore typed against a structural
interface `plugin-api` can express without the IR: `register` takes a descriptor
and a codec whose functions the host validates at call time. Publication in 7
replaces that with the real types and is a compile-time-only change for in-repo
consumers.

## The contract

Two things the plugin supplies, both pure:

```ts
type ProviderCodec = {
  /** IR plus credential to a single HTTP request. No I/O. */
  buildRequest(input: CodecInput): CodecRequest;
  /** The response stream to canonical events. No I/O. */
  decode(stream: AsyncIterable<SseEvent>, state: DecodeState): AsyncGenerator<StreamEvent>;
  /** Optional. Reads a failed response and returns a better error than the default. */
  classifyError?(status: number, body: string): GatewayError | undefined;
};
```

Three details are load-bearing, and each comes from an existing adapter rather
than from taste.

**`buildRequest` returns state for `decode`.** Anthropic's OAuth leg renames
client tool names to PascalCase on the way out and restores them on the way
back; the restore needs the alias map the build step created. A contract where
build and decode cannot communicate would make that cloak impossible, and the
cloak is load-bearing — RTK normalises by case and separator, so an egress-side
restore silently degrades every shell classification. `CodecRequest` therefore
carries `{ request, decodeState }`, and the host hands the state back verbatim.

**`classifyError` exists because Anthropic already needs it.** Its adapter reads
its own 400 body and reclassifies a fingerprint refusal — Anthropic refuses
certain tool-name sets through a billing placeholder, and `FINGERPRINT_REFUSED`
is what names that. A contract without this hook would move error handling into
the host and lose the one piece of it that is genuinely provider-specific. It is
optional: a codec that omits it gets the host's default `httpError`.

**Nothing in the contract is `async`.** `buildRequest` and `classifyError` return
values; `decode` returns a generator over a stream the host opened. A plugin that
wants to await something has nowhere to put it, which is the point — the absence
of I/O is enforced by the shape rather than by a rule in this file.

## What the host does

Everything else, unchanged from what dispatch does today: choose the credential,
apply the deadline, call `http` with the built request, check the status, throw
the classified error, parse SSE, hand the stream to `decode`, and own every
retry and failover decision.

The plugin's `send` disappears. There is no seam where a plugin could hold the
client, so there is no rule to enforce and no test to write proving it does not.

## Registration

A `provider` capability, added to `CAPABILITIES` in
`packages/plugin-api/src/manifest.ts`. That list fails closed on an unknown name
and is a published compatibility contract, so adding a member is the ordinary
way this is done.

The plugin registers from `setup`, through the context:

```ts
ctx.provider.register({ descriptor, codec });
```

Not a `providers` field on `PluginSetupResult`, which is where routes live. The
distinction is that routes are inert data the host mounts, while a provider must
be in the registry *before* the first request routes — and `setup` runs before
`createApp`, so a capability call makes that ordering explicit rather than
implied by the host reading a return value later.

`descriptor.id` must equal the manifest id. A plugin cannot register a provider
named after another plugin, for the same reason it cannot open another plugin's
channel topic or name another plugin's table: the id comes from the validated
manifest and the host does not take the plugin's word for it.

## What this does not change

Sub-project 3a established that a stored id naming an uninstalled provider is
ordinary state, and every decision it made stands unchanged here:
`provider:missing` at routing, `omni doctor` reporting such targets, `putModel`
and `providerIdSchema` unchanged, `catalogModelAuths` answering "every way in"
for a provider the catalog has never heard of.

Three consequences of a provider that genuinely exists at runtime, all already
paid for:

- Registries are read at call time, so a provider registered during `loadPlugins`
  is visible to routing, pricing and the console without further change.
- Provider-keyed tables carry no prototype, so an id like `constructor` cannot
  answer for a provider that does not exist.
- `dispatch` threads one registry into `resolveModel`, `rank` and `priceOf`, and
  the sentinel test fails if a fourth consumer is added without it.

## Known gaps this sub-project must close

Three items were deferred here explicitly rather than dropped, and each becomes
live the moment a plugin provider exists:

- **`targetSchema`'s non-custom arm is a hand-written five-member enum.** A
  plugin provider's target cannot be saved through `PUT /api/models/:id` or
  `omni models put -f` until it widens. This is the one that would otherwise ship
  a provider nobody can configure.
- **`isProviderIdFormat` has no caller.** Registration is where it belongs, or it
  should be deleted.
- **Four unpinned copies of the provider-id grammar** validate plugin ids
  (`plugin-api/manifest.ts`, `gateway/plugins/routes.ts`, `control/plugins.ts`,
  `store/sqlite/plugins.ts`). A plugin provider's id is a plugin id *and* a
  provider id at once, so the two grammars can no longer be allowed to drift
  independently. One of them should be pinned to `PROVIDER_ID_PATTERN` by test.

## Credentials and auth

Decided earlier in this effort and unchanged: **plugin code, host-owned
storage**. A declarative auth descriptor was shown not to express kilo's flow
(not RFC 8628) or kimi's (device fingerprint bound at OAuth time), so the plugin
supplies the flow as code and the host stores the resulting credential encrypted,
exactly as it does for a built-in.

The shape of that hook is deliberately not designed here. It is a second contract
with its own failure modes, and pairing it with the codec contract in one
sub-project would mean neither gets the scrutiny it needs. **This sub-project
ships providers that authenticate with an API key**; OAuth-capable plugin
providers follow, and kilo — a device flow — is the first consumer that proves
it.

## Testing

- **A fixture plugin registers a provider, and a request routes to it end to
  end**: descriptor visible to routing, codec's request reaching a stub
  transport, its decoded events reaching the client. Anything less tests
  registration rather than the provider working.
- **The sentinel registry test already in `dispatch.test.ts` covers this
  sub-project's riskiest property for free** — a plugin provider is exactly the
  synthetic provider it injects. It should be extended to route through a
  registered codec rather than a stub adapter.
- **A codec that throws, returns a malformed request, or yields a bad event is
  skipped and reported, never fatal** — rule 15, and the proxy path must not
  become able to depend on a plugin.
- **A plugin registering a descriptor whose `id` differs from its manifest id is
  refused**, and the refusal names both ids.
- **The contract is I/O-free by shape**, asserted the way `leafSubpaths.test.ts`
  asserts a leaf: build the plugin-api entry point and check no transport symbol
  is reachable.

## Risks

- **The codec contract becomes a published surface in sub-project 7**, even
  though it is internal today. Getting it wrong is therefore expensive in a way
  an ordinary internal shape is not, and the mitigation is the ordering already
  chosen: kilo and kimi are extracted onto it before anything is published.
  Until then, a third-party plugin cannot supply a provider at all — which is a
  real limitation of this sub-project and should be said plainly rather than
  discovered.
- **`decodeState` is an escape hatch.** It exists for the Anthropic cloak and is
  typed as the codec's own concern, which means a plugin can put anything in it.
  That is acceptable — it never leaves the codec — but it must not become the
  channel by which a plugin smuggles a client or a store handle into `decode`.
  The type should be `unknown` to the host and never inspected.
- **Converting the built-ins is not free**, and this spec deliberately does not
  do it. Until they convert, `ProviderAdapter` and `ProviderCodec` coexist, which
  is the two-shapes risk named above — bounded, because the conversion is
  scheduled rather than hoped for, but real while it lasts.
