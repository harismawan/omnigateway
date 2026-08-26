import { expect, test } from "bun:test";
import * as sdk from "@omnigateway/dashboard-sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveProvider, useLive } from "../../src/session/live.tsx";

/**
 * The switch under test, rendered as text so the assertions read what an
 * operator would see rather than what a hook returned.
 *
 * `cadence` is shown for a real interval because the value that matters is what
 * reaches `refetchInterval`: `false` is the paused state, and any number is
 * not. A test asserting only the `live` boolean would pass with a `cadence`
 * that ignored it entirely.
 */
function Readout() {
  const { live, toggle, cadence } = useLive();
  return (
    <div>
      <span data-testid="cadence">{String(cadence(10_000))}</span>
      <button onClick={toggle} type="button">
        {live ? "LIVE" : "PAUSED"}
      </button>
    </div>
  );
}

test("the switch starts live and hands out the interval it was asked for", () => {
  render(
    <LiveProvider>
      <Readout />
    </LiveProvider>,
  );

  expect(screen.getByRole("button").textContent).toBe("LIVE");
  expect(screen.getByTestId("cadence").textContent).toBe("10000");
});

test("pausing turns every cadence into false, which is what stops a query", async () => {
  const user = userEvent.setup();
  render(
    <LiveProvider>
      <Readout />
    </LiveProvider>,
  );

  await user.click(screen.getByRole("button"));

  expect(screen.getByRole("button").textContent).toBe("PAUSED");
  // `false` and not 0: react-query reads 0 as "as fast as possible", so the
  // difference between the two is a paused console and a console hammering the
  // gateway. Asserted as the string the component rendered, which is the value
  // that would reach `refetchInterval`.
  expect(screen.getByTestId("cadence").textContent).toBe("false");

  await user.click(screen.getByRole("button"));
  expect(screen.getByTestId("cadence").textContent).toBe("10000");
});

test("with no provider above it, nothing polls", () => {
  // The case a plugin panel hits in its own test harness, and the one a panel
  // rendered outside the shell hits in production. It must be "off" rather than
  // a thrown error: a component that cannot find the switch has no business
  // deciding the answer is "poll anyway", and a panel that threw here would
  // take the console's error boundary with it over a preference.
  render(<Readout />);

  expect(screen.getByRole("button").textContent).toBe("PAUSED");
  expect(screen.getByTestId("cadence").textContent).toBe("false");
});

test("the console reaches the same context object a plugin would", async () => {
  // The failure this exists for is silent and is not about behaviour: two
  // copies of the module mean two `createContext` calls, and whoever reads the
  // second finds no provider and pauses forever.
  //
  // The nesting is the whole test, and the first version of it had the nesting
  // backwards — console provider outside, SDK provider inside, console hook at
  // the bottom. The outer provider satisfied the console's hook whether or not
  // the two spellings named one context, so re-declaring `createContext` in
  // `session/live.tsx` left all 400 tests green. Providing through the SDK and
  // reading through the console, with no console provider anywhere, is what
  // makes the identity load-bearing.
  const user = userEvent.setup();

  render(
    <sdk.LiveProvider>
      <Readout />
    </sdk.LiveProvider>,
  );

  // Live, not paused: the SDK's provider was found by the console's `useLive`.
  // Two contexts would give the no-provider default and read "false" here.
  expect(screen.getByTestId("cadence").textContent).toBe("10000");
  await user.click(screen.getByRole("button"));
  expect(screen.getByTestId("cadence").textContent).toBe("false");
});

test("the console's re-export is the SDK's own binding, not a copy of it", () => {
  // The same property as the test above, asserted without a renderer — cheap
  // enough to state directly, and it fails with a message that names the cause
  // rather than a rendered string. Both are kept: this one localises the fault,
  // and the render test proves the context actually flows.
  expect(useLive).toBe(sdk.useLive);
  expect(LiveProvider).toBe(sdk.LiveProvider);
});

/**
 * A readout for the topic-aware arm.
 *
 * Two cadences side by side, because the interesting property is the
 * *difference* between them: one topic pushed and one not, under a single
 * provider, is what proves the decision is per topic rather than per tab.
 */
function TopicReadout({ topic = "res:usage" }: { topic?: string }) {
  const { cadence, connection, toggle, live } = useLive();
  return (
    <div>
      <span data-testid="topic">{String(cadence(10_000, topic))}</span>
      <span data-testid="bare">{String(cadence(10_000))}</span>
      <span data-testid="status">{connection.status}</span>
      <button onClick={toggle} type="button">
        {live ? "LIVE" : "PAUSED"}
      </button>
    </div>
  );
}

const pushing = (...topics: string[]): sdk.LiveConnection => ({
  status: "push",
  pushed: (topic) => topics.includes(topic),
});

test("a pushed topic stops polling while an unpushed one keeps its interval", () => {
  // The whole point of the topic argument, in one render: the socket pushes
  // `res:usage` and not `res:logs`, and the two disagree under a single
  // provider. A per-tab boolean could not produce this.
  function Pair() {
    const { cadence } = useLive();
    return (
      <div>
        <span data-testid="pushed">{String(cadence(10_000, "res:usage"))}</span>
        <span data-testid="unpushed">{String(cadence(10_000, "res:logs"))}</span>
      </div>
    );
  }

  render(
    <LiveProvider connection={pushing("res:usage")}>
      <Pair />
    </LiveProvider>,
  );

  expect(screen.getByTestId("pushed").textContent).toBe("false");
  expect(screen.getByTestId("unpushed").textContent).toBe("10000");
});

test("cadence with no topic keeps its interval even while the socket is pushing", () => {
  // The back-compat clause, and the reason this ships as a patch rather than a
  // minor. A panel built against 0.1.1 calls `cadence(ms)` and behaves exactly
  // as it did, instead of going dark until its author republishes.
  render(
    <LiveProvider connection={pushing("res:usage")}>
      <TopicReadout />
    </LiveProvider>,
  );

  expect(screen.getByTestId("bare").textContent).toBe("10000");
});

test("an unpushed topic returns its interval and never 0", () => {
  // `0` would be worse than having no fallback at all: react-query reads it as
  // "as fast as possible", so a socket that failed to cover a topic would turn
  // into a client hammering the gateway.
  render(
    <LiveProvider connection={{ status: "poll", pushed: () => false }}>
      <TopicReadout />
    </LiveProvider>,
  );

  expect(screen.getByTestId("topic").textContent).toBe("10000");
});

test("the LIVE switch outranks the transport", async () => {
  // Paused is paused however the data would have arrived. A pushed topic that
  // kept reporting `false` while paused would be indistinguishable from a
  // working one, which is the whole reason the switch reads "am I refreshing"
  // rather than "am I polling".
  const user = userEvent.setup();
  render(
    <LiveProvider connection={pushing("res:usage")}>
      <TopicReadout />
    </LiveProvider>,
  );

  await user.click(screen.getByRole("button"));

  expect(screen.getByRole("button").textContent).toBe("PAUSED");
  expect(screen.getByTestId("topic").textContent).toBe("false");
  expect(screen.getByTestId("bare").textContent).toBe("false");
});

test("a provider with no connection reports polling, which is what a plugin panel sees", () => {
  render(
    <LiveProvider>
      <TopicReadout />
    </LiveProvider>,
  );

  expect(screen.getByTestId("status").textContent).toBe("poll");
  expect(screen.getByTestId("topic").textContent).toBe("10000");
});
