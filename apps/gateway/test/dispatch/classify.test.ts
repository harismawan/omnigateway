import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { classify, describeError } from "../../src/dispatch/classify.ts";

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

/**
 * How a failed multi-address connect arrives.
 *
 * `autoSelectFamily` is on by default, so node tries every address a host
 * resolves to and reports total failure as an `AggregateError` whose own
 * message is empty — every address's error is in `errors`. Matching on the
 * message alone therefore sees `""`, falls through to INTERNAL, and takes a
 * retryable transport failure off the retry path: `RETRYABLE.INTERNAL` is
 * false, so dispatch stops after one attempt and serves a 500.
 */
test("maps an aggregate connect failure to NETWORK", () => {
  const e = new AggregateError([
    new Error("connect ECONNREFUSED 2607:6bc0::10:443"),
    new Error("connect ECONNREFUSED 160.79.104.10:443"),
  ]);
  expect(e.message).toBe("");
  expect(classify(e).code).toBe("NETWORK");
});

test("leaves an aggregate of unrecognised errors as INTERNAL", () => {
  expect(classify(new AggregateError([new Error("something odd")])).code).toBe("INTERNAL");
});

test("describes an error that carries no message by its name", () => {
  expect(describeError(new AggregateError([]))).toBe("AggregateError");
  expect(describeError(new Error("something odd"))).toBe("something odd");
  expect(describeError("a string")).toBe("attempt failed");
});
