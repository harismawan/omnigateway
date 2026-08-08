# Purpose-Specific Secret Opening Design

**Date:** 2026-08-08
**Status:** Approved

## Goal

Decrypt only credential secrets required by inference, OAuth refresh, and quota usage operations.
Preserve provider API-key support, current routing-snapshot behavior, token rotation, and existing error
semantics without caching plaintext.

## Scope

This change narrows secret reads for three production operations:

- Inference opens an OAuth access token or provider API key according to credential auth type.
- OAuth refresh opens only the refresh token.
- Quota usage opens only the OAuth access token.

Provider API-key credentials remain supported. The local CLI creates them through `credentials
add-key`, provider adapters accept them, and router quota handling distinguishes them from OAuth
credentials.

This change does not remove broad secret inspection from storage APIs that explicitly need it, cache
plaintext, change encryption format, migrate the database, alter OAuth exchange results, or change
provider request behavior.

## Types and boundaries

Add operation-specific secret types:

- `InferenceSecrets`: `accessToken` and `apiKey`, with exactly one selected according to `authType`.
- `RefreshSecrets`: `refreshToken`.
- `UsageSecrets`: `accessToken`.

`CredentialView` exposes purpose-specific lazy loaders:

```ts
openForInference(): Promise<InferenceSecrets>
openForRefresh(): Promise<RefreshSecrets>
openForUsage(): Promise<UsageSecrets>
```

Broad `CredentialSecrets` remains the persistence and OAuth-result shape because exchanges and
refreshes can return or rotate several token fields together. Existing `secrets()` access remains
available for explicit full-secret inspection and compatibility outside the three narrowed operation
paths. Production inference, refresh, and quota code must use purpose-specific loaders.

Provider `usage()` accepts `UsageSecrets` rather than `CredentialSecrets`. Provider adapters retain
their existing inference credential shape because they need either an OAuth access token or API key
plus provider metadata.

## SQLite implementation

Each purpose-specific loader selects only required encrypted columns and decrypts only selected,
non-null values:

- OAuth inference selects `access_token` and returns `{ accessToken, apiKey: null }`.
- API-key inference selects `api_key` and returns `{ accessToken: null, apiKey }`.
- Refresh selects `refresh_token`.
- Usage selects `access_token`.

`listRouting()` continues to exclude all secret ciphertext from snapshot construction. Its loaders
query current ciphertext by credential ID when an operation selects a candidate. This preserves
secret rotation visibility for cached routing views and prevents deleted credentials from retaining
recoverable ciphertext in memory.

Views produced by full `get()` and `list()` may open selected fields from their already-loaded row,
matching current snapshot semantics for those APIs. No plaintext result is cached.

## Operation data flow

### Inference

1. Dispatch selects a candidate without opening secrets.
2. `attempt()` calls `openForInference()` when no refreshed AUTH-retry result is present.
3. Loader branches on credential `authType` and decrypts exactly one field.
4. Adapter receives existing `{ accessToken, apiKey, providerData }` shape.
5. If a stale OAuth credential is refreshed first, returned `CredentialSecrets` supplies its new
   access token directly for that attempt; no second database read or decryption occurs.

### OAuth refresh

1. Refresher coalesces work by credential ID as today.
2. Winning refresh calls `openForRefresh()`.
3. Provider receives only refresh-token plaintext.
4. Provider result may contain multiple rotated fields and is persisted through `updateSecrets()`.
5. Refresher still returns full provider result so inference retry can use freshly returned access
   token without reopening storage.

### Quota usage

1. Probe skips non-OAuth credentials and providers without usage support.
2. If credential requires refresh, refresher returns fresh secrets and probe narrows that result to
   its access token.
3. Otherwise probe calls `openForUsage()` and decrypts only access token.
4. Provider `usage()` receives `UsageSecrets` plus existing provider metadata.

## Error handling

Current behavior remains:

- Opening a routing view after credential deletion throws `credential <id> no longer exists`.
- Malformed ciphertext in a required field throws during that operation.
- Missing required values remain `null`; existing operation or provider handling decides whether to
  reject or report no data.
- Malformed or missing unrelated ciphertext cannot affect an operation because it is neither selected
  nor decrypted.

No fallback opens broader secret material after a narrow loader fails.

## Testing

Add focused tests proving:

1. OAuth inference decrypts only `access_token` and returns a null API key.
2. API-key inference decrypts only `api_key` and returns a null access token.
3. Refresh decrypts only `refresh_token`.
4. Usage decrypts only `access_token`.
5. Malformed ciphertext in unrelated fields does not break each operation.
6. Malformed ciphertext in each required field fails its corresponding operation.
7. Routing views created before secret rotation load current required ciphertext by credential ID.
8. Routing loaders fail after credential deletion rather than using stale ciphertext.
9. Dispatch sends correct OAuth and API-key inference credentials.
10. Refresher works when access-token, API-key, or ID-token ciphertext is malformed but refresh-token
    ciphertext is valid.
11. Quota usage works when refresh-token, API-key, or ID-token ciphertext is malformed and no refresh
    is due.
12. Quota uses fresh access token returned by refresh without reopening storage.

Run changed-area tests, full `bun test`, dashboard tests, `bun run typecheck`, and `bun run lint`
before completion.

## Documentation completion

Only after all verification passes, mark `Performance opportunities / 4. Decrypt only secrets needed
by each operation` in `docs/2026-08-08-engineering-audit.md` as done and record concise implementation
and verification notes. If required verification fails, leave audit item unfinished and report
failure.
