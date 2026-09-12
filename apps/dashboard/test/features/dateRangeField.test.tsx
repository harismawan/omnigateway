import { expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateRangeField } from "../../src/features/logs/DateRangeField.tsx";
import { dayOf, timeOf } from "../../src/features/logs/dateRange.ts";
import { renderWithProviders } from "../helpers/render.tsx";

type Range = { since: number | undefined; until: number | undefined };

/**
 * The click-pair state machine, which is the only part of this control that is
 * not a pure function of its props. `dateRange.test.ts` covers the arithmetic;
 * what is here is which click starts a range and which one finishes it.
 *
 * Each case asserts on what a click *emitted* rather than on what a re-render
 * would show, because the board owns the filters — this control is told them.
 */
function openedOn(since: number | undefined, until: number | undefined): Range[] {
  const seen: Range[] = [];
  renderWithProviders(
    <DateRangeField since={since} until={until} onChange={(next) => seen.push(next)} />,
  );
  return seen;
}

const open = async (user: ReturnType<typeof userEvent.setup>): Promise<void> =>
  user.click(screen.getByRole("button", { name: "Time range" }));

test("one click is a whole-day range, and the second extends it", async () => {
  const seen = openedOn(Date.UTC(2026, 8, 12), undefined);
  const user = userEvent.setup();
  await open(user);

  // The grid opens on the month the range names, so these are September days.
  await user.click(screen.getByRole("button", { name: "3" }));

  // A single click leaves the filters coherent rather than half-applied: the
  // board must never be asked for a range with one end missing because somebody
  // clicked once and looked away.
  const first = seen[0];
  expect(first).toBeDefined();
  expect(dayOf(first?.since ?? 0)).toBe("2026-09-03");
  expect(dayOf(first?.until ?? 0)).toBe("2026-09-03");

  await user.click(screen.getByRole("button", { name: "12" }));

  const second = seen[1];
  expect(second).toBeDefined();
  expect(dayOf(second?.since ?? 0)).toBe("2026-09-03");
  expect(dayOf(second?.until ?? 0)).toBe("2026-09-12");
});

test("a third click starts over rather than growing the range", async () => {
  const seen = openedOn(Date.UTC(2026, 8, 12), undefined);
  const user = userEvent.setup();
  await open(user);

  await user.click(screen.getByRole("button", { name: "10" }));
  await user.click(screen.getByRole("button", { name: "20" }));
  await user.click(screen.getByRole("button", { name: "5" }));

  // Without clearing the anchor on the closing click, the next one would read
  // as "extend", and a range could only ever grow — an operator narrowing after
  // a wide look would be unable to.
  const third = seen[2];
  expect(third).toBeDefined();
  expect(dayOf(third?.since ?? 0)).toBe("2026-09-05");
  expect(dayOf(third?.until ?? 0)).toBe("2026-09-05");
});

test("clicking backwards across the grid still yields an ordered range", async () => {
  const seen = openedOn(Date.UTC(2026, 8, 12), undefined);
  const user = userEvent.setup();
  await open(user);

  await user.click(screen.getByRole("button", { name: "20" }));
  await user.click(screen.getByRole("button", { name: "4" }));

  const range = seen[1];
  expect(range).toBeDefined();
  expect(dayOf(range?.since ?? 0)).toBe("2026-09-04");
  expect(dayOf(range?.until ?? 0)).toBe("2026-09-20");
  expect((range?.since ?? 0) < (range?.until ?? 0)).toBe(true);
});

test("a day click keeps the times already chosen", async () => {
  const seen = openedOn(
    new Date(2026, 8, 3, 14, 0).getTime(),
    new Date(2026, 8, 12, 15, 30, 59, 999).getTime(),
  );
  const user = userEvent.setup();
  await open(user);

  await user.click(screen.getByRole("button", { name: "7" }));

  // Picking a different day is not a reason to lose the hour somebody narrowed
  // to; only the date part of each bound moves.
  const next = seen[0];
  expect(next).toBeDefined();
  expect(timeOf(next?.since ?? 0)).toBe("14:00");
  expect(timeOf(next?.until ?? 0)).toBe("15:30");
});

test("the closed control reads the range back", async () => {
  renderWithProviders(
    <DateRangeField
      since={new Date(2026, 8, 3, 14, 0).getTime()}
      until={new Date(2026, 8, 12, 15, 30, 59, 999).getTime()}
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Time range" }).textContent).toBe(
    "Sep 3 14:00 - Sep 12 15:30",
  );
});
