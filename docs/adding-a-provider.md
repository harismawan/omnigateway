# Adding a provider

The procedure for adding a provider adapter, and the things the compiler cannot
tell you. Lifted out of [CLAUDE.md](../CLAUDE.md) because it is a checklist you
need on the day you add a provider and never otherwise, and that file is loaded
into every session.

For the boundaries that govern provider code — where wire formats, catalogs and
HTTP may live — see [CLAUDE.md](../CLAUDE.md#architectural-boundaries) rules 2,
8, 9 and 10. [ARCHITECTURE.md](../ARCHITECTURE.md#providers) has the adapter
shape and why the HTTP client is built on `node:http`.

1. Start at `ProviderId` in `packages/ir/src/request.ts`. Adding a member makes the compiler
   enumerate every exhaustive `Record<ProviderId, …>`; let it drive the work rather than keeping a
   checklist. What it cannot find: hardcoded provider lists in tests (`kimi`, `custom`, `catalog`,
   `proxy`), the dashboard's duplicated `PROVIDER_LABEL`, `PASTE_HINT`, and `PROVIDER_ORDER` maps,
   the `--p-<id>` oklch pair in `theme/GlobalStyle.ts`, and free-text `"provider must be one of …"`
   strings in CLI and control. Beware assertions that still pass by prefix.
2. No store migration. `credentials.provider` is `TEXT` with no `CHECK`, and `providerData` is
   free-form.
3. Directory is `packages/providers/src/<id>/`: `index.ts` transport, `wire.ts` IR to request,
   `decode.ts` stream to IR, `models.ts` catalog entry, plus `device.ts` where the provider wants a
   stable client fingerprint. Mint fingerprints synthetically at connect time and freeze them onto
   the credential; never read the real hostname or machine id.
4. Fork `wire.ts` and `decode.ts` per provider. Never import another provider's directory: vendors
   look alike on paper and diverge in practice, and a shared encoder collects a branch per quirk.
   `custom/` predates this rule and shows the cost — it imports `../kimi/` and `../openai/` and pays
   with a regex rewriting degradation prefixes afterwards. Shared infrastructure stays shared
   (`usageFromPromptTotal`, `parseSse`, `httpError`, `orderHeaders`).
5. Add `PROFILES.<id>` and `BODY_ORDER.<id>`. State in a comment whether the header set was captured
   from real traffic or constructed, as the kimi profile does. Put any version string the upstream
   gates on behind `env()` so a stale value is an operator fix, not a release.
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
