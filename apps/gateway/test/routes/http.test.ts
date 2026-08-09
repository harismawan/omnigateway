import { expect, test } from "bun:test";
import type { ErrorHandler } from "elysia";
import { apiErrorHandler, readJson } from "../../src/routes/http.ts";

const _elysiaErrorHandler: ErrorHandler = apiErrorHandler;

test("readJson preserves body stream failures", async () => {
  const failure = new DOMException("client disconnected", "AbortError");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure);
    },
  });
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  await expect(readJson(request)).rejects.toBe(failure);
});

test("apiErrorHandler preserves route fallthrough", () => {
  expect(apiErrorHandler({ code: "NOT_FOUND", error: new Error("not found") })).toBeUndefined();
});

test("apiErrorHandler redacts unexpected errors", async () => {
  const response = apiErrorHandler({ code: "UNKNOWN", error: new Error("leaked-secret-token") });
  if (response === undefined) throw new Error("expected an API error response");

  expect(response.status).toBe(500);
  expect((await response.json()) as { error: { code: string; message: string } }).toEqual({
    error: { code: "INTERNAL", message: "internal error" },
  });
});
