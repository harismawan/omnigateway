import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import {
  pollConnect,
  queryKeys,
  useClientLogPages,
  useCreateKey,
  useCredentials,
  useKeys,
  useLogPages,
  useLogs,
  useUsage,
} from "../../src/api/queries.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, credential, log } from "../helpers/fixtures.ts";
import { makeQueryClient, queryWrapper } from "../helpers/render.tsx";

describe("query hooks", () => {
  test("prompt filter survives both wire projections while client identity filters cannot escape", async () => {
    const stub = createFetchStub({
      "GET /api/logs": () => ({ logs: [], nextCursor: null }),
      "GET /api/client/logs": () => ({ logs: [], nextCursor: null }),
    });
    const filters = { prompt: "team", apiKeyId: "another-key", credentialId: "private-account" };
    const wrapper = queryWrapper(makeQueryClient({ catalog: false }));
    const admin = renderHook(() => useLogPages(filters, 20, false), { wrapper });
    const holder = renderHook(() => useClientLogPages(filters, 20, false), { wrapper });
    await waitFor(() =>
      expect(admin.result.current.isSuccess && holder.result.current.isSuccess).toBe(true),
    );
    const operator = new URL(
      stub.calls.find((c) => c.url.startsWith("/api/logs?"))?.url ?? "",
      "http://local",
    );
    const client = new URL(
      stub.calls.find((c) => c.url.startsWith("/api/client/logs?"))?.url ?? "",
      "http://local",
    );
    expect(operator.searchParams.get("prompt")).toBe("team");
    expect(operator.searchParams.get("apiKeyId")).toBe("another-key");
    expect(operator.searchParams.get("credentialId")).toBe("private-account");
    expect(client.searchParams.get("prompt")).toBe("team");
    expect(client.searchParams.has("apiKeyId")).toBe(false);
    expect(client.searchParams.has("credentialId")).toBe(false);
  });
  test("useCredentials unwraps the envelope", async () => {
    createFetchStub({ "GET /api/credentials": () => ({ credentials: [credential()] }) });
    const { result } = renderHook(() => useCredentials(), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.label).toBe("claude-main");
  });

  test("useLogs passes the limit through", async () => {
    const stub = createFetchStub({ "GET /api/logs": () => ({ logs: [log()] }) });
    const { result } = renderHook(() => useLogs(250, false), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stub.calls[0]?.url).toBe("/api/logs?limit=250");
  });

  test("useUsage builds the range query and keys on it", async () => {
    const stub = createFetchStub({ "GET /api/usage": () => ({ rows: [] }) });
    const { result } = renderHook(
      () => useUsage({ groupBy: "hour", since: 1_000, until: 2_000 }, false),
      { wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stub.calls[0]?.url).toBe("/api/usage?groupBy=hour&since=1000&until=2000");
    expect(queryKeys.usage({ groupBy: "hour", since: 1_000, until: 2_000 })).toEqual([
      "usage",
      "raw",
      "hour",
      null,
      1_000,
      2_000,
      null,
      null,
    ]);
  });

  test("useUsage sends the account filter and keys on it", async () => {
    const stub = createFetchStub({ "GET /api/usage": () => ({ rows: [] }) });
    const query = { groupBy: "hour", since: 1_000, credentialId: "c2" } as const;
    const { result } = renderHook(() => useUsage(query, false), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stub.calls[0]?.url).toBe("/api/usage?groupBy=hour&since=1000&credentialId=c2");
    // Two accounts must never share a cached answer.
    expect(queryKeys.usage(query)).not.toEqual(queryKeys.usage({ ...query, credentialId: "c1" }));
  });

  test("useUsage sends the key filter and keys on it", async () => {
    const stub = createFetchStub({ "GET /api/usage": () => ({ rows: [] }) });
    const query = { groupBy: "hour", since: 1_000, apiKeyId: "k2" } as const;
    const { result } = renderHook(() => useUsage(query, false), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stub.calls[0]?.url).toBe("/api/usage?groupBy=hour&since=1000&apiKeyId=k2");
    expect(queryKeys.usage(query)).not.toEqual(queryKeys.usage({ ...query, apiKeyId: "k1" }));
    // Distinct slots: the same id as an account and as a key are different reads.
    expect(queryKeys.usage({ groupBy: "hour", since: 1_000, credentialId: "x" })).not.toEqual(
      queryKeys.usage({ groupBy: "hour", since: 1_000, apiKeyId: "x" }),
    );
  });
});

describe("mutations", () => {
  test("creating a key refetches the key list", async () => {
    let listCalls = 0;
    createFetchStub({
      "GET /api/keys": () => {
        listCalls += 1;
        return { keys: [apiKey()] };
      },
      "POST /api/keys": () => ({
        id: "key-2",
        label: "ci",
        prefix: "omni_sk_zzzz",
        key: "omni_sk_zzzz_secret",
      }),
    });

    const client = makeQueryClient();
    const wrapper = queryWrapper(client);
    const list = renderHook(() => useKeys(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(listCalls).toBe(1);

    const create = renderHook(() => useCreateKey(), { wrapper });
    create.result.current.mutate({
      label: "ci",
      prompts: { ids: [], inheritGlobal: true },
      modelAllowlist: null,
      limits: {},
      bodyLoggingOptOut: false,
      expiresAt: null,
    });

    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
    expect(create.result.current.data?.key).toBe("omni_sk_zzzz_secret");
    await waitFor(() => expect(listCalls).toBe(2));
  });
});

describe("pollConnect", () => {
  test("reports a 202 as pending rather than as a failure", async () => {
    createFetchStub({
      "POST /api/connect/poll": () => ({ status: 202, body: { status: "pending" } }),
    });
    await expect(pollConnect("flow-1")).resolves.toEqual({ status: "pending" });
  });

  test("reports the created credential when the flow completes", async () => {
    createFetchStub({
      "POST /api/connect/poll": () => ({ status: "complete", id: "cred-9" }),
    });
    await expect(pollConnect("flow-1")).resolves.toEqual({ status: "complete", id: "cred-9" });
  });

  test("still throws on a real failure", async () => {
    createFetchStub({
      "POST /api/connect/poll": () => ({
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "unknown or expired authorization" } },
      }),
    });
    await expect(pollConnect("flow-1")).rejects.toThrow("unknown or expired authorization");
  });
});
