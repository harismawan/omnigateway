import { type Logger, noopLogger } from "@omni/ir";
import type { PluginChannel, PluginChannelMessage, PluginChannels } from "@omnigateway/plugin-api";
import type { DrainScheduler } from "../plugins/events.ts";
import type { SocketRegistry } from "./registry.ts";

/**
 * The slice of the socket registry a channel needs.
 *
 * Narrowed the way `Invalidator` narrows `Broadcaster`, and for the same
 * reason: a path that could reach `closeAll`, `subscribe` or `stop` is a path
 * that could be made to do any of them, and none of the three is anything a
 * plugin's channel has business doing. `SocketRegistry` satisfies this
 * structurally, so `createApp` hands its own over without an adapter and there
 * is nothing to keep in step.
 */
export type ChannelSockets = Pick<SocketRegistry, "has" | "sendTo">;

/**
 * How a broadcast leaves this process.
 *
 * A function rather than the `Broadcaster` for the reason `ChannelSockets`
 * narrows the registry: a path that could reach `stream`, `invalidateAll` or
 * `stop` is a path that could be made to do any of them. `Broadcaster.channel`
 * satisfies it structurally.
 *
 * Required rather than optional, so a registry cannot be built without deciding
 * where its frames go. That is all the type buys — a `() => {}` satisfies it, as
 * every test here does — but it makes the omission a compile error at the two
 * production call sites rather than a channel that is merely quiet.
 */
export type ChannelFanout = (topic: string, payload: unknown) => boolean;

/**
 * The channel-name pattern, which is two constraints wearing one coat.
 *
 * The value becomes the tail of a wire topic, so it is bounded and reduced to a
 * character set that needs no escaping — the same argument the plugin id makes,
 * minus the SQL half. Interior colons are permitted because a channel is
 * routinely a family rather than a single topic: `session:<id>` is the shape the
 * remote-control design uses, and forbidding it would push plugins into
 * inventing a separator of their own.
 *
 * The bound is load-bearing, not tidiness. `plugin:` plus an id of at most 32
 * plus a separator plus a name of at most 64 is 104 characters, which is under
 * `MAX_TOPIC` in the protocol — so a well-formed channel can never name a topic
 * the parser will then refuse, and "the plugin opened it but no client can
 * subscribe" is a state that cannot arise.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

type Channel = {
  pluginId: string;
  topic: string;
  /** Budget left, and when it was last refilled. See `BROADCAST_BURST`. */
  tokens: number;
  refilledAt: number;
  onMessage: ((message: PluginChannelMessage) => void)[];
  onClose: ((connectionId: string) => void)[];
  /** The facade handed to the plugin, so a second `open` is the same channel. */
  facade: PluginChannel;
};

export type ChannelStats = {
  /** Channels currently open, across every plugin. */
  channels: number;
  /** Handler invocations that threw. */
  handlerErrors: number;
  /** Broadcasts refused because a channel was over its budget. */
  broadcastDrops: number;
  /** Broadcasts refused because the payload would not serialise. */
  broadcastUnencodable: number;
};

/**
 * Broadcasts one channel may publish per second before the rest are dropped.
 *
 * `send` costs one push into a bounded, drop-oldest, counted queue on this
 * process. A broadcast costs a publish on the shared bus plus a parse and a
 * fan-out on *every* replica, and it deliberately goes past the emit-side
 * coalescer — a plugin's payload names which thing changed, so folding by topic
 * would drop all but the last. "Do not fold" and "do not bound" are different
 * decisions, and only the first one was argued for.
 *
 * **Per channel, which is not per key, and the first number here was chosen as
 * though it were.** A plugin floors its own rate against whatever it pushes
 * *about* — the reference consumer allows one frame per API key per second — and
 * then publishes every one of them onto a single channel. So the ceiling is
 * reached by concurrently busy keys, and fifty was inside what an ordinary
 * installation reaches. That is the worst way for this to be wrong: the plugin
 * whose panel switches its poll off while the channel is live is the one whose
 * dropped frame is a screen that stops updating, so a cap set too low is quieter
 * than no cap at all.
 *
 * Five hundred leaves an installation with hundreds of simultaneously earning
 * keys inside the budget, and still refuses a plugin publishing per request:
 * that is the shape this exists to stop, and it is orders of magnitude away
 * rather than a factor of two. The contract already says delivery is best-effort
 * and bounded, so dropping over budget is inside it rather than a new failure
 * mode.
 *
 * ponytail: one budget per channel, refilled continuously, so a plugin can still
 * take N × this by opening N channels. Per-plugin budgets if a second plugin
 * ever competes for the bus.
 */
