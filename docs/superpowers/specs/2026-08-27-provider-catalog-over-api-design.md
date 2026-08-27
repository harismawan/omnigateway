# Provider catalog over `/api/*`

The console stops importing provider data at build time and reads it from the
gateway instead. Retires architectural boundary rule 9.

Sub-project 2 of the provider modularity work. Depends on
[the descriptor registry](2026-08-26-provider-descriptor-registry-design.md),
which put every provider's data behind one record, and is a precondition for the
plugin host: a plugin-supplied provider's models exist only at runtime, so no
build-time import can reach them.

## Problem

`@omni/providers/catalog` is a browser-safe leaf the console imports directly.
Rule 9 exists to keep it importable, rule 12 permits it, and
`leafSubpaths.test.ts` enforces that it stays free of adapters and transport. It
works because every provider is compiled into the gateway.

A provider that loads from `<root>/plugins/` at boot is not. Its models, pricing,
limits, label and colour come into existence when the gateway starts, which is
after the console bundle was built. Without this change a provider plugin can
route requests and cannot appear in the model picker, the accounts board, or the
connect dialog — which is most of what an operator would call "supported".

Six console files import provider data today:

| File | Reads |
|---|---|
| `features/models/draft.ts` | pricing (5 fields), limits, per-model auth, model list, `defaultModel` |
| `features/models/TargetEditor.tsx` | model ids, `defaultModel`, the whole entry for its picker |
| `features/accounts/ConnectDialog.tsx` | `authTypes`, `pasteHint`, `callback.uri`, provider id list |
| `features/usage/ModelTrafficPanel.tsx` | model ids, to attribute an upstream name to a provider |
| `theme/tokens.ts` | label, display order, id list |
| `theme/GlobalStyle.ts` | `colour.light`, `colour.dark` |

The whole catalog is 10,316 bytes and 45 models. Payload size is not a
consideration in any part of this design.

## Goal

One source of provider data: the gateway. A plugin-supplied provider is
indistinguishable from a built-in one everywhere in the console.

Non-goals:

- Serving the catalog to anything but the console. `packages/router`,
  `packages/control`, `apps/cli` and the gateway keep their direct imports —
  they run in the same process as the registry and an HTTP hop would be absurd.
- The plugin host itself, or any change to how a provider is registered.
- Moving `ModelTrafficPanel`'s model-id lookup server-side. See *Out of scope*.

## The endpoint

`GET /api/catalog`, admin-gated like every other `/api/*` read.

```ts
{
  providers: [
    {
      id: string;
      label: string;
      order: number;
      colour: { light: string; dark: string };
      pasteHint?: string;
      callback?: { uri: string; label: string };
      defaultModel: string;
      authTypes: readonly ("oauth" | "apiKey")[];
      models: readonly {
        id: string;
        label: string;
        pricing: { input; output; cacheRead; cacheWrite5m; cacheWrite1h };
        limits: { contextWindow: number; maxOutputTokens: number };
        oauthLimits?: { contextWindow: number; maxOutputTokens: number };
        auth?: readonly ("oauth" | "apiKey")[];
      }[];
    },
  ];
}
```

**One endpoint, not two.** The console reads two different things today — the
catalog and the descriptor presentation slice — and they have different staleness
tolerances in principle. In practice the shell gates on a single fetch, so
splitting them would only add a second thing to wait for.

**Assembled in `packages/control`, not in the handler.** Rule 5: admin rules
belong there, and the route is then three lines matching `/api/models`. The
assembly reads `PROVIDER_DESCRIPTORS` and `PROVIDER_MODEL_CATALOG`, so a plugin
provider appears the moment the registry holds one — **this endpoint needs no
further change when the plugin host lands**, which is the property that makes it
worth building before there is a plugin to test it with.

**Deliberately excluded**: `tone` (CLI-only — it names a terminal colour and the
CLI owns the mapping), `capabilities` and `writeOverInput` (router internals the
console never reads). An endpoint that ships those invites a browser to depend on
them, and the router's own reads are the only ones that should exist.

`order` is sent rather than the array being pre-sorted. The console sorts by it
today and a wire order is not a contract; a client that re-sorted would be
correct either way.

## The console

### The gate

`useProviderCatalog()` follows `usePlugins` — long `staleTime`, no
`refetchInterval`, no push topic. The value cannot change under an open console
except across a restart, which §Staleness handles.

**The gate already exists and is `routes/_app.tsx`.** Its `beforeLoad` calls
`ensureQueryData` on `/api/status` before the shell renders, and its own comment
describes it as "the gate in front of every console screen". The catalog fetch
joins it there — same hook, same mechanism, one more `ensureQueryData`.

That placement is also what keeps the login page out of it. `/api/status` is the
one control route that answers without a session; `/api/catalog` is admin-gated,
and `_app.tsx` only runs after the status check has confirmed a session, so the
unauthenticated path never requests it. A 401 from anywhere else still redirects
through `isUnauthenticated`.

**It needs a real error state, not a spinner.** This is the design's sharpest
edge and is stated here so it is not discovered during an outage: gating the
shell means a failed `/api/catalog` makes the *whole* console unusable, where
today a provider-data problem could only affect the models page.

