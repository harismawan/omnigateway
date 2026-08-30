# Plugin channels: the client half

## Problem

The server half of plugin channels is complete and unreachable.

A plugin declaring the `channels` capability receives `{ open }` and calls
`ctx.channels.open("session")`, which registers `plugin:<id>:session` in the
channel registry (`apps/gateway/src/stream/channels.ts`). The gateway
authorises an admin principal to hold that topic
(`apps/gateway/src/routes/stream.ts`, `authorised`), accepts client `send`
frames on it, and refuses a send from a connection that has not subscribed.

No browser can subscribe to it.

Three facts, each independently sufficient:

1. **The console never asks for a plugin topic.** `subscribeAll` in
   `apps/dashboard/src/session/stream.tsx` iterates `RES_TOPICS` and
   `STREAM_TOPICS`, both derived in `session/invalidation.ts` from
   `TOPIC_QUERIES` — a compile-time table of seven `res:*` keys plus
   `stream:console`. A plugin's topic name is not known at build time and could
   not be added to that table from this repository even if it were.
2. **The SDK exports no way to listen.** `useStreamTopic`, the hook that
   actually receives frames, is in the console's private `session/stream.tsx`.
   `@omnigateway/dashboard-sdk` exports `createPluginApi`, `pluginApiPath`,
   `usePluginApi`, `Cadence`, `LiveConnection`, `LiveContextValue`,
   `LiveProvider`, `useLive`, `CSS_VARIABLES` and `definePluginUI`. None of
   them reaches the socket.
3. **`cadence` therefore lies by omission.** `connection.pushed(topic)` is
   `pushing && acked.has(topic)`, and `acked` only ever holds topics the
   console subscribed to. `cadence(10_000, "plugin:pokemon:companion")` returns
   `10_000` forever, so a panel that correctly names its own topic goes on
   polling and has no way to find out why.

A plugin can push frames nobody subscribes to, and can ask whether it is being
pushed and always hear no. Both halves of this are gateway and console
concerns, not plugin ones.

## What this adds

A panel calls one hook:

```ts
const { status, send } = usePluginChannel(pluginId, "session", (payload) => {
  // one frame from the plugin's own channel
});
```

`status` is `"idle" | "open" | "refused"`. `send(payload)` returns `false` when
the channel is not open rather than writing to a socket that would refuse it.

## Design

Four seams. No new React context object.

### 1. The gateway tells a plugin when a panel unsubscribes

`apps/gateway/src/routes/stream.ts`, the `unsubscribe` branch, calls
`deps.channels.closed(id, [frame.topic])` before `deps.registry.unsubscribe`,
guarded on `topicClass(frame.topic) === "plugin"` and on the connection
actually holding the topic.

This gap is unreachable today and becomes reachable with the rest of this
change. `channels.closed` is called from exactly one place — the socket's
`close` handler — so a plugin learns a connection went away only when the whole
socket goes. Before this change no browser ever subscribed to a plugin topic,
so unsubscribe-without-close could not happen. After it, navigating away from a
panel with the tab still open leaves the plugin holding a session entry it will
never be told to drop, for the life of the tab.

Two things are load-bearing:

- **Order.** `registry.unsubscribe` is what detaches the topic, so calling it
  first leaves the `onClose` handlers unfired with nothing to say so. Same
  read-before-remove rule the `close` handler already carries a comment about,
  and the same silent failure.
- **The `has` guard.** Without it, an unsubscribe from a connection that never
  subscribed delivers an `onClose` for a session the plugin never opened.
  `registry.has(id, topic)` is the same question `channels.holds` asks in both
  directions, and it is cheap for the reason stated there.

Nothing else in the gateway changes. `authorised` is untouched: a viewer still
holds no plugin topic.

### 2. The console holds topics it does not know at build time

`createStreamClient` gains one method:

```ts
hold(topic: string, listener: (message: TopicMessage) => void): () => void
```

Refcounted per topic. On 0→1 it sends `{ type: "subscribe", topic }` if the
socket is open; on the drop back to 0 it sends `{ type: "unsubscribe", topic }`
and forgets the topic. `subscribeAll` replays the held set on reconnect,
without `sinceSeq`: plugin frames carry no `seq` — `channels.send` emits
`{ type: "event", topic, payload }` — so there is no ring behind them, no
replay to resume, and asking for one would only invite a `gap` for a class that
cannot produce one.

Wire subscription and local listener are one call rather than two, which is the
whole reason to fold this into `hold` instead of pairing a new wire method with
the existing `onStream`. Two lifetimes kept in step by convention drift into a
topic that is subscribed and rendered by nobody, and that state is silent.

`TopicMessage` grows three arms:

```ts
type TopicMessage =
  | { kind: "frame"; payload: unknown }
  | { kind: "gap" }
  | { kind: "open" }
  | { kind: "refused" }
  | { kind: "closed" };
```

`open` on an `ack` for the topic, `refused` on an `error` for it, `closed` when
the socket drops. A listener that mounts onto an already-acked topic is handed
`open` synchronously at subscribe time, so a panel's status does not depend on
having mounted before the ack arrived — which it usually will not have, since
the socket opens with the shell and a panel mounts on navigation.

`onStream` stays as it is, for `stream:console`, whose subscription is still
the compile-time one. The three new arms are delivered by topic, so a
`stream:*` reader sees them too: `ConsoleBoard` acts on `frame` and `gap` and
ignores the rest, which is what keeps this additive for the one existing
caller.

`pushed` needs no change. `acked` is populated by the same ack, so
`cadence(ms, topic)` starts returning `false` for a held plugin topic on its
own.