export const BROADCAST_BURST = 500;

export type ChannelRegistry = {
  /**
   * The capability object one plugin holds.
   *
   * `pluginId` comes from the manifest the host validated against the directory
   * name, which is the whole namespacing guarantee: the plugin supplies the
   * second half of a topic and never the first.
   */
  for(pluginId: string): PluginChannels;
  /** Whether some plugin has opened `topic`. A subscription to one that has not is refused. */
  opened(topic: string): boolean;
  /**
   * Hands one client frame to the owning plugin's handlers.
   *
   * `false` when the connection does not hold that topic. A channel is a
   * subscription in both directions: the plugin's only way to answer is
   * `send(connectionId, …)`, which publishes on this same topic, so accepting a
   * frame from an unsubscribed connection would accept a question whose answer
   * has nowhere to land.
   */
  deliver(topic: string, connectionId: string, payload: unknown): boolean;
  /** Tells each channel a departing connection held that it went away. */
  closed(connectionId: string, topics: readonly string[]): void;
  stats(): ChannelStats;
  /** Stops delivery and drops any unreported error counts. */
  stop(): void;
};

export type ChannelRegistryDeps = {
  sockets: ChannelSockets;
  fanout: ChannelFanout;
  logger?: Logger;
  scheduler?: DrainScheduler;
  /** Reads the current instant, for the broadcast budget. Injected like every clock here. */
  now?: () => number;
  burst?: number;
};

