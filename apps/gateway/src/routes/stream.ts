import { ADMIN_COOKIE, type AdminAuth } from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import { Elysia } from "elysia";
import type { Broadcaster } from "../stream/broadcaster.ts";
import { GLOBAL_INVALIDATE } from "../stream/broadcaster.ts";
import type { ChannelRegistry } from "../stream/channels.ts";
import { parseClientFrame, type ServerFrame, topicClass } from "../stream/protocol.ts";
import type { Credential, Principal, SocketRegistry } from "../stream/registry.ts";
import type { Ring } from "../stream/ring.ts";
import { apiErrorHandler, readCookie } from "./http.ts";

export type StreamDeps = {
  admin: AdminAuth;
  registry: SocketRegistry;
  broadcaster: Broadcaster;
  ring: Ring;
  channels: ChannelRegistry;
  logger?: Logger;
  connectionId?: () => string;
};

/**
 * Whether a principal may hold a topic.
 *
 * An admin sees the whole console, which is every `res:*`, every `stream:*` the
 * host declared, and every plugin channel that has been opened — the console
 * renders plugin panels, and a panel that could not subscribe to its own
 * plugin's channel would be a capability granted to nobody.
 *
 * A plugin topic nothing has opened is refused whoever asks. That is the same
 * rule `stream:*` follows through `declared`, and for the same reason: a topic
 * with no owner behind it must not look to a client like one that is merely
 * quiet. Note the direction — the channel registry says what *exists*, and this
 * function says who may hold it. A plugin therefore cannot widen its own reach
 * by opening a channel.
 */
/**
 * The `res:*` topics a client session may hold.
 *
 * Two, and an allowlist rather than a prefix test. A `res:*` frame carries only
 * `{ keys }`, so holding one leaks no rows — the client refetches against its
 * own scoped endpoint and the socket never transports another key's data. That
 * argument is what makes this safe, and it is an argument about *these* topics:
 * a future frame carrying a payload would break it, which is why the set is
 * enumerated here rather than derived.
 */
const CLIENT_TOPICS: ReadonlySet<string> = new Set(["res:usage", "res:logs"]);

export function authorised(
  channels: ChannelRegistry,
  principal: Principal,
  topic: string,
): boolean {
  const kind = topicClass(topic);
  if (kind === null) return false;

  if (kind === "plugin") {
    if (!channels.opened(topic)) return false;
    if (principal.kind === "admin") return true;
    // The machine arm is unreachable until `plugin_machine_tokens` exists. When
    // it does, a machine token reaches its own plugin's topics and nothing else.
    if (principal.kind === "machine") return topic.startsWith(`plugin:${principal.pluginId}:`);
    // A viewer renders plugin panels but is not the operator, and a client does
    // not render the console at all. Neither gets a plugin's channel.
    return false;
  }

  if (principal.kind === "admin") return true;

  if (principal.kind === "viewer") {
    // A viewer is the operator minus mutations and minus secrets, so it holds
    // every `res:*` and every declared `stream:*` — including the stdout tail,
    // which is a diagnostic and is neither. That is the whole use for the role:
    // somebody who can work out what is wrong without being able to change it.
    // It stops at plugin channels, handled above, because those are opened by
    // third-party code rather than declared by the host.
    return kind === "res" || kind === "stream";
  }

  if (principal.kind === "client") return CLIENT_TOPICS.has(topic);

  return false;
}

