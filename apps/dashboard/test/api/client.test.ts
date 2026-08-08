import { describe, expect, test } from "bun:test";
import { ApiError, del, get, post, request, withQuery } from "../../src/api/client.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";

describe("request", () => {
  test("sends JSON bodies and carries the session cookie", async () => {
    const stub = createFetchStub({ "POST /api/login": () => ({ ok: true }) });
    await post("/api/login", { password: "hunter2" });

    const call = stub.calls[0];
    expect(call?.url).toBe("/api/login");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.credentials).toBe("same-origin");
    expect(call?.init?.body).toBe(JSON.stringify({ password: "hunter2" }));
  });

  test("omits a content-type when there is no body", async () => {
    const stub = createFetchStub({ "GET /api/status": () => ({ configured: true }) });
    await get("/api/status");
    expect(stub.calls[0]?.init?.headers).toEqual({});
  });

  test("raises the gateway's own error code", async () => {
    createFetchStub({
      "DELETE /api/keys/key-1": () => ({
        status: 401,
        body: { error: { code: "AUTH", message: "admin session required" } },
      }),
    });

    const failure = await del("/api/keys/key-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe("AUTH");
    expect(apiError.status).toBe(401);
    expect(apiError.message).toBe("admin session required");
    expect(apiError.isUnauthenticated).toBe(true);
  });

  test("falls back to the status when the body is not an error shape", async () => {
    createFetchStub({ "GET /api/models": () => ({ status: 502, text: "<html>bad gateway" }) });
    const failure = (await get("/api/models").catch((error: unknown) => error)) as ApiError;
    expect(failure.code).toBe("INTERNAL");
    expect(failure.message).toBe("request failed with status 502");
  });

  test("hands back an accepted non-OK status instead of throwing", async () => {
    createFetchStub({
      "POST /api/connect/poll": () => ({ status: 202, body: { status: "pending" } }),
    });
    const result = await request<{ status: string }>("/api/connect/poll", {
      method: "POST",
      body: { flowId: "f1" },
      accept: [202],
    });
    expect(result.status).toBe(202);
    expect(result.data.status).toBe("pending");
  });

  test("treats a 204 as an empty body", async () => {
    createFetchStub({ "DELETE /api/models/fast": () => ({ status: 204 }) });
    await expect(del("/api/models/fast")).resolves.toBeNull();
  });
});

describe("withQuery", () => {
  test("skips absent params and escapes the rest", () => {
    expect(withQuery("/api/usage", { groupBy: "model", since: 10, until: undefined })).toBe(
      "/api/usage?groupBy=model&since=10",
    );
    expect(withQuery("/api/logs", {})).toBe("/api/logs");
    expect(withQuery("/api/usage", { groupBy: "a b" })).toBe("/api/usage?groupBy=a+b");
  });
});
