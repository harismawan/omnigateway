import { expect, test } from "bun:test";
import { showPerformance } from "./bench-report";

test("failed matrix observations cannot print performance", () => {
  expect(showPerformance(true, "failed")).toBe(false);
  expect(showPerformance(true, "unsupported")).toBe(false);
  expect(showPerformance(true, "supported")).toBe(true);
  expect(showPerformance(false)).toBe(true);
});
