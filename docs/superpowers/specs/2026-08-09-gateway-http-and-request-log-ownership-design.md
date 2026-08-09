# Gateway HTTP and Request-Log Ownership Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Remove two gateway-local ownership ambiguities without changing control-layer boundaries:

1. Admin and connect routes share one implementation of session cookies, admin authorization, JSON
   parsing, and `/api/*` error rendering.
2. Each proxied request receives one ID from the route, and every response and request-log path uses
   that ID.

This work does not move HTTP concepts into `@omni/control`, change session-cookie security policy, or
redesign dispatch.

## Gateway HTTP utilities

Add `apps/gateway/src/routes/http.ts` as the gateway-local boundary for HTTP control-surface concerns.
It exposes focused helpers for:

- reading one cookie from a request;
- rendering the admin session cookie used by setup, login, and logout;
- verifying the admin cookie and throwing `AUTH` when no valid session exists;
- parsing an arbitrary JSON body;
- parsing a JSON object body;
- converting route failures into the canonical `/api/*` JSON error response.

Both admin and connect route groups install the same Elysia error hook and call these helpers rather
than maintaining route-local copies. `packages/control` remains independent of Elysia, cookies,
requests, and response rendering.

Session-cookie behavior stays unchanged in this refactor. `Secure` continues to derive from the
request URL scheme. Changing that policy from the configured public origin remains separate audit
work.

## Error contract

Every `/api/*` failure rendered by these route groups has this shape:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "invalid JSON body"
  }
}
```

Rules:

- A `GatewayError` preserves its code, message, and `HTTP_STATUS` mapping.
- An unknown exception becomes `500 INTERNAL` with message `internal error`; internal exception
  messages are not returned to clients.
- Malformed JSON becomes `400 BAD_REQUEST` with message `invalid JSON body`.
- A syntactically valid JSON value that fails operation-specific validation remains the operation's
  error. In particular, login with a missing or incorrect password remains `401 AUTH`.
- Setup conflicts remain `409 CONFLICT`.
- Connect polling still returns `202` while pending.

Admin handlers may continue returning explicit successful or conflict payloads where control flow
requires setting response state. All thrown failures use the shared hook.

## Request-log factory

Add `newRequestLog` to `apps/gateway/src/logging.ts`. It creates a complete `RequestLog` from required
identity and time fields plus explicit overrides, supplying neutral defaults for routing, token,
cost, timing, status, error, and degradation fields.

The factory is the only gateway production code that spells out the complete default request-log
shape. These paths use it:

- route-selected pending log;
- dispatch's mutable final log;
- route-level exception log.

`beginLog`, `routeLog`, and `finishLog` retain their current persistence and error-isolation behavior.
Pending rows still contain placeholder zero measurements and are distinguished by `state`.

## Request ID ownership and data flow

The proxy route owns request identity:

1. Route calls injected `requestId()` once when handling begins.
2. Route uses that ID for client response IDs and pending or exception logs.
3. Route passes the ID into `dispatch` as an explicit argument.
4. Dispatch initializes its log with `newRequestLog` and the supplied ID.
5. Final logging persists `outcome.log()` directly, without overwriting its ID.

Dispatch no longer calls `crypto.randomUUID()`. This keeps identity generation injectable and ensures
client response, pending row, route updates, dispatch result, and exception completion all refer to
one request.

Timing ownership does not change. Route-level start time remains the timestamp for pending and
pre-dispatch exception rows. Dispatch takes its own start timestamp for deadline and duration logic.
The shared ID, not timestamps, links these paths.

## Tests

Add or update narrow behavior tests for:

- cookie parsing and session-cookie rendering through shared utilities;
- admin authorization success and failure;
- malformed JSON producing the canonical `400 BAD_REQUEST` response;
- unknown exceptions producing redacted `500 INTERNAL` responses;
- admin and connect routes using identical error shape;
- malformed connect JSON returning 400;
- malformed login JSON changing from 401 to 400 while valid JSON without a password remains 401;
- setup conflict and connect pending behavior remaining unchanged;
- dispatch logs carrying the caller-supplied request ID;
- proxy success, dispatch failure, and pre-dispatch exception paths persisting the one generated ID;
- request ID factory being called once per proxied request.

Run focused gateway route and dispatch tests, then repository-required verification: root tests,
dashboard tests, typecheck, and lint.

## Non-goals

- Deriving cookie security from `OMNI_BASE_URL`.
- Trusting forwarded headers.
- Moving HTTP helpers into `packages/control`.
- Changing client `/v1/*` error formats.
- Decomposing dispatch beyond ID and log initialization ownership.
- Changing request-log persistence, rollup, retention, or pending-row semantics.
