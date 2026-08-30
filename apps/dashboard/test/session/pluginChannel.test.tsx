import { expect, test } from "bun:test";
import {
  type ChannelMessage,
  type ChannelTransport,
  LiveProvider,
  usePluginChannel,
} from "@omnigateway/dashboard-sdk";
import { act, render, screen } from "@testing-library/react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

/**
 * The SDK hook a plugin panel calls, against a transport a test drives.
 *
 * Here rather than in `packages/dashboard-sdk/test` for the reason that
 * package's own `live.test.ts` gives at length: the hook needs a renderer, and
 * registering happy-dom mutates process-wide globals, which is why the root
 * `bun test` excludes this suite. The SDK's own file covers the export surface;
 * behaviour is covered where a DOM exists.
 *
 * The transport is a stub rather than the console's real one on purpose. What
 * the console does with a held topic is `test/session/channels.test.tsx`, over
 * a real socket. What is under test here is the hook's own contract — topic
 * composition, the status it reports, and what it refuses to send — and a stub
 * is the only way to drive a `refused` without standing up a viewer session.
 */

const PLUGIN = "pokemon";
const NAME = "companion";
const TOPIC = `plugin:${PLUGIN}:${NAME}`;

type Harness = {
  transport: ChannelTransport;
  /** Delivers one message to every live subscriber of `topic`. */
  emit(topic: string, message: ChannelMessage): void;
  /** Every `send` the hook attempted, in order. */
  sent: { topic: string; payload: unknown }[];
  /** Topics currently held, so a release is observable. */
  held(): string[];
  /** What the transport answers a send with. */
  accept: boolean;
};

function harness(): Harness {
  const listeners = new Map<string, Set<(message: ChannelMessage) => void>>();
  const sent: { topic: string; payload: unknown }[] = [];
  const self: Harness = {
    sent,
    accept: true,
    transport: {
      subscribe(topic, listener) {
        const set = listeners.get(topic) ?? new Set();
        listeners.set(topic, set);
        set.add(listener);
        return () => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(topic);
        };
      },
      send(topic, payload) {
        sent.push({ topic, payload });
        return self.accept;
      },
    },
    emit(topic, message) {
      for (const listener of [...(listeners.get(topic) ?? [])]) listener(message);
    },
    held: () => [...listeners.keys()],
  };
  return self;
}

/** Renders what the hook returns, plus every frame it was handed. */
function Panel() {
  const [frames, setFrames] = useState<string[]>([]);
  const { status, topic, send } = usePluginChannel(PLUGIN, NAME, (payload) => {
    setFrames((previous) => [...previous, JSON.stringify(payload)]);
  });
  const [result, setResult] = useState("untried");

  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="topic">{topic}</span>
      <span data-testid="frames">{frames.join("|")}</span>
      <button type="button" data-testid="send" onClick={() => setResult(String(send({ ping: 1 })))}>
        {result}
      </button>
    </div>
  );
}

function mountGate(initial: boolean) {
  let on = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: boolean) {
      on = next;
      for (const listener of [...listeners]) listener();
    },
    Gate({ children }: { children: ReactNode }) {
      const shown = useSyncExternalStore(
        (notify) => {
          listeners.add(notify);
          return () => {
            listeners.delete(notify);
          };
        },
        () => on,
        () => on,
      );
      return shown ? children : null;
    },
  };
}

const read = (id: string): string => screen.getByTestId(id).textContent ?? "";

function mount(h: Harness, children: ReactNode = <Panel />) {
  return render(<LiveProvider channels={h.transport}>{children}</LiveProvider>);
}

test("the hook composes the topic from the plugin id and the channel name", () => {
  // The plugin writes the tail and never the head, exactly as it does on the
  // server side. A panel that spelled the whole topic itself could name another
  // plugin's, and the gateway would refuse it in a way that reads as a bug in
  // this plugin.
  const h = harness();
  mount(h);

  expect(read("topic")).toBe(TOPIC);
  expect(h.held()).toEqual([TOPIC]);
});

test("status follows the transport: idle until open, and refused when the host says so", () => {
  const h = harness();
  mount(h);

  expect(read("status")).toBe("idle");

  act(() => {
    h.emit(TOPIC, { kind: "open" });
  });
  expect(read("status")).toBe("open");

  act(() => {
    h.emit(TOPIC, { kind: "refused" });
  });
  expect(read("status")).toBe("refused");
});

