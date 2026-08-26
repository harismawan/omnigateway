# WebSocket Transport — Design

Date: 2026-08-22
Status: Approved — implemented, with two recorded deviations

## Deviations taken during implementation

Both were decided deliberately and are recorded here rather than in a commit message, because the
next reader of this file will otherwise find code that does not match it and assume the code is
wrong.

**1. Upgrade auth is admin-session only.** The endpoint section below offers a second arm — a bearer
machine token from `plugin_machine_tokens` — but that table and its `routes:machine` capability come
from [the remote control plugin design](2026-08-22-remote-control-plugin-design.md), which is marked
*Draft — incomplete. Do not implement from this file.* Building it here would have front-run a design
still being written. The connection principal is nevertheless the full discriminated union this
document specifies, so the machine arm lands later as a different `revalidate` thunk with no change
to the registry. Presenting both a bearer token and an admin cookie is already refused.

**2. The SDK shipped as `0.1.2`, a patch, not the `0.2.0` minor named below.** The claim here that a
pre-1.0 minor is the honest signal is wrong in a way `packages/plugin-api/src/version.ts:38-44`
already recorded: `^0.1.0` desugars to `>=0.1.0 <0.2.0`, so `0.2.0` does not *ask* plugin authors to
move their range — it disables the UI of every plugin already published, immediately, each reported
as a mismatch it did nothing to earn. Both halves of the change are additive: `cadence` gained an
optional argument, and `connection` landed on a type plugins consume and cannot construct, because
`LiveContext` is not exported. What a patch costs is the mechanical signal, and that is the cheaper
of the two costs.

Two smaller notes, for anyone diffing this document against the code:

- The **testing** section's last bullet asks for the assertion at
  `docs/superpowers/plans/2026-07-31-omnigateway-dashboard.md:6231` to be inverted. It was not. That
  line is a completion checklist inside a finished plan — a record of what was true in July, not a
  live test — so it carries a superseded-by note pointing here instead of being rewritten.
- `subscribe` on a `stream:*` topic with no source behind it answers `error` through one generic
  rule (the broadcaster only serves topics a source has `declareStream`d), rather than through a
  console-specific check. That covers the `none` console source this document names and every future
  plugin stream whose source failed to start.

## Problem

Polling is the gateway's only push mechanism. That was a deliberate choice, made three times: the
original design specified `WS /admin/stream`
([2026-07-31 core design](2026-07-31-omnigateway-design.md), lines 126 and 562-563) and the
implementation dropped it — `docs/superpowers/plans/2026-07-31-omnigateway-dashboard.md:24` records
"**There is no WebSocket**", and `:6231` asserts at test level that
`grep -rni "websocket" apps/dashboard/src` finds nothing. It was refused again in the
[dashboard redesign](2026-08-05-dashboard-redesign-design.md) and in the
[Claude setup design](2026-08-10-claude-setup-and-dashboard-scroll-design.md). The consequence is
written into published code: `packages/dashboard-sdk/src/live.ts:31-32` says "Polling is the
gateway's only push mechanism — there is no log socket."

That answer was correct for the workload it was answering. Every polled surface is a resource whose
value changes occasionally and can be re-read whole: usage at 60s, credential health at 10s, console
at 5s, logs at 2s. None of them needs a socket.

The workload changed. The
[remote control plugin](2026-08-22-remote-control-plugin-design.md) drives Claude Code sessions from
a browser and later a phone: keystroke-latency commands downward and token deltas upward, which is a
stream and not a resource. Polling can carry it — the RC draft describes long-poll plus batched
POSTs — but only by being a worse socket. This design adds the transport properly, once, in core,
and moves the console's polled surfaces onto it where push is genuinely better.

## Scope

In scope:

- One multiplexed WebSocket endpoint in the gateway, host-owned.
- A `channels` plugin capability so a plugin can own namespaced topics without touching the socket.
- Migration of the dashboard's polled surfaces to push, with polling retained permanently as a
  fallback.
- Reverse-proxy documentation, which does not exist in this repository in any form today.

Out of scope:

- `/v1/*`. The proxy path's SSE is a client compatibility contract with Anthropic and OpenAI
  semantics and does not move. `sseResponse` (`apps/gateway/src/routes/proxy.ts:226-313`) stays
  exactly as it is, including the run-once completion that releases a streaming request's
  concurrency slot.
