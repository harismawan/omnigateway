import { expect, test } from "bun:test";
import { createBodyBudget, reservationBytes } from "../../../src/export/body/budget.ts";

test("one admitted body across destinations; cancellation releases reservations", async () => {
  const budget = createBodyBudget(1000);
  const first = await budget.acquire(new AbortController().signal);
  expect(first.reserve(800)).toBe(true);
  expect(budget.held()).toBe(800);
  let admitted = false;
  const controller = new AbortController();
  const cancelled = budget.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  const next = budget.acquire(new AbortController().signal).then((slot) => {
    admitted = true;
    return slot;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  first.shrink(300);
  expect(budget.held()).toBe(300);
  first.release();
  first.release();
  const second = await next;
  expect(second.reserve(1001)).toBe(false);
  expect(budget.held()).toBe(0);
  second.release();
  expect(reservationBytes(100, 200, 300)).toBe(1000);
});

test("cancellation during slot handoff does not strand the semaphore", async () => {
  const budget = createBodyBudget(1000);
  const first = await budget.acquire(new AbortController().signal);
  const controller = new AbortController();
  const next = budget.acquire(controller.signal);
  first.release();
  controller.abort(new Error("handoff cancelled"));
  await expect(next).rejects.toThrow("handoff cancelled");
  const last = await budget.acquire(new AbortController().signal);
  expect(last.reserve(1000)).toBe(true);
  last.release();
});