Concretely: a rejection in `beforeLoad` propagates to the router's error
component, so the work is to ensure that component renders an error with a retry
rather than a blank or a permanent spinner, and that it does **not** swallow the
`redirect` the status check throws for an expired session — those two failures
arrive through the same channel and must not be conflated.

### The palette

`GlobalStyle` stops emitting `--p-<id>` at module evaluation and takes the
palette from the loaded catalog. Because the shell gates, the first paint of
anything provider-coloured already has its colour.

That ordering is the whole reason the gate exists. An earlier draft injected the
custom properties after load and accepted one colourless paint — rejected because
`var(--p-unknown)` resolves to nothing and renders colourless *with no error*,
which a previous audit already flagged as a silent failure in this exact
variable. If the fetch failed, that state would be permanent and quiet.

### `draft.ts`

Its helpers — `catalogPrices`, `catalogTokenLimits`, `reachable`,
`reachableChoices`, `unreachableNote`, `blankTarget` — close over the imported
catalog. They become pure functions taking it as a parameter.

This is the largest edit and also an improvement independent of the goal: the
model-editor tests currently depend on the real 45-model catalog, so a pricing
change in `kilo/models.ts` can fail a test about draft state. With the catalog
passed in they take a two-provider fixture and assert on values they state
themselves.

### Files changed

`features/models/draft.ts`, `features/models/TargetEditor.tsx`,
`features/accounts/ConnectDialog.tsx`, `features/usage/ModelTrafficPanel.tsx`,
`theme/tokens.ts`, `theme/GlobalStyle.ts`, plus `api/queries.ts` for the hook and
the shell component for the gate.

## Staleness

The catalog changes only at gateway boot, so it gets no `res:` topic. Adding one
for data that changes once per process is the kind of thing the invalidation
table's own comment warns against.

**A restart mid-session leaves the console holding the previous process's
catalog**, and once plugins load providers that could mean a model picker
offering targets nothing can serve. An earlier draft of this section promised to
close that by invalidating on the `/health` transition. **That was wrong twice
over and is not built.**

The `/health` watcher arms only on a *console-initiated* restart
(`LifecycleControls`, `onSuccess: () => setWatching(true)`) and ends by calling
`window.location.reload()`, so an invalidation beside it would be dead code and
would miss every restart that matters — systemd, a deploy, `omni db restore`, a
crash.

The socket reconnect is the signal that would cover those, and the console
already has `invalidateEveryTopic` for it. It is deliberately not used here,
because its own comment states the rule: *"a reconnect says nothing about a
captured body or about which plugins are installed."* The catalog changes at boot
exactly as the plugin list does, and `/api/plugins` accepts the same staleness
for the same reason. Adding the catalog and not the plugin list would be a second
answer to one question.

So the staleness is **accepted and documented**, not closed: a console open
across an external restart may hold the previous process's catalog until it is
reloaded. If that ever needs fixing, it should be fixed for the plugin list at
the same time and by the same mechanism.

## Rules

**Rule 9 is retired.** Nothing browser-imports `@omni/providers/catalog`.

**Rule 12's allowlist loses both provider subpaths** — `catalog` and
`descriptors`. The console imports `@omni/store/types`, `@omni/ir` and
`@omnigateway/dashboard-sdk`, and gets provider data over `/api/*` like every
other piece of gateway state.

**`leafSubpaths.test.ts` stays, and still earns its place.** `packages/router`
reads `@omni/providers/descriptors` and must stay pure — the leaf property is
what lets it, and it is unaffected by the console no longer being a consumer.

## Testing

- **Round-trip completeness.** Every field the console reads survives assembly.
  The failure mode is a field silently dropped between the registry and the
  response: it typechecks, and it renders as an empty picker or a missing price.
  Asserted field by field against the registry rather than against a fixture of
  the response, so the test fails when a field is added to the descriptor and not
  to the endpoint.
- **The gate's failure path.** A rejected `/api/catalog` renders an error with a
  retry, not a spinner. This is the assertion that stops the sharp edge above
  from shipping as a hang.
- **The palette covers every provider in the response**, in both themes — the
  same both-themes check the descriptor registry already carries, moved to where
  the values now arrive.
- **`draft.ts` helpers against a fixture catalog**, not the real one. A test that
  passes only because `kilo` happens to list 27 models is testing the catalog.

## Risks

- **The gate is all-or-nothing.** Stated twice on purpose. Every console page now
  waits on provider data, including the logs view, which has nothing to do with
  providers.
- **Six files change at once.** They are independent of each other, so the work
  splits cleanly, but `draft.ts`'s signature change touches every caller of its
  helpers in the same commit.
- **A second consumer of the endpoint would change its shape.** It is scoped to
  what the console reads today. If the CLI ever wants it over HTTP — it should
  not; it runs in-process — the field set becomes a negotiation.

## Out of scope

- **`ModelTrafficPanel`'s catalog use.** It scans model ids only to attribute an
  upstream model name to a provider when no configured target matches. That is a
  question the server can answer directly in the usage response, and doing so
  would remove its dependency on the catalog entirely. Worth doing; not here,
  because it changes a response shape this design does not otherwise touch.
- **`authTypes` vs per-model `auth`.** The catalog states both deliberately, and
  the endpoint forwards both. Collapsing them is a catalog question, not an API
  one.
- Serving the catalog unauthenticated, or outside `/api/*`. Considered for the
  palette specifically, to avoid gating; rejected with the gate decision.