- The `/health` restart watcher. It stays a plain `fetch` poll, for the reason it exists.
- Durable delivery. Nothing here is a queue.

## Decisions

Each was chosen explicitly; several look arbitrary alone.

1. **Transport primitive and the console, together.** Not the primitive alone — a socket with one
   consumer is a socket nobody tests.
2. **Polling stays forever as a fallback, not as a migration aid.** Both paths stay live and tested.
3. **Hybrid payloads, split by a rule:** REST resources push invalidations, true streams push
   payloads.
4. **One multiplexed endpoint**, not one per feature or per plugin.
5. **This lands before the RC plugin.** RC is born on the socket; no throwaway long-poll transport
   is written.

## Endpoint and connection lifecycle

`.ws("/api/stream")`, registered in the `createApp` chain (`apps/gateway/src/app.ts:222-316`) before
the static catch-all, which already refuses `/api` and `/v1` prefixes (`app.ts:334-338`).

**Auth at upgrade.** `requireAdmin(request, admin)` (`apps/gateway/src/routes/http.ts:28-33`) is
reused unchanged — it takes a whole `Request`, so an upgrade request satisfies it as-is.
Alternatively a bearer machine token from `plugin_machine_tokens`, the table introduced by the RC
plugin design's `routes:machine` capability. Presenting both is a conflict and is refused, matching
the `/v1/*` rule. The verified principal — `{ kind: "admin" }` or `{ kind: "machine", tokenId,
pluginId }` — is pinned to the connection and decides which topics it may subscribe to.

**A socket must not outlive its session.** The admin session TTL is 12h (`app.ts:118`). A connection
authenticated once would otherwise survive expiry indefinitely, which is a real privilege bug rather
than an inconvenience. The server re-verifies the principal on every heartbeat and closes `4401` on
expiry or revocation. The client treats `4401` as "authenticate again" and does not reconnect.

**Heartbeat.** Server ping every 20s; close on a missed pong at 60s. `idleTimeout: 255`
(`apps/gateway/src/index.ts:267`) is already Bun's maximum and accommodates this.

**Registry.** New `createSocketRegistry()` in `apps/gateway`: the connection set plus a topic index.
This is genuinely new state — today the only per-connection registry in the process is
`admitted = new WeakMap<Request, () => void>` (`app.ts:213`), and nothing tracks streams at all. The
registry joins `stopLoops` (`index.ts:270-287`) and closes every socket before `app.stop()`, inside
the existing `STOP_DEADLINE_MS = 5_000` (`apps/gateway/src/lifecycle.ts:36`).

**Quiesce and database swap.** `/api/stream` is not client traffic, so the quiesce latch does not
gate it, by the same rule that keeps `/api/*` and `/health` live through a restore
(`apps/gateway/src/quiesce.ts:12-16`, `app.ts:146-157`). Sockets stay open across a swap: store repo
methods forward per call, so no connection holds a handle that a swap invalidates. After `reopen()`
succeeds, the broadcaster emits a global invalidate.

**Restart.** The registry closes every socket with `1001` and a `restart` reason. The `/health`
watcher in `apps/dashboard/src/components/LifecycleControls.tsx:102-201` is untouched — 750ms poll,
90s deadline — because the one check that proves the gateway came back must not depend on the
subsystem being restarted.

## Protocol

JSON frames.

Client → server:

```
{ id?, type: "subscribe" | "unsubscribe" | "send", topic, sinceSeq?, payload? }
```

Server → client:

```
{ type: "event" | "ack" | "error" | "gap", topic, seq?, payload? }
```

Two topic classes. The class is the delivery contract, not a hint.

### `res:<name>` — invalidation

Payload carries at most `{ keys }`. No sequencing, no replay, no ordering guarantee. A dropped frame
is self-healing: the next change re-invalidates, and a reconnecting client invalidates everything
before resubscribing. Covers `res:usage`, `res:logs`, `res:quota`, `res:credentials`, `res:keys`,
`res:settings`, `res:models`.

This class exists so that push and poll cannot disagree. Both paths end in the same REST fetch and
the same serializer, so there is no second rendering of any resource and no bug where the socket
shows one number and a reload shows another.

### `stream:<name>` — payload

