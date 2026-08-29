# Adding a provider

The procedure for adding a provider adapter, and the things the compiler cannot
tell you. Lifted out of [CLAUDE.md](../CLAUDE.md) because it is a checklist you
need on the day you add a provider and never otherwise, and that file is loaded
into every session.

For the boundaries that govern provider code — where wire formats, catalogs and
HTTP may live — see [CLAUDE.md](../CLAUDE.md#architectural-boundaries) rules 2,
8, 9 and 10. [ARCHITECTURE.md](../ARCHITECTURE.md#providers) has the adapter
shape and why the HTTP client is built on `node:http`.

1. Start with the descriptor. **There is no union to edit**: `ProviderId` in
   `packages/ir/src/request.ts` is `string`, because a provider loaded from `<root>/plugins/` has an
   id no compiled-in union could hold. Nothing enumerates the id-keyed maps for you any more, and
   that is the single biggest change to this procedure — an earlier version of this step told you to
   add a union member and let the compiler find the rest, which now finds nothing.
   Five tables list the built-ins by hand and each needs your id: `PROVIDER_DESCRIPTORS`
   (`descriptors.ts`), `ADAPTERS` (`registry.ts`), `PROFILES` (`profile.ts`), `BODY_ORDER`
   (`body.ts`) and `PROVIDER_MODEL_CATALOG` (`catalog.ts`). Miss one and **`tsc` stays green** —
   `Record<string, …>` accepts any subset.
   **`bun run lint` will not save you either, and this is the trap.** Lint catches a *deletion* — an
   entry removed leaves its import unused — but when you are *adding* a provider there is no import
   yet, so there is nothing to be unused and lint passes. Measured by simulating a seventh provider
   with four of the five tables forgotten: typecheck passed, lint passed. The net that actually fires
   is `packages/providers/test/descriptor.test.ts`. `providerCoverage.test.ts` no longer catches a
   seventh provider at all — every assertion in it now passes for any format-valid id, because the
   target union it stood in for is gone. **Run `bun test` before you believe you are
   done**; a green typecheck and a green lint here mean nothing.
   (Worth knowing even for the deletion direction: `noUnusedImports` is a *fixable* rule, so
   `bun run fmt` deletes the orphaned import and takes the lint signal with it.)
   Everything the descriptor holds is required, and that much the compiler *does* ask for in one
   place: capabilities, `writeOverInput`, catalog, model prefixes, and the
   presentation block (label, display order, terminal tone, `--p-<id>` colour in **both** themes,
   paste hint). `callback` is optional and only for a provider using a loopback redirect.
   **The core edit this step used to name is gone.**
   `packages/control/src/schemas.ts` held a two-armed target union whose non-custom arm listed the
   providers by hand, so adding one meant editing it or watching every target using the new provider
   be refused. It is now one schema over `providerIdSchema`, which validates format and not
   membership — so a target naming your provider saves with no edit here at all. What survives is a
   named rule rather than an arm: a `custom` target requires an `endpointId` and nothing else may
   carry one.
   Also runtime-only, measured by adding a seventh provider rather than recalled: hardcoded lists in
   `packages/providers/test/{kimi,custom,kilo,catalog}.test.ts` — three of which carry byte-identical
   copies of the same `Object.keys(ADAPTERS)` assertion — plus `apps/cli/test/commands.test.ts` and
   `packages/dashboard-sdk/test/theme.test.ts`. That last one is the trap: the console derives its
   `--p-<id>` variables from the registry, but the **published** `@omnigateway/dashboard-sdk` lists
   them, so a provider needs its colour added there by hand.
   The free-text `"provider must be one of …"` strings are now derived and need no edit, and
   `proxy.test.ts` is compiler-caught. Beware assertions that still pass by prefix.
2. No store migration. `credentials.provider` is `TEXT` with no `CHECK`, and `providerData` is
   free-form.
3. Directory is `packages/providers/src/<id>/`: `descriptor.ts` the record above, `index.ts`
   transport, `wire.ts` IR to request, `decode.ts` stream to IR, `models.ts` catalog entry,
   `profile.ts` header set and body key order, plus `device.ts` where the provider wants a stable
   client fingerprint. Mint fingerprints synthetically at connect time and freeze them onto the
   credential; never read the real hostname or machine id.
   `descriptor.ts` must not import the adapter, and `profile.ts` must not be imported from
   `descriptors.ts`. Both rules are one rule: `@omni/providers/descriptors` is a leaf the console and
   the pure router bundle for the browser, adapters pull the HTTP client, and profiles read
   `Bun.env`. `packages/providers/test/leafSubpaths.test.ts` enforces it, by import graph and by browser bundle
   together. Its file counts derive from the provider list, so adding one does not fail it.
4. Fork `wire.ts` and `decode.ts` per provider. Never import another provider's directory: vendors
   look alike on paper and diverge in practice, a shared encoder collects a branch per quirk, and a
   cross-provider import is exactly what stops an adapter becoming a standalone plugin later.
   Shared infrastructure stays shared: `parseSse`, `httpError` and `orderHeaders` from the package
   root, `usageFromPromptTotal` from `@omni/ir`. `custom/` is the worked example: it shipped importing kimi's encoder, kilo's
   decoder and openai's responses codec, and paid with a regex rewriting degradation prefixes
   afterwards; it now forks both codecs into its own directory, emits `custom:*` degradations
   natively, and needs no other provider to build.
5. Write `<id>/profile.ts`, exporting `<id>Profile` and `<id>BodyOrder`; the central `PROFILES` and
   `BODY_ORDER` tables assemble over them. State in a comment whether the header set was captured
   from real traffic or constructed, as the kimi profile does. Put any version string the upstream
   gates on behind `env()` so a stale value is an operator fix, not a release, and take those helpers
   from `headers.ts` rather than from `profile.ts` — importing them from `profile.ts` closes a
   module-initialisation cycle whose only symptom is a gateway that will not boot **on installations
   that set an `OMNI_ORDER_*` variable**, because the helpers return their fallback before touching
   the module-scope regex when the variable is unset. The suite stayed green through exactly that.
6. OAuth is optional — `OAUTH_PROVIDERS` is `Partial`. Omit `usage` when there is no quota surface,
   so accounts read as unknown rather than unlimited. Refresh must retain the previous refresh token
   when a response omits one. Endpoints read from OIDC discovery must be validated as HTTPS on the
   provider's own domain before use, and a discovery failure is `UPSTREAM`, never `AUTH` — `AUTH`
   disables the credential.
7. Where a provider serves OAuth and API-key traffic from different hosts, or from different paths
   on one host as `kilo` does, select the URL by credential type in the adapter and assert the split
   in a test. Crossing them surfaces as a billing or entitlement error, which reads as anything but
   a routing bug.
8. A provider that prices by request size cannot be expressed in `ProviderModelPricing`. Pick a
   tier, say so in a comment, and warn operators in `README.md`.
9. Cover streaming and non-streaming, and mutation-test the load-bearing assertions — URL selection,
   usage-token arithmetic, tool call and result round-trip, mid-conversation system placement.
   Verify each anchor fails when its behaviour is broken; a green suite is not evidence of coverage.
