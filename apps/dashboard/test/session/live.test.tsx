import { expect, test } from "bun:test";
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
  // copies of the SDK module mean two `createContext` calls, and a panel
  // reading the second finds no provider and pauses forever. Importing through
  // the console's own `session/live.tsx` re-export and providing through it
  // proves the identity survives the hop the console actually makes.
  const sdk = await import("@omnigateway/dashboard-sdk");
  const user = userEvent.setup();

  render(
    <LiveProvider>
      <sdk.LiveProvider>
        <Readout />
      </sdk.LiveProvider>
    </LiveProvider>,
  );

  // The inner provider wins, so toggling reaches it — which can only be true if
  // both spellings name one context.
  await user.click(screen.getByRole("button"));
  expect(screen.getByTestId("cadence").textContent).toBe("false");
});
