import { ADMIN_COOKIE, type AdminAuth } from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import { Elysia } from "elysia";
import type { Broadcaster } from "../stream/broadcaster.ts";
import { GLOBAL_INVALIDATE } from "../stream/broadcaster.ts";
import type { ChannelRegistry } from "../stream/channels.ts";
import { parseClientFrame, type ServerFrame, topicClass } from "../stream/protocol.ts";
import type { Credential, Principal, SocketRegistry } from "../stream/registry.ts";
import type { Ring } from "../stream/ring.ts";
import { apiErrorHandler, readCookie, requireAdmin } from "./http.ts";

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
function authorised(channels: ChannelRegistry, principal: Principal, topic: string): boolean {
  const kind = topicClass(topic);
  if (kind === null) return false;
  if (kind === "plugin") {
    if (!channels.opened(topic)) return false;
    if (principal.kind === "admin") return true;
    // The machine arm is unreachable until `plugin_machine_tokens` exists. When
    // it does, a machine token reaches its own plugin's topics and nothing else.
    return topic.startsWith(`plugin:${principal.pluginId}:`);
  }
  // Everything that is not a plugin channel belongs to the console alone.
  return principal.kind === "admin";
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

        await requireAdmin(request, deps.admin);
        if (cookie === null) throw new GatewayError("AUTH", "admin session required");

        resolved.set(request, {
          principal: { kind: "admin" },
          // A thunk over the token rather than the token itself: the registry
          // never learns what a cookie is, and the machine arm slots in later
          // as a different thunk with no registry change.
          revalidate: () => deps.admin.verify(cookie),
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

        deps.registry.subscribe(id, frame.topic);
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
