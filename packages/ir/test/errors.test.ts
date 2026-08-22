import { expect, test } from "bun:test";
import { describeError, GatewayError, HTTP_STATUS, RETRYABLE } from "../src/errors.ts";

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

/**
 * The fingerprint refusal is a property of the body, not of the credential.
 *
 * Every candidate is handed the same tool names, so retrying one walks the
 * whole pool to collect the identical 400 — the reasoning `BAD_REQUEST`
 * already carries.
 */
test("a fingerprint refusal is not retried and reaches the client as a 400", () => {
  expect(RETRYABLE.FINGERPRINT_REFUSED).toBe(false);
  expect(HTTP_STATUS.FINGERPRINT_REFUSED).toBe(400);
  expect(new GatewayError("FINGERPRINT_REFUSED", "out of extra usage").retryable).toBe(false);
});

test("an error carries no degradations unless one was attached", () => {
  // The false-positive direction, which is the one that matters: a non-empty
  // default would drain a phantom entry into `request_logs.degradations` on
  // every request that failed for any reason, including ones that never
  // reached the provider it names. The column is operator-facing, so a wrong
  // entry answers "what did this request lose?" confidently and incorrectly.
  expect(new GatewayError("UPSTREAM", "boom").degradations).toEqual([]);
  expect(new GatewayError("AUTH", "no", { provider: "openai" }).degradations).toEqual([]);
});

test("an error's degradations are a copy, not the caller's array", () => {
  // `readonly` is a compile-time claim only, and the adapter passes a local it
  // is still appending to when the throw happens.
  const live = ["kimi:images-dropped"];
  const error = new GatewayError("UPSTREAM", "boom", { degradations: live });
  live.push("anthropic:tool-names-cloaked");
  expect(error.degradations).toEqual(["kimi:images-dropped"]);
});
