import { describe, expect, test } from "bun:test";
import { ApiError } from "../../src/api/client.ts";
import { createDashboardQueryClient } from "../../src/session/queryClient.ts";

function collectSignals(isLoginRoute: () => boolean) {
  const signals: string[] = [];
  const client = createDashboardQueryClient({
    isLoginRoute,
    onUnauthenticated: () => signals.push("redirect"),
  });
  return { client, signals };
}

describe("createDashboardQueryClient", () => {
  test("an expired session sends the operator to sign in", async () => {
    const { client, signals } = collectSignals(() => false);

    await client
      .fetchQuery({
        queryKey: ["credentials"],
        queryFn: () => Promise.reject(new ApiError(401, "AUTH", "admin session required")),
      })
      .catch(() => {});

    expect(signals).toEqual(["redirect"]);
  });

  test("the login screen does not bounce to itself", async () => {
    const { client, signals } = collectSignals(() => true);

    await client
      .fetchQuery({
        queryKey: ["status"],
        queryFn: () => Promise.reject(new ApiError(401, "AUTH", "invalid password")),
      })
      .catch(() => {});

    expect(signals).toEqual([]);
  });

  test("an ordinary failure is not a session problem", async () => {
    const { client, signals } = collectSignals(() => false);

    await client
      .fetchQuery({
        queryKey: ["models"],
        queryFn: () => Promise.reject(new ApiError(500, "INTERNAL", "internal error")),
        retry: false,
      })
      .catch(() => {});

    expect(signals).toEqual([]);
  });

  test("a rejected session is not retried", () => {
    const { client } = collectSignals(() => false);
    const retry = client.getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("expected a retry predicate");

    expect(retry(0, new ApiError(401, "AUTH", "admin session required"))).toBe(false);
    expect(retry(0, new ApiError(503, "OVERLOADED", "busy"))).toBe(true);
    expect(retry(5, new ApiError(503, "OVERLOADED", "busy"))).toBe(false);
  });
});
