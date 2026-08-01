import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { classify } from "../../src/dispatch/classify.ts";

test("passes a gateway error through with its retry hint", () => {
  const e = new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 5000 });
  expect(classify(e)).toEqual({ code: "RATE_LIMIT", retryAfterMs: 5000 });
});

test("maps an abort to TIMEOUT", () => {
  const e = new DOMException("aborted", "AbortError");
  expect(classify(e).code).toBe("TIMEOUT");
});

test("maps a fetch failure to NETWORK", () => {
  expect(classify(new TypeError("fetch failed")).code).toBe("NETWORK");
});

test("maps connection errors to NETWORK", () => {
  expect(classify(new Error("ECONNREFUSED 1.2.3.4:443")).code).toBe("NETWORK");
  expect(classify(new Error("Unable to connect")).code).toBe("NETWORK");
});

test("falls back to INTERNAL for anything unrecognised", () => {
  expect(classify(new Error("something odd")).code).toBe("INTERNAL");
  expect(classify("a string").code).toBe("INTERNAL");
});
