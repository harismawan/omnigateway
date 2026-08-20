import { expect, test } from "bun:test";
import { describeError } from "../src/errors.ts";

test("keeps an error's own message", () => {
  expect(describeError(new Error("connect ECONNREFUSED 1.2.3.4:443"), "unknown")).toBe(
    "connect ECONNREFUSED 1.2.3.4:443",
  );
});

/**
 * The case every `reason` field was blind to.
 *
 * `AggregateError` carries its detail in `errors` and has no message of its own,
 * so copying the message verbatim rendered `reason=` with nothing after it — on
 * lines whose whole purpose is to explain a failure.
 */
test("names an error that carries no message", () => {
  expect(new AggregateError([]).message).toBe("");
  expect(describeError(new AggregateError([]), "unknown")).toBe("AggregateError");
  expect(describeError(new Error(""), "unknown")).toBe("Error");
});

test("uses the caller's own fallback for anything that is not an error", () => {
  expect(describeError("a string", "invalid configuration")).toBe("invalid configuration");
  expect(describeError(undefined, "unknown")).toBe("unknown");
});