Monotonic `seq` per topic. The server keeps a bounded ring per topic (frame count and byte cap,
both configured in one place). `subscribe { topic, sinceSeq }` replays from the ring; when the ring
has already passed that point the server answers `gap` and the client performs a full REST fetch
instead of pretending continuity. Covers `stream:console` and, once RC lands,
`plugin:rc:session:<id>`.

**Never claim gapless.** A bounded ring plus an explicit `gap` is the entire contract. Silent
skipping is the failure this class exists to prevent.

### Plugin topics

`plugin:<id>:<name>`, in either class, handed to the plugin by the host through a new `channels`
capability. The plugin receives `{ onMessage, send, onClose }` and never touches a socket, an
upgrade request, or a header — the same posture as `routes:machine`. Subscription is authorised by
the host against the connection's principal.

Per-subscriber send queues are bounded and **drop rather than grow**, matching the plugin event bus
(`apps/gateway/src/plugins/events.ts:11`). A handler that throws is caught and counted per plugin;
the connection is unaffected.

## Server-side sources

One `Broadcaster` in the app dependencies. Emitters live where state changes:

| Emitter | Topic | Site |
| --- | --- | --- |
| `finishLog` | `res:usage`, `res:logs` | already the one site running at most once per request id — the same reason the usage debit and `RequestCompleted` live there |
| admin mutation handlers | `res:keys`, `res:credentials`, `res:settings`, `res:models` | `apps/gateway/src/routes/admin.ts` |
| quota poller | `res:quota` | `apps/gateway/src/quota/poller.ts:41` |
| OAuth refresh scheduler | `res:credentials` | `apps/gateway/src/oauth/scheduler.ts:84` |
| database swap | global invalidate | after `reopen()`, `apps/gateway/src/routes/database.ts:66-165` |

### Coalescing is mandatory

At 100 requests per second, a per-request `res:usage` frame is 100 client refetches per second,
against a surface that polls at 60s today. Uncoalesced push is strictly worse than the polling it
replaces, and this is the easiest way for this change to make the product slower.

Every topic passes through a leading-plus-trailing coalescer with a floor: 1s for `res:usage` and
`res:logs`, 5s for `res:quota` and `res:credentials`. The trailing frame is never dropped, so the
last change always reaches the client. The coalescer is a named component with its own tests and an
injected clock, not an implementation detail of the broadcaster.

### Console has no stream underneath it

`tailFile` seeks backward from EOF on every call (`packages/control/src/tail.ts:31`), and the
journald source shells out through the injected `CommandRunner`
(`packages/control/src/console.ts:42-44`). Neither is a stream, and the design says so rather than
implying otherwise:

- `OMNI_LOG_FILE`: `fs.watch` plus a read from the last byte offset; deltas published on
  `stream:console`.
- journald: continue polling with the `since` cursor that exists for exactly this purpose
  (`console.ts:61-66`); deltas published on the same topic. Server-side polling, client-side push.
- `none`: `subscribe` answers `error`; the panel behaves as it does today.

## Client integration

One connection per tab, provider mounted beside `LiveProvider` at
`apps/dashboard/src/routes/_app.tsx:28`.

**react-query wiring.** A `res:*` frame maps through a single topic → query-key table to
`invalidateQueries`. On reconnect: invalidate every `res:*` key, then resubscribe `stream:*` topics
with `sinceSeq`.

**Call sites do not change.** `cadence()` gains a topic argument — `cadence(60_000, "res:usage")` —
returning `false` when that topic is pushed on a healthy socket and the existing interval otherwise.
The LIVE switch keeps meaning "am I refreshing". Every existing call site keeps its shape:
`UsageBoard.tsx:82-97`, `OverviewBoard.tsx:31-38`, `LogsBoard.tsx:117`, `ConsoleBoard.tsx:130`,
`ChassisBar.tsx:95`, `AccountsBoard.tsx:114`.

**SDK change.** `LiveContextValue` gains the topic-aware `cadence` and a `connection` field, and the
"no log socket" comment at `packages/dashboard-sdk/src/live.ts:31-32` is deleted. This is a pre-1.0
minor on `@omnigateway/dashboard-sdk`, which by that package's own stated rule is a breaking change:
every plugin's `sdk` range must move. A stale range disables that plugin's UI only; its server half
keeps running (`apps/gateway/src/plugins/loader.ts:316-324`). The SDK remains in `SHARED_IMPORTS` —
a second copy is a second context object, and the failure is silent.

