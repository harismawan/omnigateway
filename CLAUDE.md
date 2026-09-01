# OmniGateway Repository Guidance

Agent guidance for repo work: architecture, boundaries, conventions, durable traps.
`README.md` serve operators; `ARCHITECTURE.md` explain how system fit together; this file serve
contributors. Update all that change touch.

## Scope

OmniGateway = Bun/TypeScript monorepo for self-hosted AI gateway:

- `apps/gateway`: Elysia gateway + long-lived process loops
- `apps/dashboard`: admin console served by gateway
- `apps/cli`: local `omni` CLI
- `packages/control`: admin ops shared by gateway routes + CLI
- `packages/dashboard-sdk`: what plugin UI bundle build against
- `packages/ir`: provider-neutral domain model
- `packages/plugin-api`: pure plugin manifest schema, context + event types
- `packages/providers`: provider adapters + catalog
- `packages/router`: pure routing
- `packages/ratelimit`: pure API-key limit eval + sliding-window counting
- `packages/rtk`: tool-result filters, applied in dispatch before routing
- `packages/ponytail`: vendored lazy-senior-dev ruleset, appended to system prompt in dispatch
- `packages/store`: persistence + encryption
- `packages/testkit`: shared test fixtures

Approved designs in `docs/superpowers/specs/`; matching plans in `docs/superpowers/plans/`. Read
spec before change, but verify current code — plans record past intent.

## Commands

Use Bun from repo root:

```bash
bun install
bun run dev              # gateway with file watching
bun run start
bun test                 # excludes dashboard tests
bun run test:all         # both suites; what CI runs
bun run typecheck        # core and dashboard
bun run lint
bun run fmt
```

Dashboard:

```bash
bun run dev:dashboard              # Vite on 5173, proxies /api and /health to 9000
bun run build:dashboard            # writes apps/dashboard/dist
bun run --cwd apps/dashboard test  # happy-dom suite excluded from root tests
```

CLI + release:

```bash
bun apps/cli/src/index.ts --help
cd apps/cli && bun link
omni doctor --root <install>
bun run build:npm v1.2.3
```

Push `v*` tag run `.github/workflows/release.yml`; tag = sole version source. Before claim done: run
focused changed-behavior tests, full `bun test`, dashboard suite, `bun run typecheck`, `bun run lint`,
`bun run check:claims`, `bun run check:dead`. **Last two were missing from this line and CI run
them**, so a branch could pass every command named here and still fail `verify` — which it did, on a
doc comment naming a symbol the same commit deleted. The set here is what `.github/workflows/ci.yml`
run; when that file gain a step, this line gain one.

## Architectural boundaries

1. `packages/ir` stay provider-independent + side-effect-free. Inject clocks + logger sinks; never
   import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, model catalogs stay in
   `packages/providers`. Within it, an adapter never import from another provider's directory —
   shared helpers live at the package root (`http.ts`, `sse.ts`, `types.ts`), and codecs a provider
   needs are forked into its own directory even when near-identical. This is what lets each
   provider become a standalone plugin later without dragging the others along; `custom/` is the
   worked example (own chat + responses codecs, forked from kimi/kilo/openai).