/**
 * `/api/stream` — the gateway's one multiplexed push socket.
 *
 * ## Why `beforeHandle` is a single function and dedupes itself
 *
 * Elysia 1.4.29's Bun adapter calls a ws route's `beforeHandle` **twice**: once
 * through the ordinary composed-hook chain, and again by hand inside the route
 * handler, guarded by `typeof options.beforeHandle == "function"`. Two
 * consequences, both load-bearing:
 *
 * - **It must not be an array.** The hand-written second call tests for a
 *   function, so an array of hooks is silently skipped there — the guard would
 *   appear to work while running only half the time.
 * - **It must be idempotent.** Left alone, every upgrade costs two Argon2-backed
 *   `verify` round-trips. The `WeakMap` keyed on the `Request` is the same shape
 *   and the same reasoning as `admitted` in `app.ts`.
 *
 * Throwing from it is correct and reaches `apiErrorHandler`: the ws route is
 * composed like any other, so the throw lands in the same `onError` chain and
 * `server.upgrade()` is never reached.
 *
 * ## Why there is also a plain `GET`
 *
 * A ws route only matches when the request carries `upgrade: websocket`.
 * Without a companion `GET` a plain browser hit on `/api/stream` would fall
 * through to the static catch-all and 404 an endpoint that exists. It also
 * makes the "not an upgrade" refusal assertable with the ordinary
 * `app.handle(new Request(...))` harness, with no listening server.
 */
