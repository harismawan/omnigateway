import { afterEach, expect, test } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import {
  credentialsQuery,
  logsQuery,
  qk,
  usageQuery,
  type useInvalidate,
} from "../../src/api/queries.ts";
import { formatMs, formatTokens, formatUsd } from "../../src/lib/format.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credentialFixture } from "../helpers/fixtures.ts";
import { queryWrapper } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Invalidate = typeof useInvalidate extends () => infer Callback ? Callback : never;
type ExpectedInvalidate = (keys: readonly (readonly unknown[])[]) => Promise<void>;
const acceptsReadonlyQueryKeys: ExpectedInvalidate = null as unknown as Invalidate;
void acceptsReadonlyQueryKeys;

test("query keys are stable and distinguish their arguments", () => {
  expect(qk.credentials()).toEqual(["credentials"]);
  expect(qk.usage("model", 100)).toEqual(["usage", "model", 100]);
  expect(qk.usage("credential", 100)).not.toEqual(qk.usage("model", 100));
  expect(qk.logs(50)).toEqual(["logs", 50]);
});

test("credentialsQuery unwraps the credentials envelope", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture({ id: "c1" })] }),
  });
  const { result } = renderHook(() => useQuery(credentialsQuery()), { wrapper: queryWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.[0]?.id).toBe("c1");
});

test("usageQuery encodes groupBy and since into the query string", async () => {
  const stub = createFetchStub({
    "GET /api/usage?groupBy=credential&since=1000": () => ({ rows: [] }),
  });
  const { result } = renderHook(() => useQuery(usageQuery("credential", 1000)), {
    wrapper: queryWrapper(),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(stub.calls[0]?.url).toBe("/api/usage?groupBy=credential&since=1000");
});

test("logsQuery caps the limit and sets a refetch interval", () => {
  const options = logsQuery(50, 3000);
  expect([...options.queryKey]).toEqual(["logs", 50]);
  expect(options.refetchInterval).toBe(3000);
  expect(options.staleTime).toBe(0);
});

test("formatters render the units an operator reads", () => {
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(formatTokens(2_400)).toBe("2.4K");
  expect(formatTokens(42)).toBe("42");
  expect(formatUsd(1.5)).toBe("$1.50");
  expect(formatUsd(0.0004)).toBe("$0.0004");
  expect(formatMs(950)).toBe("950ms");
  expect(formatMs(2_500)).toBe("2.5s");
  expect(formatMs(null)).toBe("—");
});
