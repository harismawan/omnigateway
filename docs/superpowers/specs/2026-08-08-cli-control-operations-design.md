# CLI Control Operations — Design

Date: 2026-08-08
Status: approved

## Problem

CLI credential creation and operational reads still call `Store` credential repositories directly.
That bypasses `packages/control`, despite control being shared admin-policy boundary for gateway HTTP
routes and CLI commands. Direct access lets validation, not-found behavior, defaults, projections,
and secret-handling policy drift between front ends.

This change completes audit recommendation "Route CLI admin operations through `packages/control`."
It covers every direct `store.credentials.*` access in `apps/cli/src/commands/credentials.ts` and
`apps/cli/src/commands/status.ts`.

## Scope

Move these operator operations behind control functions:

- read one secret-free credential projection;
- create provider API-key credential;
- force-refresh one OAuth credential and return its updated projection;
- read credential health and quota;
- read persistent status data: admin configuration, credential metadata, and quota windows.

CLI keeps terminal concerns: argument parsing, prompting, confirmation, notes, tables, JSON output,
process inspection, and exit-code rendering. CLI context remains responsible for opening local store.
CLI also keeps constructing production HTTP client and refresher for this change; injecting that
factory is separate audit item 6.

Gateway routes keep using current control operations. No new HTTP route or dashboard feature is added.

## Architecture

Use focused functional operations in `packages/control`, matching existing package style. Do not add a
stateful service object or repository-shaped wrappers.

`packages/control/src/credentials.ts` owns credential repository access and operator-visible
projections. New functions are exported through `packages/control/src/index.ts`:

- `getCredential(store, id)` returns one `CredentialSummary` and throws a canonical
  `GatewayError("BAD_REQUEST", "no such credential")` when absent.
- `createApiKeyCredential(store, input)` validates provider, key, and optional label; applies standard
  credential defaults; generates an ID; persists secret material; and returns a secret-free summary.
- `refreshCredential({ store, refresh }, id)` resolves credential, rejects API-key credentials,
  invokes injected refresher, reloads current metadata, and returns updated secret-free summary.
- Existing `credentialHealth(store)` supplies health and quota data to CLI health output.
- `credentialStatus(store, options)` returns persistent status projection containing
  `adminConfigured` and credential rows with attached quota windows.

`apps/cli/src/commands/credentials.ts` calls these functions after gathering argv and prompt input.
`apps/cli/src/commands/status.ts` combines CLI-owned process status with control-owned persistent
status. Neither file may call `store.credentials.*` directly after this change.

## Operation Contracts

### Secret-free projection

All read operations return `CredentialSummary`, never `CredentialView`. Secret-loader functions and
plaintext provider secrets do not cross control boundary. Projection remains explicit so future store
fields are not exposed by accident.

### API-key creation

Input contains provider, API key, and optional label. Control validates:

- provider is `anthropic`, `openai`, or `kimi`;
- API key is non-empty;
- optional label is normalized consistently; blank label uses `${provider} api key`.

Persisted defaults remain:

- `authType: "apiKey"`;
- enabled;
- tier and weight equal to 1;
- no expiry, account email, provider state, disabled state, or OAuth secrets.

Returned value contains created credential metadata only. Raw API key is never returned.

### Refresh

Control performs lookup and auth-type policy. Missing credentials and API-key credentials produce
operator-safe `GatewayError` failures. Refresher remains injected so control has no hard-coded HTTP
client and tests use stubs. Provider failures pass through unchanged. Successful refresh reloads
credential and returns current expiry metadata.

### Status

Persistent status projection contains:

- whether admin password is configured;
- each credential's ID, provider, label, enabled state, and all provider-reported quota windows.

Process state, supervisor, installation root, and database-open errors remain CLI concerns. When store
cannot open, CLI still reports process state and store error without calling control.

## Error Handling

Control functions throw `GatewayError` for invalid input and missing resources. Existing CLI top-level
error mapping converts these into current operator exit code and message. Prompt cancellation and
password-confirmation failures remain `CliError` because they are terminal-only behavior.

No error includes provider secrets. No JSON or human output includes API keys, OAuth tokens, secret
loaders, or encrypted values.

## Testing

Add narrow control tests before implementation:

- API-key creation defaults, custom and blank labels, invalid provider, empty key, and no secret in
  returned projection;
- credential lookup success and missing-resource error;
- refresh success, missing credential, API-key rejection, provider failure propagation, and updated
  expiry projection;
- health operation returns health and quota together;
- status projection attaches quota windows and reports admin configuration.

Retain and extend CLI behavior tests for add-key, show, health, refresh, and status. Add a source-level
boundary assertion that target CLI command files contain no `store.credentials` access, preventing
future regression to repository calls.

Completion requires focused control and CLI tests, root `bun test`, dashboard tests,
`bun run typecheck`, and `bun run lint`.

## Non-goals

- Moving admin password mutation behind a new operation; it already uses `createAdminAuth` from
  control and does not access credential repositories.
- Moving process/service state into control.
- Changing gateway HTTP contracts.
- Adding dashboard API-key creation.
- Injecting CLI refresh HTTP/refresher construction; tracked separately by audit item 6.
- Refactoring unrelated CLI commands that already call control functions.