export function streamRoutes(deps: StreamDeps) {
  const logger = deps.logger ?? noopLogger;
  const nextId = deps.connectionId ?? (() => `ws_${crypto.randomUUID()}`);

  /** One verified credential per upgrade, so the doubled hook verifies once. */
  const resolved = new WeakMap<Request, Credential>();
  /** The connection id for a socket, assigned at open. */
  const ids = new WeakMap<object, string>();

  const send = (ws: { send(data: string): unknown }, frame: ServerFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  return new Elysia()
    .onError(apiErrorHandler)
    .ws("/api/stream", {
      // A single function, never an array — see the note above.
      beforeHandle: async ({ request }: { request: Request }) => {
        if (resolved.has(request)) return;

        const bearer = request.headers.get("authorization");
        const cookie = readCookie(request, ADMIN_COOKIE);
        if (bearer !== null && cookie !== null) {
          // Same rule the `/v1/*` surface applies to Bearer and `x-api-key`:
          // two credentials is an ambiguous request, not a request with a
          // preference.
          throw new GatewayError("AUTH", "present one credential, not two");
        }

        if (cookie === null) throw new GatewayError("AUTH", "a session is required");
        // Any session opens a socket; `authorised` decides what it may then hold.
        // Refusing the upgrade per kind would push the same rule into two places
        // and give a client a different failure mode than a refused subscribe.
        const principal = await deps.admin.verify(cookie);
        if (principal === null) throw new GatewayError("AUTH", "a session is required");

        resolved.set(request, {
          principal,
          // A thunk over the token rather than the token itself: the registry
          // never learns what a cookie is, and the machine arm slots in later
          // as a different thunk with no registry change.
          // Still-verified is a narrower question than who-are-you: a session
          // that changed kind mid-connection is impossible (kinds are fixed at
          // issue), so the thunk collapses the principal to a boolean here and
          // the registry stays ignorant of both cookies and kinds.
          revalidate: async () => (await deps.admin.verify(cookie)) !== null,
        });
      },

      open(ws) {
        const credential = resolved.get(ws.data.request);
        if (credential === undefined) {
          // Unreachable through the guard above; if it ever is reached, refusing
          // is the only safe answer.
          ws.close(1011, "unauthenticated");
          return;
        }
        const id = nextId();
        ids.set(ws.raw, id);
        deps.registry.add(id, ws.raw, credential);
        // Every connection holds the global topic. It is the one frame that is
        // not about a resource the client chose to watch.
        deps.registry.subscribe(id, GLOBAL_INVALIDATE);
      },

      message(ws, raw) {
        const id = ids.get(ws.raw);
        if (id === undefined) return;

        const frame = parseClientFrame(raw);
        if (frame === null) {
          send(ws, { type: "error", message: "malformed frame" });
          return;
        }

        const principal = deps.registry.principal(id);
        if (principal === null) return;

        const head = frame.id === undefined ? {} : { id: frame.id };

        if (!authorised(deps.channels, principal, frame.topic)) {
          send(ws, { ...head, type: "error", topic: frame.topic, message: "not permitted" });
          return;
        }

        if (frame.type === "unsubscribe") {
          // A panel unmounting is a connection leaving a channel, and the plugin
          // has to hear about it here: `closed` is otherwise reached only from
          // the socket's own close handler, so a console that navigated away
          // with the tab still open would leave the plugin holding a session
          // nothing would ever tell it to drop.
          //
          // The guard answers a real question: firing for a topic this
          // connection never held would hand the plugin an `onClose` naming a
          // connection it has no record of.
          //
          // The order matters *only through that guard*, and the distinction is
          // worth spelling out because `closeOne` in `stream/registry.ts`
          // carries a comment arguing the opposite about code that looks the
          // same. There the topic list is a snapshot already taken, so swapping
          // the two lines changes nothing. Here `registry.has` reads live state
          // and `unsubscribe` is what clears it — so reversed, the guard refuses
          // and every handler goes unfired. Drop the guard and the order stops
          // mattering, which is the tell that it is the guard and not the
          // announcement that depends on it.
          if (topicClass(frame.topic) === "plugin" && deps.registry.has(id, frame.topic)) {
            deps.channels.closed(id, [frame.topic]);
          }
          deps.registry.unsubscribe(id, frame.topic);
          send(ws, { ...head, type: "ack", topic: frame.topic });
          return;
        }

        if (frame.type === "send") {
          // Client-to-server payloads exist for plugin channels and nowhere
          // else. `res:*` and `stream:*` are host-owned and one-directional, and
          // silently accepting a payload on one would let a client believe it
          // had sent something.
          if (topicClass(frame.topic) !== "plugin") {
            send(ws, { ...head, type: "error", topic: frame.topic, message: "topic is read-only" });
            return;
          }
          if (!deps.channels.deliver(frame.topic, id, frame.payload)) {
            // Authorised above, so the channel exists: what is missing is the
            // subscription. Refused rather than accepted because the plugin's
            // only way to answer publishes on this topic, so a frame from an
            // unsubscribed connection is a question whose answer has nowhere to
            // land.
            send(ws, {
              ...head,
              type: "error",
              topic: frame.topic,
              message: "subscribe before sending",
            });
            return;
          }
          send(ws, { ...head, type: "ack", topic: frame.topic });
          return;
        }

        if (topicClass(frame.topic) === "stream" && !deps.broadcaster.declared(frame.topic)) {
          // No source behind it. A console whose log capture is `none` lands
          // here, and it must not look like a topic that is merely quiet.
          send(ws, { ...head, type: "error", topic: frame.topic, message: "no source" });
          return;
        }

        if (!deps.registry.subscribe(id, frame.topic)) {
          // Refused by the per-connection cap. Said out loud for the same
          // reason "no source" is: an ack over a subscription nobody holds is a
          // topic that looks merely quiet.
          send(ws, { ...head, type: "error", topic: frame.topic, message: "too many topics" });
          return;
        }
        send(ws, { ...head, type: "ack", topic: frame.topic });

        if (frame.sinceSeq !== undefined) {
          const slice = deps.ring.since(frame.topic, frame.sinceSeq);
          if (slice.kind === "gap") {
            // Never claim gapless. The client refetches over REST rather than
            // stitching a hole it cannot see.
            send(ws, { type: "gap", topic: frame.topic, seq: slice.seq });
          } else {
            for (const item of slice.frames) {
              send(ws, { type: "event", topic: frame.topic, seq: item.seq, payload: item.payload });
            }
          }
        }
      },

      pong(ws) {
        const id = ids.get(ws.raw);
        if (id !== undefined) deps.registry.pong(id);
      },

      drain(ws) {
        const id = ids.get(ws.raw);
        if (id !== undefined) deps.registry.drain(id);
      },

      close(ws) {
        const id = ids.get(ws.raw);
        if (id === undefined) return;
        // Read before `remove`, which is what detaches the topic set. Reversing
        // these two leaves every `onClose` handler unfired and nothing to say
        // so — the plugin simply never learns the connection ended.
        deps.channels.closed(id, deps.registry.topics(id));
        deps.registry.remove(id);
        ids.delete(ws.raw);
        logger.debug("stream closed");
      },
    })
    .get("/api/stream", ({ set }) => {
      set.status = 426;
      return { error: { code: "BAD_REQUEST", message: "websocket upgrade required" } };
    });
}
