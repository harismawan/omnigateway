import { expect, test } from "bun:test";
import { httpError } from "../src/http.ts";
import type { HttpResponse } from "../src/types.ts";

function response(status: number, body: string): HttpResponse {
  return {
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body),
  } as unknown as HttpResponse;
}

test("reads the message out of the usual error envelope", async () => {
  const error = await httpError(
    response(
      400,
      JSON.stringify({ error: { type: "invalid_request_error", message: "bad tool" } }),
    ),
    "anthropic",
  );
  expect(error.message).toBe("bad tool");
  expect(error.code).toBe("BAD_REQUEST");
});

test("reads a bare detail body instead of handing back raw JSON", async () => {
  const error = await httpError(
    response(400, JSON.stringify({ detail: "System messages are not allowed" })),
    "kimi",
  );
  // Previously the client saw the whole JSON blob as the message.
  expect(error.message).toBe("System messages are not allowed");
  expect(error.code).toBe("BAD_REQUEST");
});

test("a non-string detail does not become the message", async () => {
  const error = await httpError(
    response(422, JSON.stringify({ detail: [{ loc: ["body"], msg: "nope" }] })),
    "kimi",
  );
  expect(error.message).toBe(JSON.stringify({ detail: [{ loc: ["body"], msg: "nope" }] }));
});

test("falls back to the status when the body is not JSON", async () => {
  const error = await httpError(response(502, "<html>bad gateway</html>"), "openai");
  expect(error.message).toBe("<html>bad gateway</html>");
  expect(error.code).toBe("UPSTREAM");
});