test("a closed transport returns to idle rather than staying open", () => {
  // `closed` is not `refused`. The socket resubscribes on its own and `open`
  // follows, so this is a channel that is coming back — but a panel left
  // reading `open` through it would show a live channel with nothing arriving.
  const h = harness();
  mount(h);

  act(() => {
    h.emit(TOPIC, { kind: "open" });
    h.emit(TOPIC, { kind: "closed" });
  });
  expect(read("status")).toBe("idle");

  act(() => {
    h.emit(TOPIC, { kind: "open" });
  });
  expect(read("status")).toBe("open");
});

test("frames reach the panel's handler and status messages do not", () => {
  const h = harness();
  mount(h);

  act(() => {
    h.emit(TOPIC, { kind: "open" });
    h.emit(TOPIC, { kind: "frame", payload: { n: 1 } });
    h.emit(TOPIC, { kind: "frame", payload: { n: 2 } });
  });

  expect(read("frames")).toBe(`{"n":1}|{"n":2}`);
});

test("a send on an open channel reaches the transport under the composed topic", () => {
  const h = harness();
  mount(h);

  act(() => {
    h.emit(TOPIC, { kind: "open" });
  });
  act(() => {
    screen.getByTestId("send").click();
  });

  expect(h.sent).toEqual([{ topic: TOPIC, payload: { ping: 1 } }]);
  expect(read("send")).toBe("true");
});

test("a send before the channel is open never reaches the transport", () => {
  // The gateway answers a send-before-subscribe with an error on that topic,
  // which the console reads as `refused` — so a panel that sent early would
  // turn its own timing into a permission failure it then reports to the
  // operator. Refused here, before the frame exists.
  const h = harness();
  mount(h);

  act(() => {
    screen.getByTestId("send").click();
  });

  expect(h.sent).toEqual([]);
  expect(read("send")).toBe("false");
});

test("the transport's own refusal is reported rather than swallowed", () => {
  const h = harness();
  h.accept = false;
  mount(h);

  act(() => {
    h.emit(TOPIC, { kind: "open" });
  });
  act(() => {
    screen.getByTestId("send").click();
  });

  expect(read("send")).toBe("false");
});

/**
 * A panel whose handler reads component state **directly**, rather than through
 * a functional updater.
 *
 * This is the shape the ref in `usePluginChannel` exists for, and the shape
 * every other fixture in this file is not: `setFrames((previous) => …)` is
 * immune to a stale closure, so a hook that captured its first `onFrame`
 * forever passes against it. Deleting the ref outright survived the whole
 * dashboard suite while that was the only shape under test.
 */
function StatefulPanel() {
  const [label, setLabel] = useState("first");
  const [seen, setSeen] = useState("");
  usePluginChannel(PLUGIN, NAME, (payload) => {
    setSeen(`${label}:${String(payload)}`);
  });

  return (
    <div>
      <span data-testid="seen">{seen}</span>
      <button type="button" data-testid="relabel" onClick={() => setLabel("second")}>
        relabel
      </button>
    </div>
  );
}

test("a frame is judged against the panel's current state, not its first render's", () => {
  const h = harness();
  render(
    <LiveProvider channels={h.transport}>
      <StatefulPanel />
    </LiveProvider>,
  );

  act(() => {
    h.emit(TOPIC, { kind: "open" });
    h.emit(TOPIC, { kind: "frame", payload: "a" });
  });
  expect(read("seen")).toBe("first:a");

  // A re-render with new state, and no resubscribe: the effect depends on the
  // transport and the topic, neither of which moved.
  act(() => {
    screen.getByTestId("relabel").click();
  });
  act(() => {
    h.emit(TOPIC, { kind: "frame", payload: "b" });
  });

  expect(read("seen")).toBe("second:b");
});

test("with no transport above it the panel is idle and sends nothing", () => {
  // A panel rendered by its own harness, or by a console whose socket never
  // upgraded. Idle rather than refused: nothing has said no, there is simply
  // nothing to ask.
  render(
    <LiveProvider>
      <Panel />
    </LiveProvider>,
  );

  act(() => {
    screen.getByTestId("send").click();
  });

  expect(read("status")).toBe("idle");
  expect(read("send")).toBe("false");
});

test("unmounting releases the topic", () => {
  // What a panel navigating away does, and the frame the gateway turns into the
  // plugin's own `onClose`.
  const h = harness();
  const gate = mountGate(true);
  mount(
    h,
    <gate.Gate>
      <Panel />
    </gate.Gate>,
  );

  expect(h.held()).toEqual([TOPIC]);
  act(() => {
    gate.set(false);
  });
  expect(h.held()).toEqual([]);
});