const defaultScheduler: DrainScheduler = (run) => {
  const timer = setTimeout(run, 0);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Plugin-owned topics on the gateway's one push socket.
 *
 * A plugin declaring `channels` receives `{ open }` and nothing else. It never
 * sees a socket, an upgrade request, a header or a `Principal` — the same
 * posture the rest of `PluginContext` holds, and the reason this module exists
 * rather than the loader handing a registry over.
 *
 * Three properties carry the design:
 *
 * **The host owns the namespace.** A topic is `plugin:<id>:<name>` with `<id>`
 * taken from the validated manifest. A plugin cannot name another plugin's
 * topic, cannot claim `res:` or `stream:`, and does not write a prefix — the
 * same rule its storage already follows.
 *
 * **Authorisation stays with the host.** This module answers `opened`; the
 * route decides what a principal may hold. A plugin therefore cannot widen its
 * own reach by opening a channel, only make one available to be authorised.
 *
 * **Nothing here is a queue.** Outbound frames go through the socket registry's
 * own per-connection queue, which is bounded and drops the oldest frame under
 * pressure. There is no second queue, no retry and no replay, and a handler
 * that throws costs that plugin one message and nothing else.
 *
 * No storage of any kind, like the event bus: a channel is a live conversation
 * and a plugin needing it to survive a restart must write its own rows.
 */
export function createChannelRegistry(deps: ChannelRegistryDeps): ChannelRegistry {
  const logger = deps.logger ?? noopLogger;
  const scheduler = deps.scheduler ?? defaultScheduler;
  const now = deps.now ?? Date.now;
  const burst = deps.burst ?? BROADCAST_BURST;

  /** topic → channel. One flat map, because a topic is globally unique by construction. */
  const channels = new Map<string, Channel>();

  let handlerErrors = 0;
  let broadcastDrops = 0;
  let broadcastUnencodable = 0;
  let live = true;
  /** Cancels the pending report. One outliving the registry is a timer leak. */
  let cancelReport: (() => void) | undefined;

  /**
   * Handler failures since the last report, by plugin.
   *
   * Batched for the reason the event bus batches its own. A plugin whose
   * handler always throws throws once per client frame, which on a keystroke
   * channel is many times a second — a line each turns one broken plugin into a
   * log volume problem on top of it, and buries whatever else was being
   * diagnosed at the time.
   */
  const errorsSinceReport = new Map<string, number>();

  /** Broadcasts refused since the last report, by plugin. Batched like the above. */
  const dropsSinceReport = new Map<string, number>();

  /** Payloads that would not serialise since the last report, by plugin. */
  const unencodableSinceReport = new Map<string, number>();

  /** Arms the batched report, which both counters share. */
  const scheduleReport = (): void => {
    if (cancelReport !== undefined || !live) return;
    cancelReport = scheduler(report);
  };

  const report = (): void => {
    cancelReport = undefined;
    if (!live) return;
    /*
      One line per drain rather than one per drop, which folds a burst raised
      inside a single tick.

      **It does not fold a plugin that drops steadily from its own timer**, and
      that is worth stating rather than implying: each tick with a drop in it
      produces its own line. A plugin publishing on an interval therefore gets a
      line per interval, and one publishing in a tight asynchronous loop gets one
      per iteration — noisy, and the plugin is broken. What this rules out is the
      case a working plugin can reach, a burst inside one tick.
    */
    for (const [pluginId, count] of dropsSinceReport) {
      logger.warn("plugin channel broadcast dropped", { plugin: pluginId, count });
    }
    dropsSinceReport.clear();
    for (const [pluginId, count] of unencodableSinceReport) {
      // A different diagnosis from the line above, so a different line: over
      // budget is a rate, and this is a payload that can never be sent.
      logger.warn("plugin channel payload could not be serialised", { plugin: pluginId, count });
    }
    unencodableSinceReport.clear();
    for (const [pluginId, count] of errorsSinceReport) {
      // No error body and no payload: this line reports on code authored
      // outside the repository, and `LogFields` is a closed allowlist. The
      // plugin id and a count are the actionable parts.
      logger.warn("plugin channel handler failed", { plugin: pluginId, count });
    }
    errorsSinceReport.clear();
  };

  const countFailure = (pluginId: string): void => {
    handlerErrors++;
    errorsSinceReport.set(pluginId, (errorsSinceReport.get(pluginId) ?? 0) + 1);
    scheduleReport();
  };

  /**
   * Spends one broadcast from a channel's budget, or reports that it cannot.
   *
   * Continuous refill rather than a window, so a plugin pushing steadily at its
   * budget is never cut off for the tail of a second — a windowed counter would
   * drop the last frame of every burst, which is the one a panel is waiting for.
   */
  const affordBroadcast = (channel: Channel): boolean => {
    const at = now();
    // A clock that is not a number would make `tokens` `NaN`, and `NaN < 1` is
    // false — so the bucket would allow everything forever, which is the one
    // direction a cap may not fail. Treated as no elapsed time instead: the
    // channel spends what it holds and then stops.
    const elapsed = Number.isFinite(at) ? Math.max(0, at - channel.refilledAt) : 0;
    channel.tokens = Math.min(burst, channel.tokens + (elapsed * burst) / 1_000);
    channel.refilledAt = at;
    if (channel.tokens < 1) {
      broadcastDrops++;
      dropsSinceReport.set(channel.pluginId, (dropsSinceReport.get(channel.pluginId) ?? 0) + 1);
      scheduleReport();
      return false;
    }
    channel.tokens -= 1;
    return true;
  };

  /**
   * Whether this connection currently holds this topic.
   *
   * Asked in both directions. Inbound it is what makes a channel a
   * subscription; outbound it is what stops a plugin holding a stale — or
   * guessed — connection id from pushing onto a socket that never asked for
   * anything of its own.
   */
  const holds = (connectionId: string, topic: string): boolean =>
    // `has` rather than `topics(...).includes(...)`: the latter allocates the
    // whole topic array on every frame in both directions, which on the
    // keystroke-latency channel this exists to serve is an allocation per
    // keystroke.
    deps.sockets.has(connectionId, topic);

  const openChannel = (pluginId: string, name: string): PluginChannel => {
    if (!NAME_PATTERN.test(name)) {
      // Thrown rather than returned. `open` is called from `setup`, where a
      // throw skips the plugin and is reported — which is the legible outcome.
      // A channel silently renamed or silently absent would present as a client
      // subscribing to a topic that answers nothing.
      throw new Error(`channel name must match ${String(NAME_PATTERN)}, got ${name}`);
    }
    const topic = `plugin:${pluginId}:${name}`;
    const existing = channels.get(topic);
    if (existing !== undefined) return existing.facade;

    const channel: Channel = {
      pluginId,
      topic,
      tokens: burst,
      refilledAt: now(),
      onMessage: [],
      onClose: [],
      // Replaced immediately below; declared here so the facade can close over
      // the channel it belongs to.
      facade: { onMessage: () => {}, send: () => {}, broadcast: () => {}, onClose: () => {} },
    };
    channel.facade = {
      onMessage(handler) {
        channel.onMessage.push(handler);
      },
      onClose(handler) {
        channel.onClose.push(handler);
      },
      send(connectionId, payload) {
        if (!live) return;
        // A connection that has gone away, or never subscribed, is the ordinary
        // case rather than an error: the plugin learns of a close asynchronously
        // and will have frames in flight for one that has already left.
        if (!holds(connectionId, topic)) return;
        deps.sockets.sendTo(connectionId, { type: "event", topic, payload });
      },
      broadcast(payload) {
        if (!live) return;
        if (!affordBroadcast(channel)) return;
        if (deps.fanout(channel.topic, payload)) return;
        // Refused by the transport: the payload would not serialise. Counted
        // here because the fan-out has no logger and the plugin has no channel
        // to be told through.
        broadcastUnencodable++;
        unencodableSinceReport.set(
          channel.pluginId,
          (unencodableSinceReport.get(channel.pluginId) ?? 0) + 1,
        );
        scheduleReport();
      },
    };
    channels.set(topic, channel);
    return channel.facade;
  };

  return {
    for(pluginId) {
      return { open: (name) => openChannel(pluginId, name) };
    },

    opened(topic) {
      return channels.has(topic);
    },

    deliver(topic, connectionId, payload) {
      if (!live) return false;
      const channel = channels.get(topic);
      if (channel === undefined) return false;
      if (!holds(connectionId, topic)) return false;
      for (const handler of channel.onMessage) {
        try {
          handler({ connectionId, payload });
        } catch {
          countFailure(channel.pluginId);
        }
      }
      return true;
    },

    closed(connectionId, topics) {
      if (!live) return;
      // Driven by the topics the connection actually held rather than by every
      // channel in the process: a console holding no plugin topic must not wake
      // every plugin on the install each time a browser tab closes.
      for (const topic of topics) {
        const channel = channels.get(topic);
        if (channel === undefined) continue;
        for (const handler of channel.onClose) {
          try {
            handler(connectionId);
          } catch {
            countFailure(channel.pluginId);
          }
        }
      }
    },

    stats() {
      return { channels: channels.size, handlerErrors, broadcastDrops, broadcastUnencodable };
    },

    stop() {
      live = false;
      channels.clear();
      // Cleared rather than merely disarmed, for the reason the event bus
      // clears its queue: a pending report left behind is a timer a leak test
      // would be unable to see, and a process waiting to exit would wait for it.
      cancelReport?.();
      cancelReport = undefined;
      errorsSinceReport.clear();
      dropsSinceReport.clear();
      unencodableSinceReport.clear();
    },
  };
}
