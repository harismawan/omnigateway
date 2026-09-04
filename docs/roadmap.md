# Roadmap

What is not built yet, and why — ranked by how real the gap is against how small the
change would be. Every entry below is a gap this repository's own documentation or
code already declares; nothing here is speculative demand.

This file is a backlog, not a promise. An item earns a
[spec](superpowers/specs/) before it earns code.

## Worth building

### Scheduled snapshots

`README.md` says snapshots are manual and local: *"Nothing takes one on a schedule."*

The maintenance loop in `apps/gateway/src/maintenance.ts` already runs on an
interval and already *prunes* snapshots against `keepLatest` — it has simply never
taken one. The change is an interval plus a `createSnapshot` call inside machinery
that exists, with retention already written.

Smallest real diff on this page. Off-host targets stay out of scope: copying a file
somewhere is a job for the host, not the gateway.

### Gateway key expiry

Gateway keys carry `limits` and `modelAllowlist` and nothing that ends them. The
`expiresAt` field in `packages/store/src/types.ts` is a *credential's* OAuth token
expiry — an API key handed to a contractor is good forever.

Needs a column on `api_keys`, a check in `authenticateApiKey`, and a third
editable-after-mint field, which inherits the written-whole rule the other two
follow: `{}` is how the last limit goes away, so a patch would have no way to
express removal.

`bodyLoggingOptOut` stays uneditable regardless — it is a promise to whoever holds
the key.

### Observability: `/metrics` and traces

Designed:
[2026-09-04-observability-design.md](superpowers/specs/2026-09-04-observability-design.md).

Nothing exposes a scrape endpoint, and the `k8s/` kustomize base ships without one.
`apps/gateway/src/stream/registry.ts` already computes `{connections, dropped,
queued}` that no route reads.

### Searching captured bodies

`README.md`: *"`omni bodies` reads one request's capture; nothing searches across
them."*

The highest privacy blast radius on this page — body capture is forensics, opt-in
behind two keys, and a search surface turns it into a queryable prompt corpus.
Would need `requireAdmin` and the existing `MASK_RULES` applied to output, not just
to storage.

## Belongs in a plugin, not the core

**Spend and quota alerting** — a webhook when a key crosses a budget, or when an
account's quota pace says it will not survive the window.

The plugin host, the event bus, `RequestCompleted`, and the broadcast channel with
its burst cap all exist for exactly this. Putting a notifier in the core buys a
configuration surface, a retry policy and an outbound origin that nobody asked the
gateway for. See [writing-a-plugin.md](writing-a-plugin.md).

## Deliberately not planned

- **Request-shape preflight.** `README.md` already scopes this out: the gateway does
  not know which model accepts which request shape, and an unsupported combination
  surfaces as the provider's own 400. Doing better means per-model capability tables
  that go stale silently, which is worse than a clear upstream error.
- **Semantic caching and billing.** Named as out of scope in `README.md`. Each is its
  own product, not a feature.
- **Multi-tenancy.** The gateway has one operator with two narrower views; every
  provider account is the operator's, whoever is looking. Tenancy would touch every
  scope decision in `packages/control`.
- **More built-in providers.** The `custom` provider already serves any
  OpenAI-compatible endpoint, and
  [adding-a-provider.md](adding-a-provider.md) exists so a new one can ship as a
  plugin without core changing. A vendor earns a built-in by needing wire behaviour
  `custom` cannot express, not by being popular.