3. `packages/router` stay pure: no network, database, token refresh, timers.
4. Dispatch own side effects, retries, refresh, deadlines, failover, stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` know nothing about caller type: no Elysia, cookies, argv, terminal, timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows + secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
8. All outbound provider HTTP use `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` and `/descriptors` must stay leaves: model lists, presentation, types.
   No longer because a browser import them — console read provider data over `GET /api/catalog`
   now — but because pure `packages/router` import `descriptors`, and leaf property is what let it.
   `packages/providers/test/leafSubpaths.test.ts` still pin both.
10. Catalog pricing give defaults. Router price from saved targets; catalog edits hit new targets
    only.
11. CLI administer local installs through `@omni/control`, never `/api/*`. Inject every side effect
    so tests never start processes or write outside temp dirs.
12. Dashboard call `/api/*` only — which now include the one WebSocket, `/api/stream`. One
    exception: `/health`, polled to watch gateway leave and return
    across restart. During restart no session and no authenticated surface to probe, so liveness is
    the one question `/api/*` cannot answer. May import `@omni/store/types`, `@omni/ir`,
    `@omnigateway/dashboard-sdk`, but **not** `@omni/providers` — neither subpath, not even the leaf
    ones — nor provider adapters, HTTP client, runtime store code. Allowlist once held `catalog` and
    `descriptors`, and lost both when provider data moved onto `GET /api/catalog`: a provider loaded
    from `<root>/plugins/` at boot exist only at runtime, so **no build-time import can reach it**,
    and a console that import its providers can route to a plugin provider while showing it nowhere.
    Mirror wire shape in `api/types.ts` like `PluginCatalogEntry` already do; never import it back.
    `ProviderId` still come from `@omni/ir` — one definition — but provider **list, order, label,
    colour, models** now all come from the response, and `theme/tokens.ts` hold no provider list.
    Shell gate in `routes/_app.tsx` make that safe: `beforeLoad` resolve catalog **after** session
    check (admin-gated route, so unauthenticated path must never ask) and before any screen mount, so
    `--p-<id>` exist at first paint and no board need a loading state for provider data.
    Gate is all-or-nothing, so its `errorComponent` must render error **with retry** — never spinner,
    never blank — and must not swallow `redirect` an expired session throw. Pinned by
    `apps/dashboard/test/routes/appGate.test.tsx`. SDK permitted because alternative was second copy
    of rule about what may leave plugin's
    own API prefix — rule held in two places is one that end up true in one. Same argument later
    moved LIVE switch there: which control pause polling is a rule too. `usePluginChannel` join it
    for a third: panel hold `plugin:<id>:<name>` on console's own socket, and topic that is not in
    any compile-time table is exactly the case console's `RES_TOPICS`/`STREAM_TOPICS` cannot serve.
    Hook compose topic from `pluginId` it is handed. That is **ergonomics, not boundary**, and it
    resemble the server-side rule closely enough to be read as one: there host write prefix from
    validated manifest and plugin cannot reach another's namespace, here a panel spelling another
    plugin's topic by hand is **authorised** — `authorised` grant admin every *opened* plugin topic
    and ask nothing else. Not a hole hook could close: panel bundle already run in console's page
    with operator's cookie and can open own socket, which is rule 15's guardrail-not-sandbox one
    step further out. Say it that way; earlier version of this line claimed host would refuse, and a
    contributor who believe it treat cross-plugin subscribe as impossible when it is one line.
    It ride `LiveContextValue.channels`, **not** a second
    SDK context and **not** `LiveConnection`: that object rebuilt per transition to defeat
    `useSyncExternalStore` identity bail-out, so subscribe function on it re-subscribe every reader
    on every drop. `channel.ts` therefore import React and hold no `createContext`, and
    `packages/dashboard-sdk/test/package.test.ts` pin **both** halves — allowlist of modules that
    may import React, and the separate rule that exactly one module create a context. Second is the
    silent one. SDK **no longer** leaf with
    no imports — `live.ts` import React — so it now in `SHARED_IMPORTS`, one copy served to console
    and every panel. Order load-bearing: SDK holding a context but bundled per plugin give each its
    own `createContext`, and panel reading that one find no provider, take "polling off" default,
    never poll again, silently. Never ship half.
13. `packages/rtk` stay pure like `ir` and `router`: no I/O, clocks, randomness. Rewrite tool-result
    content only, preserve errors + non-tool-result blocks. `@omni/rtk/catalog` is leaf holding
    filter-id union; `@omni/store` import that subpath alone.
    `packages/ponytail` sit beside it under this same rule and **is deliberately not a fourteenth
    number** — it is the other pure dispatch-time request transform, so it live where a contributor
    changing one already read the other. Same purity, and it **return a new request** rather than
    edit the one it is handed. `@omni/ponytail/catalog` is leaf holding the mode union; `@omni/store`
    import that subpath alone and re-export `PonytailMode` from `@omni/store/types`, the import
    dashboard already permitted. Ruleset text **vendored and pinned**, never fetched: a prompt that
    change under an installation is one no operator can reproduce a bill from.
14. `packages/ratelimit` stay pure same way; `now` always a parameter, counters supplied by caller,
    so package never learn where they came from. `@omni/ratelimit/catalog` is leaf holding dimension
    + window unions, `LimitConfig`, its zod schema; `@omni/store` import that subpath alone and
    re-export `LimitConfig` from `@omni/store/types`, the import dashboard already permitted.
    Limiter state — rings + gauges — live in `apps/gateway`, because state not package's job.
    `@omnigateway/plugin-api/events` **mirrors** the unions and `WINDOW_MS` rather than importing
    them, because that package published and this one not. This package stay source of truth; mirror
    pinned by `apps/gateway/test/plugins/limitVocabulary.test.ts`, only place that may import both.
15. Plugins load from `<root>/plugins/` at boot, receive capability-scoped `PluginContext`: never
    `Store`, `HttpClient`, `AdminAuth`, `process.env`. **It is a guardrail,
    not a sandbox** — plugin share gateway's process and can import past all of it. What it buy:
    accidental overreach impossible, plugin's intent auditable from manifest. Say that plainly
    wherever it come up; reader who believe otherwise make worse decisions than one who know.
    **One exception, and it is real: a plugin supplying a provider receive the decrypted credential
    for its own provider.** `codec.buildRequest` get `{accessToken, apiKey, providerData}` straight
    from `credential.openForInference()`, because a codec that cannot authenticate cannot build a
    request. **Its `oauth` flow reach the same class of secret by a second door**: `refresh` receive
    the decrypted **refresh token** and `usage` receive the access token through `UsageSecrets`. Say
    both — this bullet named the codec alone for the release in which the auth half landed, which is
    the narrow-statement version of the mistake the next sentence warn about.
    Bounded three ways: router only produce candidates for that codec's own provider id and the
    refresher only hand a credential to its own provider's flow, so a plugin see its own provider's
    secrets and no other; neither codec nor flow hold the client or the store, so they cannot send
    them anywhere the host did not ask for; and every URL either one name is checked against the
    manifest's `origins`, so where a secret may travel is readable without running the plugin. This list read as unconditional
    for one release after that stopped being true — a rule stated wrong is one a contributor
    preserve while breaking the real thing, so state the exception rather than the tidy version.
    `packages/plugin-api` stay pure like `ir`; loader, context, event bus, channel registry live in
    `apps/gateway`. Every load failure skipped and reported, never fatal: proxy path depend on no
    plugin and must not become able to. `channels` capability give plugin `open(name)` and nothing
    else — never a socket, upgrade request, header or `Principal`. Topic is `plugin:<id>:<name>`
    with `<id>` from validated manifest, so plugin cannot name another plugin's topic, same rule
    `{{name}}` follow for its tables. Registry answer what **exist**; `authorised` in
    `routes/stream.ts` decide who may hold it, so opening channel never widen plugin's own reach.
    Outbound frame reuse socket registry's own bounded per-connection queue — no second queue, and
    nothing here touch `Store`.
16. **No provider-specific code in a core module.** Aim, not achieved state, and the difference is
    stated here because an earlier version of this bullet claimed the clean version and a reader can
    disprove it in one grep — after which the rest of this file reads as decoration.
    Measured, package by package, because "clean" written from memory is how the last version got it
    wrong — and this paragraph's first draft repeated the mistake inside the commit correcting it.
    `ratelimit`, `rtk` and `ponytail` are clean of both. `ir` hold no per-provider data and branch
    on no provider id; its only mention in code is `LogFields.surface` (`"anthropic" | "openai"`), which this rule
    name as permitted vocabulary. `store` branch on no provider id, but `bodies/mask.ts` **do** hold
    per-provider data — the `xaiKey` rule and vendor key prefixes — which the redaction paragraph
    below require stay in core, so it is a carve-out this rule make on purpose rather than a
    violation. `router` has one branch: `resolve.ts` excludes `custom` from prefix routing, because a bare
    model name cannot carry an endpoint id. `control` has three things and one of them is large.
    Two branches — `schemas.ts` name `custom` in the one rule that survive its target union (a
    custom target carry an `endpointId` and nothing else may), and `credentials.ts` plus `models.ts`
    ask `=== "custom"` about endpoint metadata. That is now **all** control hold. The OAuth
    subsystem used to be the third thing and the large one, and it is **gone from core**:
    `OAUTH_PROVIDERS` is an empty null-prototype registry that `registerOAuthProvider` fill, the
    five vendor module live at `providers/src/<id>/oauth.ts`, and `builtinOAuthFlows()` in
    `@omni/providers` is the one list. Do not re-add a literal: a built-in reaching the
    registry any way a plugin cannot is the shape this took three release to undo.
    `seedBuiltinOAuth()` fill it, from **`installPluginProviders`** on the gateway and from
    `apps/cli/src/run.ts` on the CLI, because `omni connect` run without a gateway. It sat inline
    in gateway `main()` first, and that is the trap: **no test call `main()`**, so the only guard
    was a test grepping the source, and a substring match pass on a commented-out call — measured,
    commenting it out left all 3347 test green while a booted gateway would have had no OAuth at
    all. It live on `installPluginProviders` because that function is called unconditionally at
    boot and is reachable from a harness.
    **Moving it there was not enough, and the second failure is the more instructive one.** The
    replacement guard read `OAUTH_PROVIDERS` — process-wide module state, one Bun process for the
    whole suite — so `logging.test.ts` and `apps/cli/test/connect.test.ts` seeded first and the
    assertion pass on *their* seed. Measured: deleting the seed left `bun test`,
    `bun test apps/gateway` and `bun test packages/control` green; only that one file alone caught
    it. A module-scope `seeded` boolean made it unfixable in place — it latch, so clearing the table
    do not help. Registry is therefore **threaded**: `registerOAuthProvider`, `seedBuiltinOAuth` and
    `installPluginProviders` all take one, defaulting to the global, and the test drive
    `Object.create(null)`. Thread it through **all** of a call graph or none — partial threading is
    the bug this repository repeat most.
    Idempotence is a `WeakMap` of **which id we installed into which registry**, and the second
    iteration matter: a `WeakSet` of seeded *registries* make a deleted built-in unrecoverable —
    measured, a reseed leave it at four provider — so "nothing ever delete a built-in" become a
    load-bearing unstated invariant while two test file delete from the shared registry in
    `afterEach`. Recording id let a reseed tell three case apart: ours and present (skip), ours and
    gone (reinstall), someone else's (throw). Repair restore **membership, not position** — object
    key order is insertion order, so a repaired id land last; production never delete one, so the
    order an operator see is the seed's own.
    Seeding that late is safe only because every consumer take the registry **by reference and read
    at call time**, and because `loadPlugins` — which run *before* it — register no flow: the shadow
    refusal in `readProviders` consult `PROVIDER_DESCRIPTORS`, and the only `registerOAuthProvider`
    on this host sit in the loop after the seed. A loader that ever register a flow move the seed
    ahead of it.
    `installPluginProviders` must stay **unconditional**: wrapping it in
    `if (providers.length > 0)` kill OAuth on every plugin-less install, which is most of them — a
    tidy-up the function's own name invite, since the seed is the part of it that is not about
    plugins. That edit left the suite green when it was first measured; `oauthSeed.test.ts` now
    catch it, single-line and block form both, by asserting the call sit at **two-space indent** —
    a top-level statement of `main()`. Indentation heuristic, said out loud as one: biome fix the
    indent so it hold, and a reformat fail loudly rather than pass quietly, which is the safe
    direction for a check standing in for a booted-gateway test. Its `|| Object.hasOwn(registry, id)` disjunct is
    **defence-in-depth, not coverage**: every seeded id is in `PROVIDER_DESCRIPTORS` too and a
    plugin enter both table in one iteration, so the first disjunct always fire first. An earlier
    version of this line claimed that check "stop being vacuous"; measured false.
    Seed **order is the operator-facing order** — anthropic, openai, kimi, kilo, grok —
    because `oauthProviderIds` derive from `Object.keys` and that list is the sentence
    `omni connect` refuse an unknown provider with; **`apps/cli/test/connect.test.ts`** match it by
    equality for that reason, and `apps/gateway/test/plugins/install.test.ts` pin it as a literal.
    Never pin it against `builtinOAuthFlows()` — that is the same source a mutation edit, so a
    dropped or reordered provider satisfy it. Registry empty until seeded, so any test reading it
    **seed first**, never rely on another file in the same run having done it;
    `providerCoverage.test.ts` broke that rule in the very commit that wrote it and pass green over
    an empty set when run alone.
    Contract live in `providers/src/oauthFlow.ts` beside the flow written against it, with
    `oauthRequests.ts` and `oauthUsage.ts`; `@omni/providers` therefore carry `@omni/store` as a
    dependency, **type-only** — `import type` from `@omni/store/types` for `CredentialSecrets`,
    `UsageSecrets`, `WindowType`. **Nothing enforce that type-only-ness by itself.** An earlier
    version of this line claimed `leafSubpaths.test.ts` would catch a value import; that was
    measured false — turning one into a value import leave the whole suite green, because those
    module are outside both leaf graph regardless of import kind. What enforce it is
    `packages/providers/test/oauthStoreEdge.test.ts`, which assert the package's own entry point
    pull no runtime edge to `@omni/store`. Direction hold: store not depend on providers.
    Host keep the mechanism — `pluginFlow.ts` (`oauthAdapter`), `pending.ts`, `refresh.ts`,
    `pkce.ts`, `lead.ts`, and `types.ts` for the adapted `OAuthProvider` shape every consumer
    already take as parameter.
    Adapter is host's because it hold the transport, enforce origin check, yield cap and
    return-shape validation, and stamp `gatewayAuthored`. A package adapting its own flow would need
    the client rule 15 exist to keep out of it.
    Plugin flow follow the codec's inversion: each
    step is an async generator that **yield described requests**, host perform every one, so plugin
    never hold `HttpClient` and rule 15 need no second footnote. Generator not build/parse pair
    because `kilo.exchange` is two request where second carry a token read from first — measured,
    not assumed. Yield **capped** per step: generator can loop, and device poll already looped by
    host. `fail`, `keepPolling`, `pkce`, `randomState` supplied by host — `keepPolling` named that
    way because `exchange` already receive `pending: PendingFlow` and one name for two thing in one
    argument object is how author reach for wrong one.
    **Porting the five found three thing the fixture could not**, each because a fixture written to
    fit a contract cannot disagree with it. Built-ins use **two** deadline — 30s for a token call an
    operator wait on, 15s for a usage probe nothing wait on — so `AuthRequest.timeoutMs` is optional
    and clamp to the host ceiling; one constant would have quadruple the second silently. A
    delegated step must be `async function*`: a sync generator yielded through from an async one
    run fine, every test pass, but `TNext` widen to `AuthResponse | undefined` and only the compiler
    see it. And `PluginOAuthFlow` is a **discriminated union** with `oauthAdapter` overloaded on
    `kind`, because the flat shape flatten the return type — `kiloOAuth` stop being a
    `DeviceOAuthProvider` and every consumer reading `begin`/`needsDeviceId` lose it.
    `requests.ts` hold pure builder that **replaced** `postJson`/`getJson` — same profile, same merge
    and order, stopping before the send — so ported flow emit the byte its own golden test already
    pin. Those two were deleted once the last flow stopped calling them: an exported, tested way to
    send with `deps.http` directly is a way to bypass the yield cap, the origin check and the
    return-shape validation the adapter exist to impose, and none of those absence is visible at the
    call site.
    Each provider's test file is **unchanged**, which is the proof; mutant against all five (dropped
    `client_id`, dropped beta header, state check off, kilo's second request unauthenticated, kilo's
    org read skipped, grok's host check off, kimi's device headers dropped, openai's content type
    changed) each kill test — verified by mutation from the new location, not assumed. Two file
    change beyond their import line: kimi's registry test, which now read the seed's own result, and
    grok's, whose `OAUTH_PROVIDERS.grok === grokOAuth` became `x === x` once `builtins.ts` defined
    one as the other. They stay in
    `control/test/oauth/` after the move rather than travelling
    with the flow, because they drive the **adapted** provider and `oauthAdapter` is control's —
    a test in `packages/providers` reaching for it would invert the package graph. They read the
    five through `test/oauth/builtins.ts`, which take them off the **seeded registry**: strictly
    stronger than the named import it replace, since a seed that drop one, install the wrong flow or
    forget `trusted` now fail all five suite rather than one wiring test.
    Nothing above is licence to add a fourth. New provider knowledge in core still go through the
    three outcomes below. The union itself is **gone**: its arms were hand-written for
    exhaustiveness over a closed `ProviderId`, that closed type no longer exist, and the enum
    outlived the argument for it while refusing every target naming a plugin-supplied provider. A
    provider's data live in its own descriptor; core read the registry it is handed. Core cannot
    scan providers — `packages/providers` import `@omni/ir`, so reverse import is a cycle, and rules
    1 and 3 forbid it anyway. Injection is the only direction.
    Three outcomes when core seem to need provider knowledge, in this order: **descriptor data**;
    **make the value carry its own provenance** so the branch delete; **a named extension point**
    from the closed set. Prefer deletion — branch that not exist cannot drift, and need no contract,
    no registration, no test. `providerNative` is the worked example: block already generic escape
    hatch wearing one vendor's name, so tagging it with producing provider let routing rule read off
    data and delete `needsAnthropicNative`, `ANTHROPIC_NATIVE_TOOLS` and the table read inside pure
    router. Hook set is **closed**; growing it need a specific core site, a provider that cannot work
    without it, and no self-describing alternative. `LogFields` never extensible — closed allowlist
    and redaction boundary. `servesTarget` stay one rule in `@omni/store/types`, because five sites once
    asked that question separately and three asked less than the router did. It consult **no**
    descriptor and import nothing from `@omni/providers` — that would be the cycle rules 1 and 3
    forbid. It name no provider either: rule is "target naming an endpoint is served only by account
    at it", which cover `custom` without saying so.
    **Redaction never becomes extensible**, same family as `LogFields` and for the same reason.
    `MASK_RULES` in `packages/store/src/bodies/mask.ts` keep its `xaiKey` rule and its vendor
    prefixes in core, and a provider **not** supply its own pattern: a descriptor-supplied regex is a
    provider deciding how much of its own secret survive into captured bodies, and the direction that
    go wrong is silent. Gap is narrow by construction — `PREFIXED_KEY` and `OPAQUE` already catch
    ordinary `xyz-…` key shapes, so new provider is covered, only not optimally. Adding a vendor rule
    is a core edit and should read as one.
    What core keep is provider-shaped **vocabulary**, not provider **logic**: `ErrorCode`,
    `LogFields`, `StopReason`, `CacheControl.ttl`, `AuthType`, `WindowType`, `surface`,
    `AnthropicToolFamily`. Provider needing new member of those edit core, by design — that is a
    provider extending what gateway can *express*, not one the contract cover. Say that boundary
    plainly rather than claim "no core edits"; unconditional claim is one a reader disprove in a
    minute and then trust nothing else.
    Trap this rule exist for: `autoCache` is **one boolean across six core files** —
    `providers/types.ts`, `store/types.ts`, `control/schemas.ts`, `dispatch/index.ts`,
    `dispatch/attempt.ts`, `SettingsBoard.tsx`. Nobody added six files on purpose; each step looked
    small. Design:
    [core/provider decoupling](docs/superpowers/specs/2026-08-27-core-provider-decoupling-design.md),
    [descriptor registry](docs/superpowers/specs/2026-08-26-provider-descriptor-registry-design.md).
17. **`Principal` and `Scope` in `@omni/control` are the only copy of "who is asking" and "what may
    they read".** Four principals — `admin`, `viewer`, `client`, `machine` — share **one cookie**,
    so `AdminAuth.verify` return the principal, never a boolean: a caller that forget to check the
    kind then hold a value it cannot mistake for permission. `stream/registry.ts` re-export the
    union rather than declaring one. `scopeOf` is the single site turning a principal into a filter;
    never narrow locally, however small the local question look — same rule `servesTarget` follow.
    Guards are **opt-in per route**, never applied to a group: `requireAdmin` (operator alone, and
    its meaning unchanged from when it guarded everything), `requireReader` (admin|viewer),
    `requireClient`. A group guard is one a later route join by being written in the wrong place,
    and that failure is silent in the widening direction. A GET nobody remember to widen stay
    admin-only, which is the harmless way to be wrong. Mutations, snapshot download,
    `/api/connect/*` and `/api/plugins` stay `requireAdmin` — a read-only administrator who could
    add a credential is not read-only.
    Trap this rule exist for: `scopeOf` mapped `machine` to `{kind:"key", apiKeyId:""}` meaning
    "matches nothing". **`usage_daily.api_key_id` is `NOT NULL DEFAULT ''`**, so anonymous traffic
    live under the empty string and that scope read every untagged row at the `daily` grain — while
    reading, in source, exactly like a scope matching nothing. `request_logs.api_key_id` is NULL and
    `= ?` never match it, so the `raw` grain hid the `daily` one. The test written beside it
    asserted `scopeKey(scope) === ""` and called that fail-closed, so suite encoded same wrong
    assumption as code and went green. `Scope` now carry a `none` arm and `readsNothing` gate both
    readers **before** `scopeKey` — which collapse `all` and `none` to the same `undefined`, and one
    of them mean every row. Client surface own no body route: **absent, not refusing**, because a
    route that exist and refuse is one somebody later make conditional. Design:
    [client dashboard surface](docs/superpowers/specs/2026-08-27-client-dashboard-surface-design.md).

## Adding a provider

Nine-step procedure in [docs/adding-a-provider.md](docs/adding-a-provider.md): what compiler
enumerate for you, what it cannot find, per-provider files, why `wire.ts` and `decode.ts` forked not
shared. Read before adding one — several steps exist because skipping them made bug that read as
something else entirely.

## Writing a plugin

Procedure in [docs/writing-a-plugin.md](docs/writing-a-plugin.md): manifest, capability context,
storage placeholder, event guarantees, how UI bundle share console's React. Read before adding or
reviewing one — it open with what plugin can reach, which decide whether rest of it good idea.

## TypeScript and dashboard style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, tests included. Use `unknown` plus narrowing or named types.
- Use ESM imports with explicit `.ts` extensions. Match nearby naming + comment density.
- Biome use 2-space indent, 100-column lines. Avoid unrelated refactors.
- Dashboard use styled-components, never Tailwind or CSS files.
- Palette CSS variables live in `theme/GlobalStyle.ts`; `theme/tokens.ts` reference them.
- Colour mean provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores, synthetic credentials, stub `HttpClient`; never call live providers.
- Dispatch or adapter changes cover streaming + non-streaming paths.
- Preserve pre-commit failover versus post-commit stream behavior.
- Shared proxy changes test Anthropic + OpenAI error surfaces.
- Auth changes cover Bearer and `x-api-key`, malformed/conflicting input, revoked keys, allowlists,
  relevant rate limits.
- Deadline tests distinguish gateway timeout from client cancellation, leave no timers/listeners.
- Dashboard tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`,
  `renderWithRouter`; assert visible text, roles, accessible names. Re-query after async loads.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- **`fields?: LogFields` did not enforce the allowlist, and the gap was not theoretical.** A closed
  object type is enforced by *excess property checking*, which apply only to a fresh object literal —
  so `{ plugin, ...(cond ? {} : { detail }) }` and `logger.info("m", wider)` both compile clean,
  measured against `tsc`. The conditional spread is how it was found: it is the natural way to write
  an optional field and the compiler agree with it. `Logger` method now take
  `<T extends LogFields>(msg, fields?: OnlyLogFields<T>)`, which make every key outside the
  allowlist `never`, so both spelling fail. Pinned by `packages/ir/test/logFields.test.ts` with
  `@ts-expect-error` — relaxing the signature make those directive unused, which is a *typecheck*
  failure, and a runtime test could not see this at all because the field would simply print. This
  do **not** make `LogFields` extensible; it move enforcement from review to compiler.
- `LogFields` is closed allowlist + redaction boundary. Treat new free-text fields as security
  changes; never add index signature.
- **`GatewayError.gatewayAuthored` is the second half of that boundary, and it is opt-in on
  purpose.** `reasonField` withhold a failure's message from stdout unless debug is on, because
  `httpError` fill one from up to 500 characters of an upstream body and a context-length refusal
  echo prompt text into it. It used to infer that from `provider !== undefined`, on the premise that
  `httpError` set that field and nothing else did — true when written, false the moment codec errors
  named their provider, which is what make them actionable. So naming the provider **silenced the
  sentence naming it**: a plugin codec throwing on every request logged `code=UPSTREAM` with no
  reason, indistinguishable from an outage. Flag default **false** and each site opt in. The
  opposite spelling — a `quotesUpstream` every upstream-quoting site must set — was written first
  and abandoned: it need all ~180 construction sites audited correctly and one miss put a prompt on
  stdout, and five tests immediately named real sites building messages from upstream bodies without
  going through `httpError` (decoder terminal event, OAuth refresh, proxy refusal). Set it only for
  a message built from literals and values this repository own. **Never** for one carrying an
  upstream body, and never for one authored outside this repository — a plugin codec's own text is
  unknown exactly the way a body is, which is why `rebound` not set it and `codecFailure` do. It
  must survive re-wraps like `provider` do: `classify` and dispatch's `rewrap` both rebuild the
  error, and dropping it there make the flag inert on the only path reaching an operator.
- Return raw gateway API keys once; store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows, and
  the two password routes below, which end sessions **by design**.
- **Two passwords, and neither have a default.** Admin password set once at `/api/setup`, replaced
  at `PUT /api/settings/password` — which require the **current** one, because admin session is a
  cookie in a browser that may sit unattended and a cookie that rewrite the credential behind it
  turn "left tab open" into "locked out". Success clear **every** session, caller's included, so
  console send operator to `/login?reason=password-changed` rather than refetch on a dead cookie.
  Wrong current password answer exactly like a failed login — whether it was right is the one bit
  that route must not leak to a stolen cookie.
  Read-only (viewer) password is **optional and absent by default**: no row, `passwordMatches(null,
  …)` refuse everything including empty string, `viewerConfigured` false, login screen not offer the
  mode. `PUT /api/settings/viewer-password` set/replace it; `{"password": null}` withdraw it and
  **delete** the row — empty string would be a hash verifying nothing while `isViewerConfigured`
  still report it set. Absent field is `BAD_REQUEST`, never a quieter spelling of removal. Setting
  or clearing it drop **viewer** sessions only: withdrawing someone else's access have not changed
  the operator's own credential.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, errors
- `GET /v1/models`: authenticated, filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

`/api/client/*` is the key holder's own read surface: `login`, `logout`, `summary`, `usage`, `logs`,
`quota`, `quota/history`. Scope come from the verified session, never from a query parameter — the
two arrive as separate arguments because they have separate provenance, and one door for both is how
a client come to choose its own. Client session re-read its key row on **every** verify and refuse a
revoked one; one checking at login alone outlive a revocation by the session TTL.

Provider quota reach a client as **named accounts**. `accountQuota` return one row per
credential+window carrying the operator's own `label`: a deliberate widening — a screen that
collapsed a provider's accounts could not say *which* account was filling up — so every key holder
learn how many accounts this install run and what they are called. `usedRatio` and
`ratePerHourRatio` are fractions in `0..1` of that window's own ceiling, because `formatPercent`
multiply by 100 and a 0..100 field render as `4200%`.
**The ceiling behind those fractions is derivable, and that is accepted, not defended.** `usedRatio`
is the exact quotient of two provider integers, recoverable in lowest terms by continued fractions,
and `exhaustsAt` give it a second way — it is `observedAt + ((limit - used) / ratePerHour) * HOUR`,
so with `resetsAt`, `windowMs` and `windowType` it reduce to `(limit - used) / used`. Rounding was
tried and **does not work**: it leave `exhaustsAt` untouched, and rounding to a thousandth is the
identity whenever the ceiling divide 1000, which the small ones do. Never reintroduce a rounding
step and claim size is withheld — that claim shipped once, was false, and reader who believe it make
worse decisions than one who know. `used`, `limit` and units-per-hour stay off the payload because
the surfaces render percentages, not because they are secret.
`stale` and `rolledOver` arrive as separate booleans and must stay separate — folding them blank a
chart of measured readings for up to a poll interval after every rollover, which is the trap
`quotaRolledOver` exist for. `/api/client/quota/history` is the same disclosure over time, one
series per account and window, and carry **no gateway rate**: that aggregate cover every key on the
installation, so it answer a question about the operator's traffic, not this client's. The pair of
e2e tests in `clientSurface.test.ts` hold both halves — one assert no credential identity on
`logs`/`usage`/`summary`, the other assert the quota routes *do* name accounts and still omit
`used`/`limit`/`ratePerHour`.

Every `/v1/*` request accept Bearer or `x-api-key`; reject conflicts. `null` model allowlist mean
unrestricted; empty array deny all models.

Preserve these translation invariants:

- Keep mid-conversation system messages in place; never fold into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve + accumulate Anthropic signatures.
- On the way back out, the OpenAI surface renders canonical thinking as `reasoning_content`
  (stream deltas and non-streaming message field — the DeepSeek/OpenRouter spelling); the
  Anthropic surface keeps its full dialect, with unsigned blocks suppressed from stream and
  buffered content alike.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize missing beta.
- `ToolDef` is union. `CustomToolDef` stay portable; `AnthropicToolDef` carry exact versioned `type`
  never normalized or upgraded. Versions in `packages/providers/src/anthropic/tools.ts`; unknown
  dated types rejected, not prefix-matched.
- Provider-native content blocks use `providerNative` IR variant, keep payload verbatim, stay out
  of tool-id correlation, orphan removal, cross-provider translation, RTK. Block carry `provider` —
  who produced it — and that field is what routing read.
- `ToolDef` discriminant is `kind`: `"portable"` (was `provider: "custom"`, colliding with the
  `custom` **provider id** and meaning something else) or `"provider"` plus a real `ProviderId`.
- Provider-defined tool or `providerNative` history block admit **only** that provider's targets at
  routing — today only Anthropic produce either. Replaced "exclude every provider whose
  `ANTHROPIC_NATIVE_TOOLS` entry false", which selected the same targets and needed a table.
  Degradation spelled `excluded:capability:providerNative`; rows written before the rename carry
  `excluded:capability:anthropicTools` and stay readable, because degradations are forensic text
  never parsed on read. Redaction of `credentialId` there read `Excluded.kind`, never the string.
- `pauseTurn` is own stop reason; never fold into `endTurn` or `toolUse`.
- Client tool names renamed to PascalCase on Anthropic **OAuth** leg only, restored in
  `anthropic/decode.ts` — never at egress. Anthropic fingerprint some name sets and refuse them
  through a billing placeholder; `FINGERPRINT_REFUSED` name that. Restore site load-bearing: RTK
  normalize by case and separator alone, so `SessionSearch` never match `session_search` and an
  egress-side restore silently degrade every shell classification. Cloak live in `buildRequest` frame,
  never on `dispatchRequest` — that object shared across attempt, so storing it leak alias into
  next provider. Exempt name (already PascalCase, or `mcp__*`) reach wire unrenamed and therefore
  **claim its spelling**, else derived alias land on live tool's real name.
- Unknown Anthropic block types + SSE events fail visibly, not skipped.
- Preserve cache-control breakpoint block, TTL, order when target can express them. Record
  degradations for requested features provider cannot express.
- **Two exceptions, and only two.** Second is `ponytailMode` in `@omni/ponytail`, below; first is
  this: `autoCacheEnabled` (default **on**) let Anthropic adapter add
  breakpoints to request carrying **none**. Anthropic caching opt-in, so unmarked request pay full
  input price forever however stable its prefix. Trigger narrow and load-bearing — fire only when
  `estimateCachedInputTokens` is 0 *and* no `cache_control` in vendor bag, so client's own placement
  never second-guessed. Up to **three** markers, one rule: walk tier in render order — last tool
  (prefix = tools), last system block (tools+system), last cache-eligible block of wire history
  (whole request) — and place marker when that prefix beat **last placed marker's** prefix by ≥1024.
  Running comparison start at 0, so first marker's test is Anthropic's own ≥1024 minimum and no
  separate cumulative check exist; one that did would be condition no input can fail. Three of four
  slot, so ceiling never crossed. **Last *placed*, not previous tier** — tier skipped for small
  increment leave comparison where it was, else marker that would have paid get suppressed. Gating
  each marker on prefix it cache instead is what shipped first and was wrong: `estimateInputTokens`
  sum non-negative term, so tools ≤ tools+system ≤ whole and gate 1 passing *imply* other two — big
  tool set under 1-token system prompt took 3 slot and 2 cache write to re-store same byte. Same
  rule remove need for `OAUTH_IDENTITY` special case: injected line ~15 token, not in IR, so system
  tier add nothing and never get marked. **Never add a check naming that string** — it defend
  against one string and nothing shaped like it. Marker 3 walk `body.messages` **backwards, never
  `req.messages`** — flatMap drop turn of entirely unsignable reasoning, so index differ and wrong
  turn get marked silently; skip string content (`encodeSystemTurn`) and any block type outside
  text/image/tool_use/tool_result/document. Write to wire body only, never IR: IR shared across
  attempt, so marker there follow failover into other provider. `systemCacheControl` promotion path
  walk IR, so it cannot see wire-side marker — earlier claim it could was wrong. IR rule pinned by
  **deep-freezing module fixture** in `packages/providers/test/anthropic.test.ts`, not by cloning
  and diffing: fixture handed to `toWire` unclone by earlier test, so leaked marker already inside
  clone and assertion compare polluted to polluted. Recorded as `anthropic:cache-breakpoint-added`
  (marker 1 or 2) and `anthropic:history-cache-breakpoint-added` (marker 3), each only when its
  marker placed. Design:
  `docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md`.
- **Second exception**: `ponytailMode` (default **off**) let dispatch append the vendored ponytail
  ruleset to `system`, and **move** a breakpoint the client put on its own last system block onto
  that appended block. Invariant is one sentence — marker meant "cache through the end of system",
  and after injection it still do — so count unchanged, TTL unchanged, no marker invented, prefix
  grow by a constant and hit rate unaffected. Narrower than autoCache in every direction: it edit a
  marker's *position* alone, never place one, and it run in dispatch on IR rather than at wire time,
  so `estimateCachedInputTokens` stay non-zero and autoCache still decline. Moving a marker must
  never become way to switch autoCache **on** for request that had own placement. Injection **return
  a new request**, never edit in place: IR shared across attempt, same trap autoCache fell into, and
  it pinned by deep-frozen fixture in `packages/ponytail/test/inject.test.ts`. Dedupe on
  `PONYTAIL_MARKER` — opening line of every upstream wrapper, and of our own body, so injection
  idempotent. `count_tokens` apply same function by hand: it never dispatch, so a count omitting the
  ruleset under-report by whole prompt on every call while real request pay for it. Recorded on
  `request_logs.degradations` as `ponytail:<level>`, `ponytail:already-present`,
  `ponytail:cache-marker-moved`, `ponytail:cache-marker-not-last` — constants only, never request
  data, same bar as `LogFields`. That last one is the shape the move **cannot** help: a breakpoint
  the client put on a system block that is not the final one stay where it is, because relocating it
  would enlarge what the caller chose to cache by their own trailing blocks and not only by ours — so
  ruleset land outside the prefix and get billed fresh, ~1,240 token every request, and it reported
  rather than absorbed because it otherwise read exactly like the cheap case. Text vendored from
  upstream tag **v4.9.0**, blob `a3e4d94b…`, MIT with permission notice, adapted only where it would
  lie server-side (the `/ponytail` switch and "stop ponytail" cannot reach an installation setting).
  Pin the **blob**, not the release note: header first said v4.8.2, read off a release page rather
  than the repository, and that tag carry a different blob. Design:
  `docs/superpowers/specs/2026-08-29-ponytail-prompt-injection-design.md`.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes are disjoint classes priced
  once. Use `promptTokens()` when client surface need total prompt tokens.
- Adapters stream upstream. OpenAI chat usage need `stream_options.include_usage`; Responses API
  report usage on `response.completed`.
- `/v1/models` report smallest target window in pool. Limits advertised, not enforced.
- Normalize `[1m]` before key allowlist checks: ingress rewrite the model name, so any spelling
  of a pool reach policy as the pool's own id. `claude/` **not** reserved and not rewritten —
  discovery mirrors removed, so it is an ordinary model id like any other.
- Gateway not validate request-shape support per model; unsupported combos surface as upstream
  errors.
- **`ChatRequest.conversationId` is the client's own name for its conversation, and the Codex
  backend partition its prompt cache by it.** Arrive as Anthropic **`metadata.user_id`**.
  `metadata` sat in `KNOWN` with no schema entry, so it was parsed by nothing and dropped, and no
  ingress test noticed. Cost measured, not assumed: `request_logs` held **2 cache read in 21**
  OpenAI request, against 9,373 in 9,637 for a second gateway on the same account and model. Probe
  with byte-identical 10k-token body 75s apart read back **0 of 5** without a session id and **14
  of 15** with one, so it is neither prefix drift nor `instructions` placement — those were each
  disproved separately, and an encoder change made on either theory is wasted work.
  **`user_id` is opaque free text, not a bare id, and the shape matter.** Measured across 1,240
  captured Claude Code request: every one carry a 96-character string that is itself JSON,
  `{account_uuid, device_id, session_id}`. Nested `session_id` is what make the **whole string**
  conversation-scoped rather than user-scoped, and it is why hashing it whole is enough. Ingress
  **not** parse it: a client's JSON is not a schema this gateway own, and the hash care only that
  the string change per conversation and not within one.
  This bullet twice stated a field name that was wrong, in both direction, each time from a
  half-read capture — first `user_id` believed absent, then `session_id` believed top-level. Both
  survived typecheck and full suite, because reading a name no client send fall through to the
  derived key, and **a fallback is not an error**. When checking what a client send, print the
  key set of the object, not one member's value.
  Only **conversation**-scoped id may be used. OpenAI's `user` name the human, so keying on it
  merge every conversation on an install into one partition — on a single-operator install that is
  every conversation there is. It is read nowhere; the derived key beat it because it is at least
  per-conversation.
  `openai/wire.ts` resolve one key — client `prompt_cache_key`, then client `session_id`, then
  `conversationId`, then hash of instructions plus opening item, the shape `grok/wire.ts` already
  reason through — and return it, so `openai/codec.ts` put the **same** string in the `session_id`
  header. Resolved **before** the vendor `Object.assign`, else a client's own key land in the body
  while the header carry a derived one and the backend cache under neither. Header on the OAuth
  leg alone; `api.openai.com` take the body field, which both host carry. `"session_id"` sit in
  `openaiProfile.order` though no profile header supply it — `orderHeaders` append an unlisted
  name after `User-Agent`, which move an identity header to the end of the CLI fingerprint.
  Both non-client case are hashed, for **two different reasons** — say both, because stating only
  one invite a contributor to drop the other. Derived case is a hash by construction: that is how
  instructions plus opening item become one stable key. `conversationId` case is hashed for
  **privacy** — it is a client identifier the operator never chose to disclose, and it arrive
  beside `device_id` and `account_uuid` in the same object, so the habit of forwarding what is in
  there raw is the thing to not form. Digest also land inside the accepted charset for free.
  `store: false` is **required**, not a default — Codex answer `{"detail":"Store must be set to
  false"}` with HTTP 400 otherwise, so the literal in `wire.ts` stay.
- OpenAI surface read images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as from `content`. Neither sidecar is OpenAI field; read
  because clients that send them send no other copy. Payload's own container header beat any
  declared type, and remote URL never fetched.
- Two sidecars differ on what unusable payload mean, and split is the contract. `images` is Ollama's
  images-only field, so anything in it that not image data is `BAD_REQUEST`. `attachments` is SDK's
  general file envelope, where PDF or hosted URL is ordinary: those dropped, never refused, because
  they were dropped before gateway read the field and refusing now would break caller that worked
  yesterday. Same reasoning as `looseCacheControl`.

Detailed compatibility rules + measured client behavior belong in relevant specs under
`docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_BASE_URL` must be public reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidate stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > install in cwd > `~/.config/omnigateway`. Root
  `.env` intentionally override ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  the root. A `--root` flag suppress ambient `OMNI_DB_PATH` entirely — Bun preload cwd's `.env`, so
  otherwise flag pick the root and unrelated checkout pick its database. Suppression warned on
  stderr, reported by `doctor`, removed from env spawned gateway inherit. `OMNI_ROOT` not suppress
  it: both ambient.
- Quota cooldowns process-local, reset on restart. So are `1m` and `concurrency`; `5h` and `1w` come
  from database and survive one.
- `usage.append` must run at most once per request ID; duplicate completion double-count
  `usage_daily` and `usage_rollup` alike. Pending rows hold placeholder metrics; inspect `state`,
  not `status`.
- `usage_rollup` derived, never authoritative: `request_logs` is source of truth and `rebuildRollup`
  reproduce every bucket from it. Written in `append`'s transaction, pruned with rows it summarizes,
  rebuilt after restore, compared by `omni doctor`. It replaced `SELECT SUM` whose cost grew without
  bound — and `bun:sqlite` is synchronous, so that scan blocked whole event loop, not one request.
  Same reason a timeout around store read cannot fire; do not add one back.
- `quota_windows` store provider observations, not gateway counts. Missing data mean unknown, not
  unlimited. Probe failure must never disable credential.
- **`quotaRolledOver` in `@omni/store/types` is the only copy of "has this window already ended".**
  Poller overwrite the row and nothing else do, so between a rollover and next probe — up to
  `quotaPollIntervalMs`, 300_000 default — newest reading on file count a window that no longer
  exist. Nothing about the reading say so: it is minutes old, so every staleness check report it
  current, and only signal is its own stated reset now behind us. `quotaHeadroom` spelled that test
  out inline and was the **only** reader that did; console kept drawing spent window's rate,
  exhaustion instant and bar under a legend counting down to a reset in the past. Never re-derive it
  locally, same rule `servesTarget` and `scopeOf` follow. Null `resetsAt` is **not** rolled over —
  nothing was said about when it end, which is not having ended, and reading it otherwise blank
  every figure for a provider that report no reset.
  Rollover suppress the **inference**, never the measurement: `burnFor` drop `ratePerHour`,
  `exhaustsAt` and `survives` but **keep `windowStartsAt`**, because that instant is a restatement of
  `resetsAt` and the window's length, as true of ended window as live one, and it is what console
  chart retained readings against. Suppressing it too make `spanStartOf` null, so panel request no
  history and blank a chart of real readings for a poll interval after every rollover — and that
  blanking also delete the only cover `connectNulls` have, since budget endpoint landing mid-run
  require exactly this window shape. Surfaces phrasing both verdict say **staleness first**: probe
  that not got through for hours make both true, and only probe is operator's to fix.
- Projection line **truncate at the ceiling**, never overshoot. `ratePerHour` is whole-window
  average, so in minutes after rollover it divide `used` by elapsed span of minutes and come out
  enormous; axis scaled to that endpoint put plot in thousands of percent and flatten every measured
  reading onto floor. `projectedPace` move endpoint to instant line reach 100% — same instant
  `exhaustsAt` name, so slope stay the rate that was read and two stay one claim. Crossing need no
  clamp to the span: `usedPercent` capped at 100 so crossing never fall behind reading, and that arm
  run only when endpoint passed 100 by the reset, which is what put crossing before it. Fact read
  "100% of limit before it resets" there, not "160% by reset", which invite reading window as fine
  until reset when it fill hours earlier.
- RTK filter ids persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is storage contract,
  not internal enum. `isRtkFilterId` drop unknown ids on read, so renaming one lose history silently
  rather than failing. Add ids freely; rename or remove only with migration.
- Rate limiting explained in `ARCHITECTURE.md#rate-limiting`; these are invariants a change must not
  break, each already broken once.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are JSON keys of `api_keys.limits`, so
  storage contract like RTK ids — but failing **closed**: unknown name is parse failure, never
  silent drop. Rename or remove only with migration, and update mirror in
  `@omnigateway/plugin-api/events` in same change.
- **Nothing a plugin imports may reach a core package.** `@omnigateway/plugin-api` and
  `@omnigateway/dashboard-sdk` published; every `@omni/*` package not, so single import put
  unresolvable `workspace:*` into stranger's dependency tree. It typecheck and test green inside
  this repo, because workspace resolution make every internal package reachable — exactly why it
  went unnoticed once. `packages/plugin-api/test/bundleWeight.test.ts` build each entry point and
  assert zod appear only under root; first test assert zod *is* present there, because "absent" is
  also what broken harness report.
- **The range one published package put on the other is never resolved in this repository**, so it
  is the one dependency edge nothing here exercise. Workspace resolution use the local copy, and the
  declared range only decide what arrive in a stranger's `node_modules`. `dashboard-sdk` carried
  `@omnigateway/plugin-api: ^0.1.0` past that package's move to `0.2.0` — `^0.x` mean
  `>=0.x.0 <0.(x+1).0` — so every `bun add` of the SDK resolved generation **1** against a gateway
  that refuse `api: 1`, and no source file say so. Repairing the range fix nobody: release step skip
  a package whose **version** not moved, so version bump is the only part of the repair a consumer
  see. `publishable.test.ts` walk the pairs rather than assert the one range, and its drift check
  watch `package.json` beside `src` — manifest is the part of published artifact deciding what
  source *resolve*.
- **A check gated on `merge-base(main, HEAD)` fail on one CI trigger and is vacuous on the other.**
  `actions/checkout` fetch `+refs/heads/*:refs/remotes/origin/*` and, on `pull_request`, detach at
  `refs/remotes/pull/N/merge` — it never create `refs/heads/main`, not at `fetch-depth: 0` either.
  So `rev-parse --verify main` exit 128 and `check:claims`/`check:dead` exit 2 on every PR, printing
  an instruction (`actions/checkout@v5 with fetch-depth: 0`) that is the configuration already in
  effect. On `push: branches: [main]`, `merge-base` **is** HEAD, so both report success over an
  empty set — green and vacuous, the shape they exist to catch. Base now resolve through `main` or
  `origin/main` and fall back to **first parent** when HEAD is the base; first parent specifically,
  because `main` advance by merge commits and the second parent is the change-set itself. One copy
  in `scripts/lib/history.ts`, tested against scratch repositories in `scripts/test/history.test.ts`
  — the developing checkout have a local `main` behind HEAD, which is the one arrangement that
  worked, so neither failure was observable from it.
- **`SAFE_PROVIDER_ID` in `apps/dashboard/src/theme/tokens.ts` mirror `PROVIDER_ID_PATTERN`, and
  `providerColor` is where a stored string become CSS.** styled-components not escape
  interpolations, and the ids reaching it — `credential.provider`, `target.provider`,
  `log.resolvedProvider` — never pass `/api/catalog`, where control already withhold an unusable id.
  Write path is guarded by `providerIdSchema`; read path is not, because `sqlite/config.ts` parse
  `virtual_models.targets` with bare `JSON.parse`. Check live in `providerColor` and not at the four
  call sites, because a guard at callers is one a fifth caller join by not knowing. Restated not
  imported (rule 12), pinned by `apps/gateway/test/routes/providerIdMirror.test.ts` from the one
  place that may import both — same shape as `limitVocabulary.test.ts`, and the **first** of the
  five copies of this expression that anything pin. Reference carry `var(--p-<id>, var(--ink-faint))`:
  without the fallback an unlisted provider inherit, so the identity bar take the colour of the
  label beside it.
- **A drift check reading repaired history cannot fail.** `publishable.test.ts` ask git what moved
  since last tag, and once the fix land there is nothing to see — so both fixes to that query
  survived mutation against real history while being plainly wrong. Query now live in
  `packages/plugin-api/test/helpers/changed.ts` and `changed.test.ts` ask it of scratch repository it
  build, with a no-edit case first because query reporting everything satisfy every other assertion.
  Two properties it own: watched set include `package.json`, and diff take **one ref**, not
  `${ref}..HEAD` — two-dot form compare commit to commit, so change contributor look at while
  running suite is invisible, which is every change at moment it still free to fix. Third instrument
  in this repo found reading `base..HEAD` where it meant "since base"; `scripts/dead-exports.ts` was
  second.
- `admit`/`consume` claim ring stamp and gauge **synchronously**, before any `await`, and roll back
  on refusal. Reading counters first and recording after let concurrent requests judge one pre-burst
  snapshot — ceiling of 3 admitted 10 parallel requests, and it need no I/O to fire.
- Refuse at auth, degrade at list. Unparseable `limits` read back as `null`, distinct from `{}`, and
  `authenticateApiKey` turn it into `INTERNAL` — not `AUTH`, which would blame credential that is
  fine. `keys.list()` must never throw over such a row: `toKey` serve the listing too, and listing
  is how operator find the row to fix. Nothing may collapse that `null` into `{}`.
- Two fields editable after minting: `limits` (`setKeyLimits`, `PUT /api/keys/:id/limits`) and
  `modelAllowlist` (`setKeyModels`, `PUT /api/keys/:id/models`). Both written whole, never patched —
  matrix `{}` is how last limit go away, never husk like `{"requests":{}}`; allowlist `null` (every
  model) and `[]` (none) are opposite facts, so schema refuse default and absent never pick one.
  `bodyLoggingOptOut` deliberately not editable — opt-out is promise to whoever hold the key; limit
  and allowlist are operator's own ceiling on own installation.
- Windows *slide*. `1m` is exact ring in `apps/gateway`; longer windows are `usage.sumSince` — which
  must filter `state = 'done'` — plus in-memory delta, cached 30s. Composition may over-count and
  must **never** under-count, so delta keep everything at or after read instant; other direction
  walkable by timing the refresh. Failed `sumSince` serve the request and log through existing
  `LogFields` keys, degrading long windows only, because `1m` and `concurrency` never touch store.
- Token and spend debit live in `finishLog` beside `usage.append`, never inside `@omni/store`: that
  site already run at most once per request id, the guarantee debit need.
- Concurrency gauge released at request scope and nowhere else. Streaming handler return while
  request still run, so `finally` around handler body fire at head-send, and decrement beside debit
  sit behind store write; streams free it from `sseResponse`'s run-once completion. No window expire
  a gauge — leak lock the key out until restart, silently.
- `ApiKeySummary.limitUsage` count committed rows only: floor on what limiter see, never its number.
  `concurrency.used` is `null`, not `0`, because gauge not stored.
- `Target.credentialId` pin one account to one target, and it is **filter state, not strategy**. Set
  mean that account alone serve the target; unset mean any account of the provider. No `"pinned"`
  strategy exist and none should be added — strategy decide order, pin decide membership, and two
  places deciding the same thing is how they come to disagree. Pin is **hard**: disabled, breakered,
  rate-limited or quota-spent pinned account fail the request, never spill to sibling.
- **`servesTarget` and `resolvePin` in `@omni/store/types` are the only copy of "can this account
  serve this target".** Provider, custom `endpointId` and pin are one question; five sites asked it
  separately and three asked less than the router did, so a target pinned to another provider's
  account saved clean, hard-failed every request, and `doctor` called it healthy. Router, `putModel`,
  `resolveModelLimits`, `omni doctor` and the console picker all route through it — console import it
  direct from the subpath, precedent `vitals.ts` already set with `sameWindow`. Never reimplement it
  locally, however small the local question look. `ServingCredential` carry `providerData` for it,
  else the rule cannot see custom endpoints at all.
- `pin:missing` is emitted **once per target**, not per credential skipped, and only when no account
  resolve — else the request fail with an empty exclusion list. Accounts the pin exclude are skipped
  silently: one row per sibling would bury the reasons describing the pinned account itself.
  `pinSeen` is declared **per target, inside the target loop**; hoisting it make a model whose first
  pinned target resolve suppress the row for every later dangling one. It is set **before** any
  `drop()`, so a pinned target that also fail an earlier check report that check alone rather than
  two rows. Guard *order* cannot change membership — all three are `continue` guards, so reordering
  admit the same pairs; what order decide is whether `pin:missing` fire. The mutation that **does**
  widen membership is making an earlier guard conditional on the pin. An early version of this bullet
  named the wrong property, which is exactly the trap: a rule stated wrong is one a contributor
  preserve while breaking the real thing.
- **`ProviderId` is a validated string, not a union of six.** A provider loaded from
  `<root>/plugins/` has an id no compiled-in union could hold, so a closed type there is a closed
  door here.
  **What this cost, stated exactly, because the first version of this bullet overstated it and a
  rule stated wrong is one a contributor preserve while breaking the real thing.** Five tables key
  on a provider id — `PROVIDER_DESCRIPTORS`, `ADAPTERS`, `PROFILES`, `BODY_ORDER`,
  `PROVIDER_MODEL_CATALOG` — and each is a hand-written six-key literal. Only `PROVIDERS` is derived
  by walking one. Delete a built-in's line from any of the five and **typecheck pass**: measured, all
  five. `Record<string, X>` accept any subset, so writing the ids as literals constrain nothing once
  the key type open. What catch it is **lint** (the import go unused) and
  `packages/providers/test/descriptor.test.ts` (key-set equality against a literal `IDS`) — never the
  compiler. Do not write "compile error" here again; if the guarantee need to be stronger, the
  honest move is a derived table, not a stronger sentence.
  Lookups keyed on a **stored** id are genuinely partial and `noUncheckedIndexedAccess` make each a
  compile error at the point of use. Do not cast that away; each site owe a decision, and the
  decisions differ. `PROVIDER_ID_PATTERN` in `packages/providers` is the source of what may name a
  provider; `packages/control/src/catalog.ts` read it rather than restating it. Four other copies of
  the same expression validate a **plugin** id — `packages/plugin-api/src/manifest.ts` (published, so
  justified), `apps/gateway/src/plugins/routes.ts`, `packages/control/src/plugins.ts`,
  `packages/store/src/sqlite/plugins.ts`. A plugin provider's id is both kinds at once — a registered
  descriptor's `id` must equal the manifest id — so the two grammar cannot drift independently, and
  `apps/gateway/test/plugins/pluginIdGrammar.test.ts` now pin all four from the one place that may
  import every one of them. Direction is one way: `PROVIDER_ID_PATTERN` is truth, a failure mean a
  mirror stale, never that the pattern should widen. It pin **behaviour, not `.source`**, and that is
  weaker than what `providerIdMirror.test.ts` do — the four constant are module-private, and
  exporting one from a published package so a test may read it is a worse trade than the gap. It is
  stronger in one direction the source comparison miss: a site that stop consulting its own pattern
  fail here. Do not describe this as mirror-and-pin in the `@omni/ratelimit/catalog` sense; that one
  compare the values themselves.
- **Every provider-keyed table drop its prototype, and that is one invariant standing in for a guard
  at each reader.** Reason: a provider id arrive from a client's `model` name and from unvalidated
  JSON in `virtual_models.targets`, and on ordinary object literal `table["constructor"]` answer the
  `Object` constructor. So `!== undefined` and `?.` both read "installed", then throw on next
  property access. Shipped once: `resolveModel` replaced a `Set.has` — which never consult a
  prototype — with an index check, and `model: "constructor/foo"` returned **500 carrying an internal
  source expression** where `nope/foo` correctly returned 503. Same keys defeated four more readers
  including the `provider:missing` guard and `omni doctor`'s check, each going silent in the exact
  case it exist for. `PROVIDER_ID_PATTERN` accept `constructor`, so nothing upstream stop such an id
  being stored. **`noUncheckedIndexedAccess` cannot see any of it** — it force a guard, and the guard
  it force is the one a prototype key defeat. Do not add `Object.hasOwn` at the readers instead: it
  cover only those asking existence, not `catalogPricing`'s `?.`, and partial protection that read as
  total is worse than none. That version was written, and every one of its mutants survived removal.
  **Do not enumerate the tables here.** An earlier version did, listing the six in
  `@omni/providers`, and `OAUTH_PROVIDERS` in `@omni/control` went on leaking for another review
  round — a raw `TypeError` out of `refresh.ts` with the same signature as the bug the rule was
  written for, plus `CALLBACKS` and the console's `heldAuths` map. A list of what to check have
  exactly the property the thing it check lack. `packages/control/test/providerTables.test.ts`
  **discover** them instead: it walk the exported surface of both packages, treat anything holding
  two or more registered provider ids as a table, and assert the walk found something before
  asserting anything about what it found. New table is covered the day it is exported.
  Two facts the idiom hide, both worth knowing before writing a new one: spreading a null-prototype
  object give an **ordinary** object, so `{...ADAPTERS, x}` silently revert the invariant — use
  `Object.assign(Object.create(null), …)` — and `.hasOwnProperty()` called as a **method** on one of
  these throw. Use `Object.hasOwn(table, key)`.
  This bullet used to say the gateway normalise injected adapter maps at `app.ts`. **It does not**,
  and `app.ts` say so in as many words: an earlier version spread there, which guarded `createApp`
  and nothing else, because `DispatchDeps` and `ProxyDeps` are public injection points a caller or
  test construct directly — so the map dispatch actually read may never have passed through. The
  guard live at the **read site**, `dispatch/index.ts`, which is on the path however the map was
  built. That is the whole thing standing between a prototype-keyed provider id and `adapter.send`,
  and `PROVIDER_ID_PATTERN` accept `constructor`, so a contributor who believe the old sentence and
  simplify that read reopen a 500 carrying an internal source expression.
  Console cannot import `@omni/providers` (rule 12), so `heldAuths` restate the rule with
  `Object.create(null)` and carry its own test.
- **A registry threaded into some of a call graph and not all is this repository's most repeated
  bug, and it is the *sweep* that keep failing, not the fix.** Three review round in a row each
  found it in the previous round's fix: prototype sweep covered `@omni/providers` and left
  `OAUTH_PROVIDERS`, `CALLBACKS` and console's `heldAuths`; injection covered `resolveModel` and
  `rank` and left `priceOf`, so a $12.50 cache write bill $0.00 with no throw and no log; then the
  test pinning *that* covered injected path and not default, because `??` only fire on `undefined`.
  Every one found by hand, by someone thinking to try that one site.
  So do not add one test per site — they go stale the day a fourth site appear. **Inject a sentinel
  registry holding one synthetic provider and none of the six**, and assert a real request end to
  end. Any consumer reading module-global instead see a registry without it and fail loudly:
  `resolveModel` cannot infer the prefix, `eligible` exclude `provider:missing`, `priceOf` bill
  writes at zero. `apps/gateway/test/dispatch/dispatch.test.ts` hold it, and it kill all four
  threading mutants **alone**, with every per-site test deselected. Same instrument as
  `providerTables.test.ts`, which discover leaking table instead of listing them, and for same
  reason: a list of what to check have exactly the property the thing it check lack.
  Two shapes it need two dispatches for, and both are traps: a **configured** model short-circuit
  `resolveModel` before any registry is read, and an **inferred** target is priced from
  `PROVIDER_MODEL_CATALOG` — a different global, not injected — so it carry zero prices and can show
  no multiplier.
- **A module-scope `Object.keys`/`Object.entries` over `PROVIDER_DESCRIPTORS` is a build-time
  snapshot**, and `loadPlugins()` run long after import. **Six** sites read one and were wrong the
  same way — the count went three, then five, then six, because each sweep stopped at the sites the previous
  bug had made visible: `providerCatalog` served a console missing every plugin provider,
  `providerIdSchema` was `z.enum(PROVIDER_IDS)` and would have refused their credentials,
  `isProviderId` reported them as not existing, `PREFIX_PROVIDER` made a provider's own
  `modelPrefixes` unreachable while `provider/model` for the same provider resolved — an asymmetry
  *inside one function* — and `CALLBACKS` redirected nowhere. The sixth was `OAUTH_PROVIDER_IDS`,
  a module-scope `Object.keys` of the built-in OAuth table that **gated `omni connect`**, so a
  plugin's provider was refused by a list compiled before it could exist; it is `oauthProviderIds()`
  now, and `ConnectFlows` answer from the map it was handed. All six ask the registry **at call
  time**; `CALLBACKS` was deleted outright, since a second table derived from the first is a thing
  to keep in step rather than a thing to have. Assume a **seventh** exist until you have grepped for
  the pattern rather than for the names above — six sweeps have each stopped at the sites the
  previous bug made visible.
  `PROVIDER_IDS` still exist and is still a snapshot — it feed CLI usage messages and tests, never a
  gate. `descriptors.ts` say so at the definition, which is where a reader meet it.
- `provider:missing` is the pin rule applied to the provider, and follow it exactly: emitted **once
  per target**, `kind: "target"` with `credentialId: ""`, because no account is at fault. It is the
  **first** guard in the target loop, so a target that is also pinned report the provider rather than
  `pin:missing` about an account that could not have served it either way. `credentialId` must stay
  `""` — a mutant carrying the pin there survive a `reason`-only assertion and put the string into
  `LogFields.credentialId`, contradicting `kind`. Dispatch's `INTERNAL "no adapter for provider …"`
  is the *other* half and stay a throw: reaching it mean the router admitted a candidate it should
  have excluded, which is a gateway bug, and `deps.adapters` is a separate injection point from the
  descriptors, so the two can disagree.
- **Format and existence are two questions.** `providerIdSchema` check format alone, and it is the
  gate on **credentials**, not on targets: `createApiKeyCredential` parse it, then ask `isProviderId`
  and refuse to mint an account for a provider that does not exist — no history to preserve.
  `catalogModelAuths` answer "every way in" for an unknown provider, matching what it already answer
  for an unlisted model: empty would read as "no credential can reach this" and refuse every plugin
  provider's target.
  **A target naming any well-formed provider id save**, including one no build contain. This bullet
  has now said the opposite twice and both were wrong in their own direction, so state it once
  plainly: `putModel` parse through `modelSchema`, `targetSchema` take `providerIdSchema` — format
  only — and existence is checked nowhere on this path. That is the same exemption a dangling pin
  already have, for the same reason: removing a provider must not make an unrelated model unsavable.
  `provider:missing` at routing and `omni doctor` carry that weight.
  Until the plugin capability landed, `targetSchema` held `z.enum(["anthropic",…,"grok"])`, which
  refuse every target naming a plugin-supplied provider — a provider routing, pricing and the console
  all knew about and no operator could configure. The enum was written for exhaustiveness over a
  closed `ProviderId` and outlived it.
  One rule survive the union it replaced, and losing it is the real risk: **a `custom` target require
  an `endpointId` and nothing else may carry one**. A custom target with no endpoint match no account,
  so it save clean and fail every request at routing rather than at the point it was named.
- Nothing validate the pin at write time, same exemption `putModel` give stored targets: removing an
  account must not make unrelated edit unsavable. `omni doctor` carry that weight instead, and it
  must resolve through `resolvePin` — an existence check report "none" for the cross-provider and
  wrong-endpoint pins, which are two of the four ways a pin die. Control schema refuse `""` because
  it is an id nothing match, not a third state, so dashboard **omit** the field rather than send
  empty, and bound it to 64 chars of `[A-Za-z0-9_-]` **on both arms of the union** — the block is
  duplicated and the custom arm went untested once. Bound exist because `pin:missing` carry this
  string into `LogFields.credentialId` and `request_logs.degradations`, and unlike `reason` that
  field is not truncated on the way out. Schema is **one of two ways in**: `sqlite/config.ts` read
  targets back with `JSON.parse` and no validation, so a restored or hand-edited database bypass it.
  Format deliberately not pinned to `crypto.randomUUID()`, else changing id generation make every
  stored pin unreadable.
- Pin cleared on provider **and** endpoint change in the console draft (`retargetDraft`,
  `reEndpointDraft`) — account belong to one endpoint as firmly as to one provider — but never on
  model change, which would undo the operator's choice on every keystroke. **This is draft
  behaviour only**: `PUT /api/models/:id` and `omni models put -f` accept a provider change carrying
  the old pin and save it. The durable property is not "the draft clears it" but that a pin
  outliving its provider or endpoint is unroutable and `doctor` is what reports it.
- Two places outside the router must read the pin, and each get it wrong in its own direction if it
  not. `resolveModelLimits` narrow across every way in a provider hold, justified by failover
  landing anywhere in it — pin mean it cannot, so pinned target described by its own account's auth
  alone. Unresolvable pin fall back to provider-wide narrowing, **never** to catalog figures:
  narrowing across every way is by construction no wider than any one of them, so fallback can never
  advertise more than unpinned would. Matter because `setup.ts` persist that number into
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, where wrong figure outlive the request that would expose it.
  `unreachable` in `putModel` likewise check pinned account's auth alone, and the pin check is
  **deliberately not grandfatherable** — `pairOf` stay keyed on provider+model. Keying it on the pin
  would judge pin-only edit fresh and re-run *provider-wide* check on it, which is exactly the check
  a vanished credential fail, so clearing a dangling pin — the repair operator make after removing
  account — could be refused while broken shape it replace still saved. Pin check firing only when
  named account exist right now keep "removing account never make unrelated edit unsavable" true by
  construction. `modelLimits` resolve pin from **enabled** credentials, `models.ts` from existence:
  first ask what serve now, second ask what operator hold, same split `heldAuths` already make.
- Both surfaces that remove an account name the models pinned to it **before** the confirm, because a
  pinned target has no fallback and stop serving outright. Console read `useModels()` and say so when
  that query has not answered rather than implying nothing is pinned; `pinNote` likewise treat an
  empty credential list as unknown, not as a dead pin, since that is also what a failed
  `/api/credentials` look like. Fail-open on either read accuse working configuration in red, or hide
  an irreversible consequence — both worse than saying the question is unanswered.
- `ProviderModelChoice.auth` enforced at write time in `putModel`, never at routing. Which ways in
  exist is installation state, so catalog export the fact (`catalogModelAuths`) and control own the
  rule. Provider with no credential is unknown rather than blocked, unlisted model unknown rather
  than forbidden, disabled credentials still count, and target already stored under that id exempt
  so removing credential cannot make unrelated edit unsavable.
- **An `AggregateError` has no message of its own.** Node report failed multi-address connect that
  way — `autoSelectFamily` on by default — keeping each address's error in `errors` and leaving
  `message` empty. Copying `error.message` verbatim therefore render `reason=` with nothing after
  it, and `request_logs` hold no message column, so on proxy path the reason a request failed was
  recoverable from nowhere. `describeError` in `@omni/ir` is the one way to fill that field; it fall
  back to error's name, and every site reporting a `reason` go through it. `classify` recurse into
  `errors` for same reason: matching only `name` and `message` saw `""`, fell through to `INTERNAL`,
  and `RETRYABLE` mark that false — so retryable transport failure ended the request after one
  attempt and served 500 blaming the gateway.
- `CONNECT_ATTEMPT_TIMEOUT_MS` must stay above one TCP retransmit. Happy Eyeballs give each address
  family fixed budget, and node's default is under Linux's one-second initial RTO, so dropped SYN —
  routine on lossy path — abandoned at ~500ms instead of recovering at ~1000ms. Where other family
  cannot serve (AAAA record with no IPv6 route), both attempts then exhausted and connect fail
  outright. Measured: 3 failures in 99 connects at default, 0 in 212 once raised, previously-failing
  connects completing at 1007–1061ms. Failure read as provider outage and is not one.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats decoded
  away. Keep server idle timeout above request deadline.
- Socket registry close every connection **before** `app.stop()`, and its `stopLoops` position is
  what make that true. `stop()` called without `true`, so it drain rather than sever, and open
  WebSocket never end by itself — one connected console otherwise hold teardown for the full
  `STOP_DEADLINE_MS` every restart. Close with `1001`; `4401` mean "do not reconnect" and is for
  expired session alone.
- `/health` watcher stay a plain `fetch` poll and must never move onto the socket. The one check
  proving gateway came back cannot depend on subsystem being restarted.
- Elysia call a `.ws()` route's `beforeHandle` **twice** — once through composed hooks, once by hand
  in the Bun adapter, guarded by `typeof === "function"`. So it must be a single function, never an
  array (an array is silently skipped by the second call, and guard appear to work while running
  half the time), and it must be idempotent or every upgrade cost two `verify` round-trips.
  Throwing from it is fine and reach `apiErrorHandler`. Also register a companion plain `GET` on the
  same path: a ws route match only when `upgrade: websocket` present, so without one a browser hit
  fall through to static catch-all and 404 an endpoint that exists.
- `res:*` frame carry at most `{ keys }` and client map **topic to query-key prefix**, never an
  enumerated key list. `["logs", limit]` and `["usage", …6]` are parameterised, so an enumerated
  table go stale silently. One exception is real: `res:logs` must exclude `["logs","body",…]`, a
  prefix collision on immutable data.
- **`plugin:*` is third class and carry no `seq`, so it can never `gap`.** `channels.send` emit
  `{type,topic,payload}` and nothing more — no ring behind it, nothing to fall off the back of — so
  console `hold` resubscribe **without** `sinceSeq` and SDK `ChannelMessage` carry no `gap` arm.
  Adding one would be a case every panel author write and none reach. What panel do get is
  `open`/`refused`/`closed`, because plugin topic is the one class a principal can be **refused**:
  `authorised` give it to admin alone, so viewer's panel must be able to say so. Silence there read
  as channel that is merely quiet, same failure `declared` exist for on `stream:*`. Console `hold`
  is refcounted and unsubscribe on last release — that frame is what fire plugin's `onClose`, so
  panel unmounting with tab still open is a session plugin may drop.
- **A topic name a resource, and every branch reading that resource must be in its entry.** Console
  and client surface hold different query keys for the same rows — `["usage",…]` and
  `["client","usage",…]` — so `res:usage` and `res:logs` cover both. An entry covering one branch
  leave the other subscribed to a frame that do nothing, and the symptom is silence, which look
  exactly like a quiet gateway. Client's key summary ride `res:usage`, not `res:keys`: its
  `limitUsage` is computed from usage rows, and a client cannot hold `res:keys` anyway. A panel
  whose topic its principal cannot hold must poll with **no** topic — naming one switch polling off
  in favour of a push that never arrive.
- **A pushed topic replaces polling, so it must emit on *every* transition of what it covers, not
  only the interesting one.** `cadence(ms, topic)` return `false` once the socket declare that topic
  pushed, so the panel refetch on nothing else — an emitter set that miss a transition make that
  transition invisible, and the symptom is silence, never an error. `res:logs` shipped emitting from
  `finishLog` alone, so an in-flight request first appeared already finished and the logs page
  counted zero running on a busy gateway; failover rewrote a row's target with nothing emitted at
  all. Three sites now: `beginLog`, `routeLog`, `finishLog`. Polling hid this because it never asked
  *why* the list changed. When adding a topic, enumerate the writes to the resource and check each
  one emits — the count of emitters should match the count of writers, and `res:usage` pairing only
  with `finishLog` is correct precisely because nothing else count tokens.
- Coalescing on `res:*` is load-bearing, not tuning. Uncoalesced push at 100 req/s is 100 refetch
  per second against a surface polling at 60s — strictly worse than what it replace.
- Stdout hold operational events; `request_logs` hold completed requests. Do not restore duplicate
  per-request access lines. `requestId` join both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` name
  existing capture; it not create one.
- Docker image contain gateway only; npm package contain CLI, gateway, dashboard.
- OpenAI OAuth route to narrower Codex surface. OAuth-specific encoding stay behind existing `oauth`
  flag.
- Snapshot is database alone. `request_bodies/` excluded, so downloaded snapshot never a prompt
  corpus and its size never track prompt volume. After restore, body rows and artifact files
  disagree until `sweepOrphans` reconcile them; expected, not bug.
- Snapshot still carry encrypted credentials and API-key hashes. Downloads are `no-store`, and file
  inert only because `OMNI_ENCRYPTION_KEY` not in it.
- Lifecycle and swap rules below explained in `ARCHITECTURE.md#replacing-the-database-while-it-is-open`
  and `#stopping-and-restarting`. Each look arbitrary alone and is not; read the section before
  changing any of them.
- Restart ask systemd, never self-SIGTERM (which stop the gateway for good), and `--no-block`
  required.
- Quiesce latch gate `/v1/*` only; `/api/*` and `/health` stay live through swap.
- `store.close()` idempotent and `reopen()` tolerate closed handle, so restore is close → swap →
  reopen. Repo methods forward per call: bind one to local and it die at next swap.
- **The swap forwarder in `sqlite/store.ts` hand-write one arrow per repo method with its parameters
  spelled out, and an arrow of lower arity still satisfy the interface.** A dropped optional
  parameter is therefore **not a type error** — it silently become `undefined`. `usage.recent`
  shipped that way while its second parameter carried the API-key scope: a scoped read returned
  every key's rows and nothing raised. Adding a parameter to a repo method mean editing that arrow
  too. `packages/store/test/swap.test.ts` read the forwarder source and assert no arrow drop an
  argument, because a behavioural test cover the method it name and say nothing about the next one.
- `vacuum()` must checkpoint, or page count fall while file keep every page.
- Restore compare admin password hash across swap and invalidate sessions only when it differ.
  **Nothing may sit between the swap and that comparison** — swap already succeeded, so anything
  throwing in front of it skip the invalidation while new password live.
- `swapIn` rebuild `usage_rollup` last and guarded, for that reason. It block the loop; cost
  measured in `README.md` and must stay documented rather than hidden.
- `omni db restore` refuse while gateway running, no override.
- Plugin tables are `plugin_<id>_<name>`, written by host from `{{name}}` placeholder, tracked in
  `plugin_migrations` on track independent of core's `001..`. Core's next migration number
  unaffected by any plugin. Plugin migrations apply **one transaction each**: batch transaction
  would make plugin failing on migration 5 silently revert 1–4 on every later boot.
- Restore onto install without that plugin leave orphan `plugin_*` tables. They stay, and
  `omni doctor` report them. **Nothing auto-drops them** — restore is exactly when plugin may not
  be installed yet, and drop is irreversible. `omni plugin remove` keep tables too; only `--purge`
  drop them, and it confirm first.
- Plugin events are **at-most-once and not durable**: one queued when process die is gone, and full
  queue drops rather than grows. Anything needing exact accounting must reconcile from own storage.
  `RequestCompleted` emitted from `finishLog` because that already the one site running at most once
  per request id — same reason usage debit there.
- Plugin channels carry same promise and one more. Client must **subscribe before it send**: plugin's
  only way to answer is `send(connectionId, …)` on that topic, so frame from unsubscribed connection
  is question whose answer have nowhere to land, and it refused rather than handed over. Plugin topic
  nothing opened refused like `stream:*` topic nothing `declareStream`d, same reason — topic with no
  owner must not read as topic that merely quiet. Channel registry build **before** `loadPlugins` in
  `apps/gateway/src/index.ts`, because plugin open its channel inside `setup`; one built after leave
  every plugin holding live-looking handle onto nothing. Route's `close` read `registry.topics(id)`
  **before** `registry.remove(id)` — reverse it and every `onClose` handler go unfired, silently.
  Throwing handler caught, counted per plugin, reported one batched line per plugin, never one per
  failure, and never with error body: `LogFields` closed allowlist and that code authored outside
  this repository.
- Console externalise `react`, `react-dom`, `styled-components`, `@tanstack/react-query`,
  `@omnigateway/dashboard-sdk` and resolve them through import map, so console and every plugin
  share one instance; two React copies throw "invalid hook call".
  `apps/dashboard/shared/manifest.ts` is single list feeding externals, import map, shared build.
  **`export * from "react"` does not work and does not warn** — React is CommonJS, so re-export
  compile to module exporting only `default`. Shims destructure the default instead. SDK is ESM so
  `export *` correct for it, and it on list for different reason than other four: they about
  instance identity and each announce breach; SDK hold `LiveContext`, so duplicate is duplicate
  *context object* — panel find no provider, pause forever, nothing thrown, nothing logged. Plugin
  bundle must mark SDK external exactly like React.
- Plugin UI assets served at `/plugin-assets/<id>/…`, not `/plugins/<id>/…`, which would collide
  with console's own client-side routes. Bundles unauthenticated like console's own JavaScript;
  catalog at `/api/plugins` admin-gated, because what is gated is data.
- Literal `../` never reach a route handler — `URL` normalise it before routing, so test asserting
  404 for that input prove nothing. Only percent-encoded forms reach a guard, and they arrive
  undecoded. Two path checks here deleted after mutation showed `realpath` already decided every
  case; decoration in security path invite belief that something is being done.

## Subagent workflow

- Orchestrator create implementation subagent, then separate review subagent. Subagents do not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; no worktrees.

## graphify

This project can carry knowledge graph at `graphify-out/` with god nodes, community structure,
cross-file relationships. `graphify-out/` gitignored, so fresh clone has none: if
`graphify-out/graph.json` absent, run `/graphify .` to build one, or skip graph and read source
directly. Every rule below conditional on that file existing.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. Return scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain not surface enough context.
- After modifying code, run `graphify update .` to keep graph current (AST-only, no API cost).
- AST extraction not follow barrel re-exports: import of `GatewayError` from `@omni/ir` target
  `packages_ir_src_index_gatewayerror`, but symbol defined in `errors.ts`, so edge dangle and drop
  at build. That silently zero inbound degree of the types whole architecture turn on —
  `GatewayError`, `ChatRequest`, `Store`, `ProviderId`, `StreamEvent`, `Logger`, `HttpClient` — so
  god-node rankings under-weight `packages/ir` and `packages/store` until endpoints remapped to
  their defining module. Every `graphify update .` bring it back.