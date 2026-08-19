import { afterEach, expect, test } from "bun:test";
import { createPluginApi, PluginApiError, pluginApiPath, usePluginApi } from "../src/index.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit | undefined };

/**
 * Record what would have gone over the wire.
 *
 * The whole point of the prefix guard is the URL, so the assertion has to be on
 * the URL the request was actually made with — not on the return value of a
 * helper the request might not use.
 */
function stubFetch(status = 200, body: unknown = { ok: true }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return calls;
}

test("a normal path lands under the plugin's own prefix", () => {
  expect(pluginApiPath("pokemon", "state")).toBe("/api/plugins/pokemon/state");
  expect(pluginApiPath("pokemon", "party/1")).toBe("/api/plugins/pokemon/party/1");
  expect(pluginApiPath("pokemon", "history?days=7")).toBe("/api/plugins/pokemon/history?days=7");
});

test("every verb sends to the plugin's prefix, same-origin, with no token", async () => {
  const calls = stubFetch();
  const api = createPluginApi("pokemon");

  await api.get("state");
  await api.post("party", { id: 25 });
  await api.put("party/1", { id: 26 });
  await api.del("party/1");

  expect(calls.map((c) => c.url)).toEqual([
    "/api/plugins/pokemon/state",
    "/api/plugins/pokemon/party",
    "/api/plugins/pokemon/party/1",
    "/api/plugins/pokemon/party/1",
  ]);
  expect(calls.map((c) => c.init?.method)).toEqual(["GET", "POST", "PUT", "DELETE"]);

  // A body without a JSON content-type is a body the plugin's own route will
  // not parse. Elysia branches on the header, so dropping it turns every write
  // into a handler receiving nothing — reported by the plugin's validation, not
  // by anything pointing here.
  const bodied = calls.filter((c) => c.init?.body !== undefined);
  expect(bodied.length).toBe(2);
  for (const call of bodied) {
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  }
  // A GET carries no body and so declares no content-type.
  expect(Object.keys((calls[0]?.init?.headers ?? {}) as Record<string, string>)).toEqual([]);

  for (const call of calls) {
    // Session state is an HttpOnly cookie the plugin cannot read. A plugin that
    // never holds a credential is a plugin that cannot leak or log one, so an
    // Authorization header appearing here is a design change, not a detail.
    expect(call.init?.credentials).toBe("same-origin");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-api-key");
  }
});

// Each escape shape is its own case on purpose. They fail for different
// reasons — a literal `..`, a pre-encoded one, an absolute path — and a single
// combined assertion would keep passing while two of the three regressed.

test("a path with a leading `..` is refused, not normalised", () => {
  // Normalising `../keys` to `keys` would succeed against the wrong endpoint
  // and surface as wrong data rather than as an error.
  expect(() => pluginApiPath("pokemon", "../keys")).toThrow(/escape/);
});

test("a path with an interior `..` is refused, not normalised", () => {
  expect(() => pluginApiPath("pokemon", "party/../../../keys")).toThrow(/escape/);
});

test("a bare `..` is refused", () => {
  expect(() => pluginApiPath("pokemon", "..")).toThrow(/escape/);
});

test("a percent-encoded `..` is refused", () => {
  // `encodeURIComponent(".")` is `"."`, so nothing legitimate produces `%2e`.
  // The SDK cannot know whether the router on the other end decodes before it
  // matches, so it refuses the shape rather than betting on the receiver.
  expect(() => pluginApiPath("pokemon", "%2e%2e/keys")).toThrow(/escape/);
  expect(() => pluginApiPath("pokemon", "%2E%2E/keys")).toThrow(/escape/);
});

test("a path starting with `/` is refused, not normalised", () => {
  // Not an escape today, because the result is concatenated and stays under the
  // prefix. Refused because the author meant an absolute path, and the obvious
  // refactor to `new URL(path, base)` would start honouring that meaning.
  expect(() => pluginApiPath("pokemon", "/api/keys")).toThrow(/relative/);
});

test("a protocol-relative path is refused", () => {
  expect(() => pluginApiPath("pokemon", "//evil.example/keys")).toThrow(/relative/);
});

test("an empty path is refused", () => {
  expect(() => pluginApiPath("pokemon", "")).toThrow(/empty/);
});

test("a plugin id that would escape its own segment is refused", () => {
  // The id arrives from a manifest the host parsed, but a helper whose safety
  // depends on a file it cannot see is a helper with no safety property.
  expect(() => pluginApiPath("..", "state")).toThrow(/escape/);
  expect(() => pluginApiPath("a/b", "state")).toThrow(/single path segment/);
  expect(() => pluginApiPath("", "state")).toThrow(/empty/);
});

test("a refused path never reaches the network", async () => {
  // The guard has to sit in front of `fetch`, not beside it. A rejection raised
  // after the request went out would report an error to the plugin and still
  // have made the call.
  const calls = stubFetch();
  const api = createPluginApi("pokemon");
  await expect(api.get("../keys")).rejects.toThrow(/escape/);
  await expect(api.post("/api/keys", {})).rejects.toThrow(/relative/);
  expect(calls).toEqual([]);
});

test("an error response becomes a PluginApiError carrying the gateway's code", async () => {
  stubFetch(401, { error: { code: "AUTH", message: "session expired" } });
  const api = createPluginApi("pokemon");
  const error = await api.get("state").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PluginApiError);
  expect(error as PluginApiError).toMatchObject({ status: 401, code: "AUTH" });
  expect((error as PluginApiError).isUnauthenticated).toBe(true);
});

/** The error a failing call raised, insisting that it did fail. */
async function failureOf(status: number, body: unknown): Promise<PluginApiError> {
  stubFetch(status, body);
  try {
    await createPluginApi("pokemon").get("state");
  } catch (error) {
    if (error instanceof PluginApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

test("isUnauthenticated reads the code, not only the status", async () => {
  // The console's session middleware does not answer 401 on every path, so a
  // check on status alone would leave a plugin rendering a "failed to load"
  // panel over a dead session instead of sending the operator to sign in.
  const withCode = await failureOf(403, { error: { code: "AUTH", message: "session expired" } });
  expect(withCode.isUnauthenticated).toBe(true);

  const other = await failureOf(403, { error: { code: "FORBIDDEN", message: "not yours" } });
  expect(other.isUnauthenticated).toBe(false);
});

test("usePluginApi is stable across calls, per plugin id", () => {
  // A fresh object per render would be a new identity for a value that never
  // changes, which is what turns `useEffect(…, [api])` into a loop and defeats
  // a `queryKey` built from it.
  expect(usePluginApi("pokemon")).toBe(usePluginApi("pokemon"));
  expect(usePluginApi("pokemon")).not.toBe(usePluginApi("weather"));
});

test("usePluginApi is bound to the id it was given", async () => {
  const calls = stubFetch();
  await usePluginApi("weather").get("forecast");
  expect(calls[0]?.url).toBe("/api/plugins/weather/forecast");
});
