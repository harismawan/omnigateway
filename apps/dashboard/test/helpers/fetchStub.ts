/**
 * Replaces `globalThis.fetch` with a route table.
 *
 * A handler returns either the JSON body directly, or a `StubResponse` when the
 * test needs a specific status. Nothing here touches the network, so a test
 * that forgets a route gets a loud 501 rather than a hanging socket.
 */
export type StubResponse = { status?: number; body?: unknown; text?: string };

export type StubHandler = (input: {
  url: string;
  init: RequestInit | undefined;
}) => StubResponse | Record<string, unknown> | Array<unknown>;

export type FetchStub = {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  /** Replace or add a route after the stub is installed. */
  set(route: string, handler: StubHandler): void;
};

function isStubResponse(value: unknown): value is StubResponse {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 && keys.every((key) => key === "status" || key === "body" || key === "text")
  );
}

export function createFetchStub(routes: Record<string, StubHandler>): FetchStub {
  const table = new Map(Object.entries(routes));
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = raw.startsWith("http") ? new URL(raw).pathname + new URL(raw).search : raw;
    calls.push({ url, init });

    const method = (init?.method ?? "GET").toUpperCase();
    const route = `${method} ${url}`;
    const handler = table.get(route) ?? table.get(`${method} ${url.split("?")[0]}`);
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: `no stub for ${method} ${url}` } }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }

    const result = handler({ url, init });
    if (isStubResponse(result)) {
      const status = result.status ?? 200;
      if (status === 204) return new Response(null, { status });
      if (typeof result.text === "string") {
        return new Response(result.text, { status, headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify(result.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return {
    calls,
    set(route, handler) {
      table.set(route, handler);
    },
  };
}
