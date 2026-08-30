import { expect, test } from "bun:test";
import { act, screen } from "@testing-library/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { useLive } from "../../src/session/live.tsx";
import { makeQueryClient, renderWithProviders } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub, type StubFrame } from "../helpers/socketStub.ts";

/**
 * The console half of plugin channels, driven through the seam a panel reaches.
 *
 * A plugin's topic is not known at build time, so it cannot be in the
 * compile-time table `RES_TOPICS` and `STREAM_TOPICS` come from — the client
 * has to hold it on request and give it up again. `hold` itself is private to
 * `createStreamClient`, so these drive `useLive().channels`, which is the
 * narrowest boundary that is also stable: it is exactly what
 * `usePluginChannel` is built on and what a panel's frames arrive through.
 */

const TOPIC = "plugin:pokemon:companion";
const OTHER = "plugin:pokemon:notes";

/** Records everything one subscription was handed, as text a test can read. */
function Reader({ topic, id }: { topic: string; id: string }) {
  const { channels } = useLive();
  const [seen, setSeen] = useState<string[]>([]);

  useEffect(() => {
    if (channels === undefined) return undefined;
    return channels.subscribe(topic, (message) => {
      setSeen((previous) => [
        ...previous,
        message.kind === "frame" ? `frame:${JSON.stringify(message.payload)}` : message.kind,
      ]);
    });
  }, [channels, topic]);

  return <span data-testid={id}>{seen.join("|")}</span>;
}

/**
 * A mount gate the test flips from outside the tree.
 *
 * Not `rerender`: that replaces the element `render` was given, which here is
 * the whole `Providers` wrapper — so the socket unmounts along with the reader,
 * `opened` goes false, and every frame the client would have written is
 * swallowed. Both unsubscribe assertions below passed that way while proving
 * nothing. This unmounts the reader and leaves the transport alone, which is
 * what a panel navigating away actually does.
 */
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

/**
 * What a topic's cadence would tell react-query, rendered as text.
 *
 * A separate component from `Reader` on purpose: the interesting case is the
 * one where the panel holding the channel and the query naming the topic are
 * not the same component — which is exactly the arrangement `PluginChannel`
 * exposing its composed `topic` is there to enable.
 */
function CadenceProbe({ topic }: { topic: string }) {
  const { cadence } = useLive();
  return <span data-testid="cadence">{String(cadence(10_000, topic))}</span>;
}

function Sender({ topic }: { topic: string }) {
  const { channels } = useLive();
  const [result, setResult] = useState("untried");
  return (
    <button
      type="button"
      data-testid="send"
      onClick={() => setResult(String(channels?.send(topic, { hi: true })))}
    >
      {result}
    </button>
  );
}

const read = (id: string): string => screen.getByTestId(id).textContent ?? "";

const framesOfType = (frames: StubFrame[], type: string): (string | undefined)[] =>
  frames.filter((frame) => frame.type === type).map((frame) => frame.topic);

function connected() {
  const stub = installSocketStub();
  const timer = createStubTimer();
  return { stub, timer, client: makeQueryClient() };
}

test("holding a topic subscribes it on the wire and delivers its frames", () => {
  const { stub, timer, client } = connected();
  renderWithProviders(<Reader topic={TOPIC} id="a" />, {
    client,
    stream: { enabled: true, timer: timer.schedule },
  });

  act(() => {
    stub.last().open();
  });
  expect(framesOfType(stub.last().frames(), "subscribe")).toContain(TOPIC);

  act(() => {
    stub.last().emit({ type: "ack", topic: TOPIC });
    stub.last().emit({ type: "event", topic: TOPIC, payload: { n: 1 } });
  });

  expect(read("a")).toBe(`open|frame:{"n":1}`);
});

