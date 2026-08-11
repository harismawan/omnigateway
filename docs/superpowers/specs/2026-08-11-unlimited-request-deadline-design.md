# Unlimited Request Deadline Design

## Goal

Allow operator-selected unlimited inference duration without Bun's 255-second idle ceiling ending a request. Preserve downstream SSE keepalives, client cancellation, finite deadlines, and Anthropic/OpenAI response compatibility.

## Configuration contract

`settings.requestDeadlineMs` accepts non-negative integers:

- `0`: no OmniGateway dispatch deadline.
- Positive value: existing absolute deadline across routing, credential refresh, all attempts, and streamed body consumption.

Default remains `120_000`. Dashboard labels `0` as disabling request deadline. Existing saved positive values retain current behavior.

## Runtime behavior

Dispatch creates deadline state only for positive settings. Unlimited requests still use client `AbortSignal`; client disconnect aborts active provider request and releases stream resources. Finite requests retain timeout classification and cleanup.

Proxy inference routes call Bun's per-request `server.timeout(request, 0)` before authentication or dispatch. This removes Bun's 255-second nonzero idle maximum for `/v1/messages` and `/v1/chat/completions`. Server-wide `idleTimeout: 255` remains for every other route and as default protection.

Streaming responses keep sending `: keepalive` every 10 seconds during upstream silence. These comments protect Cloudflare and other intermediaries with read-idle limits while remaining invisible to Anthropic and OpenAI SSE parsers. Non-streaming requests cannot receive heartbeat bytes without changing their response contract; unlimited non-streaming traffic therefore still requires an intermediary whose origin read timeout is disabled or raised.

No separate upstream connect/header timeout is added in this change. Unlimited means provider connection, headers, and body can all wait until provider completion or client cancellation.

## Error behavior

- Positive deadline expires: existing gateway `TIMEOUT` behavior remains.
- Client or intermediary disconnects: request signal aborts dispatch, provider request is destroyed, and incomplete request logs retain cancellation behavior.
- Unlimited request: no timeout is synthesized by OmniGateway.
- Cloudflare streaming path: 10-second comments prevent its 125-second read-idle timeout after SSE response begins, assuming no buffering and an unblocked event loop.

## Tests

- Control schema accepts `requestDeadlineMs: 0` and rejects negatives.
- Dispatch with deadline `0` survives beyond a short observation window and ends on client cancellation.
- Existing positive deadline tests remain green.
- Proxy route calls per-request timeout override for both inference surfaces when a Bun server is present.
- Dashboard accepts and saves `0`, with copy explaining unlimited behavior.
- Full core, dashboard, typecheck, and lint suites run before completion.

## Scope

Change configuration validation, dispatch deadline construction, inference route server timeout handling, dashboard setting copy, and focused tests. Do not alter default deadline, keepalive cadence, provider transport pooling, or non-inference routes.