### 3. The transport reaches the SDK on the context that already exists

`LiveContextValue` gains an optional member:

```ts
export type ChannelMessage =
  | { kind: "frame"; payload: unknown }
  | { kind: "open" }
  | { kind: "refused" }
  | { kind: "closed" };

export type ChannelTransport = {
  subscribe(topic: string, listener: (message: ChannelMessage) => void): () => void;
  send(topic: string, payload: unknown): boolean;
};
```

supplied by `LiveProvider`'s new `channels` prop, which
`StreamedLiveProvider` fills from the stream client it already reads.

On the existing context rather than a new one. `live.ts` already documents why
this package holds exactly one context object: a duplicated copy of this module
calls `createContext` again, a panel reading the second one finds no provider,
and it falls through to a default — polling silently off, forever, with nothing
thrown and nothing logged. A second context is a second thing that has to be
the same instance everywhere, with the same failure when it is not. The
alternative of putting `subscribe` on `LiveConnection` is worse and for a
different reason: that object is rebuilt on every transition to defeat
`useSyncExternalStore`'s identity bail-out, so a subscribe function carried on
it would change identity per transition and re-subscribe every reader on every
drop.

`ChannelMessage` deliberately omits `gap`. The console's `TopicMessage` keeps
it because `stream:console` needs it; plugin topics have no ring, so exporting
an arm no plugin frame can carry would be a case every panel author writes and
none can reach.

### 4. The hook

`usePluginChannel(pluginId, name, onFrame)` composes
`plugin:${pluginId}:${name}`, holds it for as long as the caller is mounted,
and returns `{ status, send }`.

`pluginId` is an explicit argument, matching `usePluginApi(pluginId)` — one
precedent, one signature, and `PluginUiProps.pluginId` is handed to the panel
at its mount point. `onFrame` is read through a ref rather than depended on, so
a panel may pass a fresh closure per render, for the reason `useStreamTopic`
gives.

`send` returns `false` when `status !== "open"` instead of writing. The gateway
answers a send-before-subscribe with an `error` frame on that topic, which this
design reads as `refused` — so a client that ignored its own status would turn
one mistimed send into a topic-wide refusal the panel then reports as missing
permission.

The SDK validates neither half of the topic. Mirroring `NAME_PATTERN` from
`channels.ts` or `MAX_TOPIC` from `protocol.ts` into a published package buys a
local error message and costs a mirror that must be pinned and kept in step; a
malformed name comes back `refused`, which is a state the hook already renders.

## Versions

`DASHBOARD_SDK_VERSION` `0.1.3` → `0.1.4`. A patch, on the precedent `0.1.2`
sets in `version.ts`: that entry added the push transport itself and argues
that a purely additive change does not get to disable the UI of every plugin
published against `^0.1.0`, each reported as a mismatch it did nothing to earn.
This change is the same shape — a new export, and an optional member on a type
plugins consume but cannot construct, since `LiveContext` is not exported.

Two packages move, not one. `DASHBOARD_SDK_VERSION` lives in
`packages/plugin-api/src/version.ts`, and the release step skips a package
whose version has not moved — so bumping only the SDK leaves the registry
advertising `"0.1.3"` to every author who installs `@omnigateway/plugin-api`.
That shipped once as `v0.4.8`, and `publishable.test.ts` now refuses it. So
`@omnigateway/plugin-api` `0.2.0` → `0.2.1` alongside
`@omnigateway/dashboard-sdk` `0.1.3` → `0.1.4`. The SDK's declared range on
plugin-api is `^0.2.0` and already covers it.

`PLUGIN_API_VERSION` stays `2`. No `PluginContext` member changes.
`onClose` firing on unsubscribe is the documented contract — "called when a
connection holding this channel goes away" — becoming true in a case that was
previously unreachable, not a widening an existing plugin could fail to
survive.

## Testing

- **Gateway.** Unsubscribe on a held plugin topic fires `onClose` exactly once;
  on a topic the connection never held, not at all; on `res:*` and `stream:*`,
  not at all. Order is the mutation target — swapping `channels.closed` and
  `registry.unsubscribe` leaves every handler unfired — so the assertion is
  that the handler ran, never that both calls were made.
- **Console stream client.** `hold` sends `subscribe` on 0→1 and nothing on
  1→2; `unsubscribe` on the drop to 0 and not before; held topics replay on
  reconnect; ack → `open`, error → `refused`, drop → `closed`; a listener
  mounting after the ack is handed `open` synchronously. The refcount fixture
  needs a *second* holder — one holder passes an off-by-one in both directions.
- **SDK.** Topic composition, `send` returning `false` outside `open`, and the
  no-provider default. The duplicate-context failure is already covered by
  `useLive`'s existing test.
- **End to end.** A stub panel built on `usePluginChannel`, mounted through
  `PluginModuleLoaderProvider`, receives a frame and renders it. This is the
  test that would catch the whole chain being wired to nothing, which is the
  state the repository is in today.

## Out of scope

- **No manifest field for channel names.** Subscription is dynamic at mount, so
  the host never needs the list ahead of time. A declared-names field would be
  a second place for the same truth, kept in step by hand.
- **No viewer access.** `authorised` is unchanged. A viewer renders plugin
  panels and holds no plugin topic, and `refused` is what its panel shows —
  which is the point of giving the hook a status at all. Silence would be
  indistinguishable from a channel that is merely quiet, which is the failure
  the rest of this subsystem is written against.
- **No durability.** Channels remain at-most-once and unreplayed in both
  directions, as the capability already promises. A panel needing state across
  a reconnect reads it back over the plugin's own API.
