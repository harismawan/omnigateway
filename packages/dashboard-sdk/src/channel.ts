import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "./live.ts";

/**
 * What a panel knows about its channel.
 *
 * Three states and no fourth. `idle` is "nothing has said yes yet", which
 * covers a socket that has not opened, a subscription not yet acknowledged, and
 * a transport that dropped and is coming back. `refused` is a host that said
 * no — a viewer holds no plugin topic and never will — and it is the state that
 * justifies this being a status at all: told nothing, a panel cannot tell a
 * channel it may not have from one that is merely quiet.
 */
export type ChannelStatus = "idle" | "open" | "refused";

export type PluginChannel = {
  status: ChannelStatus;
  /**
   * The wire topic, composed here and exposed for `cadence(ms, topic)`.
   *
   * A panel that spelled it itself could name another plugin's, which the host
   * would refuse in a way that reads as a bug in the panel doing the asking.
   * The plugin writes the tail and never the head, exactly as it does when it
   * opens the channel on the server side.
   */
  topic: string;
  /** Publishes to the plugin. `false` when the channel is not open. */
  send: (payload: unknown) => boolean;
};

/**
 * Receives one of this plugin's channels for as long as the caller is mounted.
 *
 * ```tsx
 * const { status, send } = usePluginChannel(pluginId, "session", (payload) => {
 *   // one frame from the plugin's own channel
 * });
 * ```
 *
 * `pluginId` is an argument rather than something read from a context, which
 * matches `usePluginApi(pluginId)` — one precedent for "which plugin am I", and
 * the id is handed to the panel in `PluginUiProps` at its mount point.
 *
 * Outside the console's shell there is no transport, and the channel simply
 * stays `idle`. Not an error: a panel rendered by its own harness has no socket
 * to hold a topic on, and a component that cannot find one has no business
 * deciding the answer is anything else. That is the same posture `useLive`
 * takes when it cannot find the switch.
 *
 * `onFrame` is read through a ref rather than depended on, so a panel may pass
 * a fresh closure per render — which it must, since whatever a frame has to be
 * judged against is ordinary component state.
 */
export function usePluginChannel(
  pluginId: string,
  name: string,
  onFrame: (payload: unknown) => void,
): PluginChannel {
  const { channels } = useLive();
  const topic = `plugin:${pluginId}:${name}`;
  const [status, setStatus] = useState<ChannelStatus>("idle");
  const latest = useRef(onFrame);

  useEffect(() => {
    latest.current = onFrame;
  });

  useEffect(() => {
    if (channels === undefined) return undefined;
    return channels.subscribe(topic, (message) => {
      switch (message.kind) {
        case "frame":
          latest.current(message.payload);
          return;
        case "open":
          setStatus("open");
          return;
        case "refused":
          setStatus("refused");
          return;
        // Back to `idle`, never left at `open`. The transport resubscribes on
        // its own and `open` follows — but a panel that went on reading `open`
        // through the gap would show a live channel with nothing arriving on
        // it, which is the failure this status exists to prevent.
        case "closed":
          setStatus("idle");
          return;
      }
    });
  }, [channels, topic]);

  const send = useCallback(
    (payload: unknown): boolean => {
      // Asked here as well as in the host. The gateway answers a
      // send-before-subscribe with an error on this topic, which the console
      // reads as a refusal — so a panel that sent early would turn its own
      // timing into a permission failure it then reports to its operator.
      if (channels === undefined || status !== "open") return false;
      return channels.send(topic, payload);
    },
    [channels, status, topic],
  );

  return { status, topic, send };
}
