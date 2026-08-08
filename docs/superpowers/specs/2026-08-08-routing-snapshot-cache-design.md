# Routing Snapshot Cache Design

**Date:** 2026-08-08
**Status:** Approved

## Goal

Remove full routing-snapshot reconstruction from every proxied request while preserving current
next-request visibility for gateway control writes and CLI writes from another SQLite connection.
Snapshots remain immutable for each request. Credential ciphertext must not be selected during
snapshot construction.

## Scope

This change covers gateway dispatch snapshot caching, routing-change observation in the SQLite
store, metadata-only credential reads, and tests for consistency and query reduction. Control-plane
`dryRun` remains uncached because it is low-volume and should read current state directly.

This change does not add a TTL, cache plaintext secrets, change routing behavior, repair concurrent
health-transition semantics, or cache API-key authentication data.

## Architecture

The gateway owns one process-local `RoutingSnapshotCache`, shared by every dispatch. App composition
creates it and injects its snapshot provider into proxy dependencies. A dispatch captures one
snapshot reference at request start and uses that immutable view for ranking and retries.

The store exposes two routing-consistency seams:

1. A routing version backed by SQLite `PRAGMA data_version`. It changes when another connection,
   such as the local CLI, commits data visible to the gateway connection.
2. A subscription for routing changes written through the gateway's own store connection. SQLite
   does not change a connection's observed `data_version` for that connection's own writes, so local
   repository writes must emit explicit events.

Routing-change events are:

- `healthSaved`
- `quotaSaved`
- `credentialsChanged`
- `modelsChanged`
- `settingsChanged`

Repository methods emit events only after successful writes. Listener execution performs only
synchronous, non-throwing cache state changes, so subscriber behavior cannot turn a successful
SQLite write into a failed operation.

## Snapshot lifecycle

On first `get(now)`, the cache builds a complete routing snapshot and records current SQLite data
version. Concurrent cold callers share one in-flight build promise.

On later calls:

- Matching data version and a valid snapshot return the cached snapshot reference.
- A changed data version means another SQLite connection committed. The cache rebuilds all routing
  state before returning.
- A local credential, model, or settings event marks the snapshot stale. Next `get` rebuilds before
  returning.
- A local health event creates a new snapshot with a copied health map containing changed rows.
- A local quota event creates a new snapshot with a copied quota map. For each credential named by
  the event, its entire quota-window array is replaced, matching `saveQuota` repository semantics.

Every replacement is atomic at the JavaScript reference level. Existing requests retain their old
snapshot; later requests receive the replacement.

A rebuild latch is cleared on success and failure. Failed initial builds leave no snapshot. Failed
rebuilds do not serve a snapshot known to be stale, because doing so could route through a disabled
credential or removed model. Later requests retry the rebuild.

## Credential metadata query

Snapshot construction uses a new metadata-only credential query rather than current `SELECT *`.
The query selects routing fields plus whether a refresh token exists, but excludes access-token,
refresh-token, API-key, and ID-token ciphertext.

Each returned `CredentialView` retains a `secrets()` thunk. When dispatch attempts that credential,
the thunk performs a focused encrypted-column lookup by credential ID and decrypts secrets then.
Existing full `list()` and `get()` behavior remains available to control, scheduler, quota, and CLI
callers.

If a credential disappears between snapshot creation and secret opening, secret resolution fails as
an upstream attempt error rather than recovering deleted secret material from memory.

## Data flow

### Startup

1. Open store.
2. Create routing snapshot cache.
3. Subscribe cache to local routing changes.
4. Inject snapshot provider into proxy dispatch dependencies.

The first proxied request performs initial loading; app construction remains synchronous.

### Request

1. Dispatch records request start time.
2. Cache checks SQLite data version.
3. Cache returns valid snapshot or shares/rebuilds stale snapshot.
4. Dispatch resolves model, ranks candidates, and runs attempts against captured snapshot.

### Local writes

- Health and quota saves patch corresponding immutable maps.
- Credential creation, metadata updates, secret/expiry updates, removal, model writes, model removal,
  and settings writes invalidate full snapshot state.
- Failed writes produce no event.

### External writes

Any committed write from another SQLite connection changes `PRAGMA data_version`. Next dispatch
rebuilds before ranking. This preserves current next-request visibility for CLI changes without an
unversioned TTL.

## Testing

Add focused tests proving:

1. Unchanged cache reads return one snapshot and execute one full build.
2. Concurrent cold reads share one build.
3. Local health saves update routing state without a full rebuild.
4. Local quota saves replace affected credential windows without a full rebuild.
5. Local credential, model, and settings writes force rebuild before next cache result.
6. A write through a second SQLite connection changes data version and forces next-read rebuild.
7. Failed rebuilds never return known-stale snapshots and later reads retry.
8. Routing credential query excludes ciphertext fields.
9. Selected credential secret thunk still loads and decrypts correct secrets.
10. Repeated dispatches avoid repeated full routing-table reads.
11. Route integration observes credential disablement and model edits on next request.

Run changed-area tests, full root tests, dashboard tests, typecheck, and lint before completion.

## Documentation completion

Only after all verification passes, mark `Performance opportunities / 1. Cache routing snapshots` in
`docs/2026-08-08-engineering-audit.md` as done and record concise implementation and verification
notes. If any required verification fails, leave audit item unfinished and report failure.