**Fallback is visible and permanent.** An upgrade failure, or three drops within 60s, switches to
polling; the socket is retried with backoff capped at 30s. `ChassisBar` renders four states:
`LIVE·PUSH`, `LIVE·POLL`, `PAUSED`, `OFFLINE`. A user behind a proxy that strips `Upgrade` sees
`LIVE·POLL` and everything keeps working, which is the whole point of keeping both paths.

## Failure modes

| Condition | Behaviour |
| --- | --- |
| Proxy strips `Upgrade` | fall back to polling, show `LIVE·POLL`, retry with capped backoff |
| Socket drops | reconnect; invalidate all `res:*`, resubscribe `stream:*` with `sinceSeq` |
| `sinceSeq` older than the ring | `gap` frame, client does a full REST fetch |
| Admin session expires | close `4401`; client stops reconnecting and shows login |
| Machine token revoked | same `4401` path at the next heartbeat |
| Slow consumer | bounded queue drops oldest, increments a counter, one batched warn |
| Gateway restart | registry closes `1001`; the unchanged `/health` watcher drives the reload |
| Database swap | sockets stay open; global invalidate after `reopen()` |
| Emitter storm | coalescer floor holds; frames per second stay bounded regardless of request rate |
| Console source is `none` | `subscribe` answers `error` |
| Plugin channel handler throws | caught, counted per plugin, connection unaffected |
| Two tabs | independent connections, no shared state |

## Testing

- **Registry**: subscribe, unsubscribe, topic indexing, and close-all on shutdown leaving no timers
  or listeners — the discipline the deadline tests already hold.
- **Upgrade auth matrix**: admin cookie, machine token, both together (refused), neither, and
  expiry mid-connection producing `4401`.
- **Coalescer**, injected clock: 100 emits within the floor produce one leading and one trailing
  frame, and the trailing frame is never dropped.
- **Replay**: `sinceSeq` inside the ring replays exactly those frames; beyond the ring produces
  `gap` and never a silent skip.
- **Backpressure**: a slow consumer drops oldest, increments the counter, and the queue does not
  grow.
- **Lifecycle**: a swap keeps sockets open and emits the global invalidate; restart closes `1001`;
  the quiesce latch does not gate `/api/stream`.
- **Dashboard**, happy-dom: new `test/helpers/socketStub.ts` beside `test/helpers/fetchStub.ts`.
  `cadence` returns `false` when pushed and the interval when not; the four `ChassisBar` states
  render with correct accessible names; reconnect invalidates.
- **Fallback anchor**: with the socket disabled, every board still refreshes on its interval.
  Without this the fallback rots unnoticed until someone's nginx eats an `Upgrade`.
- Invert the assertion at `docs/superpowers/plans/2026-07-31-omnigateway-dashboard.md:6231`.

Mutation targets named explicitly, because a green suite here would otherwise prove little: the
coalescer floor, `gap` detection, the `4401` close, and the drop counter.

## Documentation and invariant changes

- `CLAUDE.md` rule 12: the dashboard may open `/api/stream`. Rule 15 and the plugin section: the
  `channels` capability. A new runtime trap: the socket registry closes before `app.stop()`, and the
  `/health` watcher deliberately does not use the socket.
- `ARCHITECTURE.md`: a push-transport section, and socket close ordering in the lifecycle section.
- `README.md`: reverse-proxy guidance — nginx `Upgrade`/`Connection` headers and a
  `proxy_read_timeout` above the heartbeat, a note that Caddy and Cloudflare pass WebSockets by
  default, and an explanation of the existing `x-accel-buffering: no` header while we are there.
- `docs/writing-a-plugin.md`: the `channels` capability and topic naming.
- `packages/dashboard-sdk/src/live.ts`: the "no log socket" comment, plus the SDK version bump.

## References

- [2026-08-22 Remote control plugin design (draft)](2026-08-22-remote-control-plugin-design.md)
- [2026-07-31 Core design](2026-07-31-omnigateway-design.md) — the original `WS /admin/stream`
- [2026-08-05 Dashboard redesign](2026-08-05-dashboard-redesign-design.md) — where it was refused
- [2026-08-19 Plugin host design](2026-08-19-plugin-host-design.md)
- [2026-08-21 Federating the SDK](2026-08-21-federating-the-sdk-design.md)