test("a topic first held after the socket opened is subscribed there and then", () => {
  // The production case, and the one a test that mounts everything up front
  // cannot see: the socket opens with the shell and a panel mounts on
  // navigation, so `hold` is reached with a live connection and has to write
  // the frame itself rather than wait for a reconnect to replay it. Breaking
  // that branch left every other assertion in this file green, because they all
  // mount before `open()` and are subscribed by the replay.
  const { stub, timer, client } = connected();
  const late = mountGate(false);
  renderWithProviders(
    <late.Gate>
      <Reader topic={OTHER} id="b" />
    </late.Gate>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
  });
  expect(framesOfType(stub.last().frames(), "subscribe")).not.toContain(OTHER);

  act(() => {
    late.set(true);
  });

  expect(framesOfType(stub.last().frames(), "subscribe")).toContain(OTHER);
  act(() => {
    stub.last().emit({ type: "ack", topic: OTHER });
    stub.last().emit({ type: "event", topic: OTHER, payload: { n: 9 } });
  });
  expect(read("b")).toBe(`open|frame:{"n":9}`);
});

test("releasing a topic stops it counting as pushed, and its own ack does not put it back", () => {
  // The silent-staleness case this repository's socket rules are written
  // against: `cadence(ms, topic) === false` means "stop polling, this is
  // pushed". Once the last holder is gone the topic is not subscribed and no
  // frame can arrive on it, so a component still naming it must go back to its
  // interval — otherwise it waits forever on a push that is not coming, and
  // that reads exactly like a quiet gateway.
  //
  // The second half is the part that is not obvious: the gateway acks an
  // unsubscribe on the same topic, so clearing `acked` at release alone is
  // undone one frame later by the ack branch.
  const { stub, timer, client } = connected();
  const holder = mountGate(true);
  renderWithProviders(
    <>
      <holder.Gate>
        <Reader topic={TOPIC} id="a" />
      </holder.Gate>
      <CadenceProbe topic={TOPIC} />
    </>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  expect(read("cadence")).toBe("false");

  act(() => {
    holder.set(false);
  });
  expect(read("cadence")).toBe("10000");

  // What the gateway actually answers an unsubscribe with.
  act(() => {
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  expect(read("cadence")).toBe("10000");
});

test("a second holder does not subscribe again, and the first to leave does not unsubscribe", () => {
  // The refcount, from both directions. One holder passes an off-by-one either
  // way: with a single reader, "subscribe once" and "subscribe per holder" are
  // the same frame count, and "release on last" and "release on any" are the
  // same unsubscribe.
  //
  // The second holder mounts *after* the socket is open, and that is the whole
  // reason this test bites. With both mounted up front neither reaches `hold`'s
  // own send at all — `subscribeAll` writes one frame per key of the held map
  // however many holders each key has — so the count below would be measuring
  // `Map` semantics rather than the guard, and dropping `holders === 1`
  // survived the entire suite while it did.
  const { stub, timer, client } = connected();
  const second = mountGate(false);
  renderWithProviders(
    <>
      <Reader topic={TOPIC} id="a" />
      <second.Gate>
        <Reader topic={TOPIC} id="b" />
      </second.Gate>
    </>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    second.set(true);
  });
  expect(framesOfType(stub.last().frames(), "subscribe").filter((t) => t === TOPIC)).toHaveLength(
    1,
  );

  act(() => {
    second.set(false);
  });
  expect(framesOfType(stub.last().frames(), "unsubscribe")).toEqual([]);

  // Both frames still reach the holder that stayed.
  act(() => {
    stub.last().emit({ type: "event", topic: TOPIC, payload: { n: 2 } });
  });
  expect(read("a")).toContain(`frame:{"n":2}`);
});

test("the last holder leaving unsubscribes on the wire", () => {
  const { stub, timer, client } = connected();
  const only = mountGate(true);
  renderWithProviders(
    <only.Gate>
      <Reader topic={TOPIC} id="a" />
    </only.Gate>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    only.set(false);
  });

  expect(framesOfType(stub.last().frames(), "unsubscribe")).toEqual([TOPIC]);
});

test("a reconnect resubscribes held topics, and asks for no replay", () => {
  // Held topics are not in the compile-time table, so nothing else would put
  // them back. `sinceSeq` is the other half: plugin frames carry no `seq`,
  // there is no ring behind them, and asking to resume from one would invite a
  // `gap` for a class that cannot produce one.
  const { stub, timer, client } = connected();
  renderWithProviders(<Reader topic={TOPIC} id="a" />, {
    client,
    stream: { enabled: true, timer: timer.schedule },
  });

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    stub.last().close(1006);
  });
  act(() => {
    timer.fire();
  });
  act(() => {
    stub.last().open();
  });

  const resubscribe = stub
    .last()
    .frames()
    .filter((frame) => frame.type === "subscribe" && frame.topic === TOPIC);
  expect(resubscribe).toHaveLength(1);
  expect(resubscribe[0]?.sinceSeq).toBeUndefined();
});

