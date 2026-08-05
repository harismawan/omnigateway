import { afterEach, expect, test } from "bun:test";
import { ApiError, api } from "../../src/api/client.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("get resolves the parsed json body", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  expect(await api.get<{ configured: boolean; authenticated: boolean }>("/api/status")).toEqual({
    configured: true,
    authenticated: false,
  });
});

test("every request carries the session cookie and no authorization header", async () => {
  const stub = createFetchStub({ "GET /api/credentials": () => ({ credentials: [] }) });
  await api.get("/api/credentials");
  const init = stub.calls[0]?.init;
  expect(init?.credentials).toBe("same-origin");
  expect(new Headers(init?.headers).get("authorization")).toBeNull();
});

test("post sends json and sets the content type", async () => {
  const stub = createFetchStub({ "POST /api/login": () => ({ ok: true }) });
  await api.post("/api/login", { password: "synthetic-password" });
  const init = stub.calls[0]?.init;
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  expect(init?.body).toBe(JSON.stringify({ password: "synthetic-password" }));
});

test("patch and put preserve their request methods and paths", async () => {
  const stub = createFetchStub({
    "PATCH /api/credentials/c1": () => ({ ok: true }),
    "PUT /api/models/fast": () => ({ ok: true }),
  });

  await api.patch("/api/credentials/c1", { tier: 2 });
  await api.put("/api/models/fast", { id: "fast" });

  expect(stub.calls.map(({ url, init }) => `${init?.method} ${url}`)).toEqual([
    "PATCH /api/credentials/c1",
    "PUT /api/models/fast",
  ]);
});

test("an error body becomes an ApiError carrying the gateway code", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      status: 401,
      body: { error: { code: "AUTH", message: "admin session required" } },
    }),
  });
  const error = (await api.get("/api/credentials").catch((value: unknown) => value)) as ApiError;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(401);
  expect(error.code).toBe("AUTH");
  expect(error.message).toBe("admin session required");
  expect(error.isUnauthenticated).toBe(true);
});

test("a non-json error body still produces an ApiError rather than a parse crash", async () => {
  createFetchStub({ "GET /api/logs": () => ({ status: 502, text: "Bad Gateway" }) });
  const error = (await api.get("/api/logs").catch((value: unknown) => value)) as ApiError;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(502);
  expect(error.code).toBe("INTERNAL");
  expect(error.message).toBe("request failed with status 502");
});

test("a 204 resolves to null rather than failing to parse an empty body", async () => {
  createFetchStub({ "DELETE /api/credentials/credential-1": () => ({ status: 204 }) });
  expect(await api.del<null>("/api/credentials/credential-1")).toBeNull();
});
