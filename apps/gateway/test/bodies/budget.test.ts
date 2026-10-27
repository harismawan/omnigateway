import { expect, test } from "bun:test";
import { createCaptureBudget } from "../../src/bodies/budget.ts";

test("admits reservations up to the limit exactly and refuses the byte past it", () => {
  const budget = createCaptureBudget(100);
  expect(budget.reserve(60)).toBe(true);
  expect(budget.reserve(40)).toBe(true);
  expect(budget.held()).toBe(100);
  expect(budget.reserve(1)).toBe(false);
  // A refusal reserves nothing, so it cannot leak what it never held.
  expect(budget.held()).toBe(100);
});

test("a release makes room again, and a zero-byte reservation always fits", () => {
  const budget = createCaptureBudget(10);
  expect(budget.reserve(10)).toBe(true);
  expect(budget.reserve(0)).toBe(true);
  budget.release(4);
  expect(budget.held()).toBe(6);
  expect(budget.reserve(5)).toBe(false);
  expect(budget.reserve(4)).toBe(true);
  expect(budget.held()).toBe(10);
});

test("one reservation larger than the whole budget is refused outright", () => {
  const budget = createCaptureBudget(10);
  expect(budget.reserve(11)).toBe(false);
  expect(budget.held()).toBe(0);
});

test("releasing more than is held never drives the count negative", () => {
  const budget = createCaptureBudget(10);
  budget.reserve(3);
  budget.release(5);
  expect(budget.held()).toBe(0);
  expect(budget.reserve(10)).toBe(true);
});