test("a refused topic says so, and says it to that topic alone", () => {
  // What a viewer gets: `authorised` refuses every plugin topic to anything but
  // an admin. Silence would be indistinguishable from a channel that is merely
  // quiet, which is the whole reason this carries a status.
  const { stub, timer, client } = connected();
  renderWithProviders(
    <>
      <Reader topic={TOPIC} id="a" />
      <Reader topic={OTHER} id="b" />
    </>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: OTHER });
    stub.last().emit({ type: "error", topic: TOPIC, message: "not permitted" });
  });

  expect(read("a")).toBe("refused");
  expect(read("b")).toBe("open");
});

test("a dropped socket tells every holder, and the topic reopens on reconnect", () => {
  const { stub, timer, client } = connected();
  renderWithProviders(<Reader topic={TOPIC} id="a" />, {
    client,
    stream: { enabled: true, timer: timer.schedule },
  });

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    stub.last().close(1006);
  });
  expect(read("a")).toBe("open|closed");

  act(() => {
    timer.fire();
  });
  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  expect(read("a")).toBe("open|closed|open");
});

test("a holder that mounts after the ack is told the topic is open", () => {
  // The ordinary case rather than the exotic one: the socket opens with the
  // shell and a panel mounts on navigation, so the ack has almost always
  // already been and gone. A status that only ever arrived as an event would
  // leave that panel reading `idle` forever.
  const { stub, timer, client } = connected();
  const late = mountGate(false);
  renderWithProviders(
    <>
      <Reader topic={TOPIC} id="a" />
      <late.Gate>
        <Reader topic={TOPIC} id="b" />
      </late.Gate>
    </>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    late.set(true);
  });

  expect(read("b")).toBe("open");
});

test("a send on a held topic reaches the wire and reports that it did", () => {
  const { stub, timer, client } = connected();
  renderWithProviders(
    <>
      <Reader topic={TOPIC} id="a" />
      <Sender topic={TOPIC} />
    </>,
    { client, stream: { enabled: true, timer: timer.schedule } },
  );

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  act(() => {
    screen.getByTestId("send").click();
  });

  expect(read("send")).toBe("true");
  const sent = stub
    .last()
    .frames()
    .filter((frame) => frame.type === "send");
  expect(sent).toEqual([{ type: "send", topic: TOPIC, payload: { hi: true } }]);
});

test("a send on a topic that is not open writes nothing and says so", () => {
  // The gateway answers a send-before-subscribe with an `error` on that topic,
  // which this client reads as `refused`. A client that ignored its own status
  // would turn one mistimed send into a topic-wide refusal the panel then
  // reports as missing permission.
  const { stub, timer, client } = connected();
  renderWithProviders(<Sender topic={TOPIC} />, {
    client,
    stream: { enabled: true, timer: timer.schedule },
  });

  act(() => {
    stub.last().open();
  });
  act(() => {
    screen.getByTestId("send").click();
  });

  expect(read("send")).toBe("false");
  expect(
    stub
      .last()
      .frames()
      .filter((frame) => frame.type === "send"),
  ).toEqual([]);
});
