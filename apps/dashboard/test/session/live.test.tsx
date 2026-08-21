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
