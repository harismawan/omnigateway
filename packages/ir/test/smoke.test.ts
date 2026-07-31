import { expect, test } from "bun:test";
import { IR_VERSION } from "../src/index.ts";

test("workspace resolves the ir package", () => {
  expect(IR_VERSION).toBe(1);
});
