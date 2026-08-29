import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpRequest, HttpResponse } from "@omni/providers";
import { oauthAdapter, type PluginOAuthFlow } from "../../src/oauth/pluginFlow.ts";
import { isAuthorizationPending, type OAuthDeps } from "../../src/oauth/types.ts";

/**
 * The auth half of the `provider` capability, judged against what the shipped
 * flows actually do.
 *
 * The contract's shape was chosen from a measurement rather than from taste:
 * most steps are one request, `grok.start` is a discovery call followed by local
 * work, and `kilo.exchange` is two, where the second carries a token read from
 * the first. A build/parse pair cannot express the last of those, which is why
 * a step is a generator.
 */

function transport(reply: (req: HttpRequest, n: number) => { status: number; body: string }): {
  sent: HttpRequest[];
  deps: OAuthDeps;
} {
  const sent: HttpRequest[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    sent.push(req);
    const { status, body } = reply(req, sent.length);
    return {
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => body,
    };
  };
  return { sent, deps: { http, now: () => 1_000_000 } };
}

const secrets = {
  accessToken: "a",
  refreshToken: "r",
  apiKey: null,
  idToken: null,
} as const;

/** A device flow shaped exactly like kilo's: begin, then a two-request exchange. */
const kiloShaped: PluginOAuthFlow = {
  kind: "device",
  supportsManualPaste: false,
  needsDeviceId: false,

  async *begin(input) {
    const res = yield {
      url: "https://api.acme.test/codes",
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: "{}",
    };
    const parsed = JSON.parse(res.body) as { code: string; url: string };
    return {
      authorizeUrl: parsed.url,
      pending: {
        verifier: "",
        challenge: "",
        state: input.randomState(),
        redirectUri: "",
        deviceCode: parsed.code,
      },
    };
  },

  // A step needing no request is still a generator: that is the contract rather
  // than an oversight, and anthropic's own start yields nothing either.
  // biome-ignore lint/correctness/useYield: explained directly above
  async *start() {
    // Nothing to mint before `begin`; the device identity is the upstream's.
    return {
      authorizeUrl: "",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
    };
  },

  async *exchange(input) {
    const poll = yield {
      url: `https://api.acme.test/codes/${input.pending.deviceCode}`,
      method: "GET",
      headers: [],
    };
    // Status read as meaning, not merely as success.
    if (poll.status === 202) throw input.keepPolling("http_202");
    if (poll.status === 403) throw input.fail("AUTH", "acme authorization was denied");

    const token = (JSON.parse(poll.body) as { token: string }).token;
    // The second request, carrying a value from the first response's body.
    const profile = yield {
      url: "https://api.acme.test/profile",
      method: "GET",
      headers: [["authorization", `Bearer ${token}`]],
    };
    const org = (JSON.parse(profile.body) as { orgId: string }).orgId;

    return {
      secrets: { accessToken: token, refreshToken: null, apiKey: null, idToken: null },
      expiresAt: null,
      accountEmail: null,
      providerData: { orgId: org },
    };
  },

  async *refresh(input) {
    const res = yield {
      url: "https://api.acme.test/token",
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ refresh_token: input.refreshToken }),
    };
    if (res.status !== 200) throw input.fail("AUTH", "acme refused the refresh");
    return {
      secrets: { accessToken: "fresh", refreshToken: null, apiKey: null, idToken: null },
      expiresAt: null,
      accountEmail: null,
      providerData: {},
    };
  },
};

const ORIGINS = ["https://api.acme.test"];

test("a two-request step works, and the second carries what the first returned", async () => {
  // The case that decided the contract's shape. A build/parse pair per step
  // cannot express it: whether the second request happens, and what it carries,
  // are both read off the first response's body.
  const { sent, deps } = transport((_req, n) =>
    n === 1
      ? { status: 200, body: JSON.stringify({ token: "tok-1" }) }
      : { status: 200, body: JSON.stringify({ orgId: "org-9" }) },
  );
  const provider = oauthAdapter("acme", kiloShaped, ORIGINS);

  const result = await provider.exchange(
    {
      code: "",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc" },
    },
    deps,
  );

  expect(sent).toHaveLength(2);
  expect(sent[0]?.url).toBe("https://api.acme.test/codes/dc");
  expect(sent[1]?.url).toBe("https://api.acme.test/profile");
  // The token from the first response authenticates the second.
  expect(sent[1]?.headers).toContainEqual(["authorization", "Bearer tok-1"]);
  expect(result.secrets.accessToken).toBe("tok-1");
  expect(result.providerData).toEqual({ orgId: "org-9" });
});

test("keepPolling is a not-yet, distinguishable from a failure", async () => {
  // The host loops on this. Without a way for a plugin to say it, a device flow
  // could only fail — and the operator would be told authorization was refused
  // while they were still looking at the approval screen.
  const { deps } = transport(() => ({ status: 202, body: "" }));
  const provider = oauthAdapter("acme", kiloShaped, ORIGINS);

  const attempt = provider.exchange(
    {
      code: "",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc" },
    },
    deps,
  );
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    expect(isAuthorizationPending(error)).toBe(true);
  });
});

test("a denial is a failure, and is not mistaken for a not-yet", async () => {
  const { deps } = transport(() => ({ status: 403, body: "" }));
  const provider = oauthAdapter("acme", kiloShaped, ORIGINS);
  const attempt = provider.exchange(
    {
      code: "",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc" },
    },
    deps,
  );
  await attempt.catch((error: unknown) => {
    expect(isAuthorizationPending(error)).toBe(false);
    expect((error as GatewayError).code).toBe("AUTH");
    expect((error as GatewayError).provider).toBe("acme");
  });
  await expect(attempt).rejects.toThrow(GatewayError);
});

test("a flow cannot reach an origin its manifest never declared", async () => {
  const wandering: PluginOAuthFlow = {
    ...kiloShaped,
    async *exchange() {
      yield { url: "https://exfiltrate.test/token", method: "POST", headers: [], body: "" };
      throw new Error("unreachable");
    },
  };
  const { sent, deps } = transport(() => ({ status: 200, body: "{}" }));
  const provider = oauthAdapter("acme", wandering, ORIGINS);

  const attempt = provider.exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );
  await expect(attempt).rejects.toThrow(GatewayError);
  // Refused before the transport: a token call to somewhere else is one an
  // operator's manifest never admitted.
  expect(sent).toEqual([]);
});

test("a flow that never returns is stopped rather than holding the connect open", async () => {
  const looping: PluginOAuthFlow = {
    ...kiloShaped,
    async *exchange() {
      while (true) {
        yield { url: "https://api.acme.test/poll", method: "GET", headers: [] };
      }
    },
  };
  const { sent, deps } = transport(() => ({ status: 200, body: "{}" }));
  const provider = oauthAdapter("acme", looping, ORIGINS);

  const attempt = provider.exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).message).toContain("more than");
  });
  // The exact bound, not `toBeLessThanOrEqual`. That form kills the
  // count-after-the-request mutant, which yields five — and passes just as well
  // for a cap of one, which is not the contract.
  expect(sent).toHaveLength(4);
});

test("the host stamps the provider, so a flow cannot claim another one's name", async () => {
  const impostor: PluginOAuthFlow = {
    ...kiloShaped,
    // biome-ignore lint/correctness/useYield: throwing before any request is the case
    async *exchange(input) {
      throw input.fail("AUTH", "nope");
    },
  };
  const { deps } = transport(() => ({ status: 200, body: "{}" }));
  const attempt = oauthAdapter("acme", impostor, ORIGINS).exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );
  // Paired with the `catch`: a bare `.catch(cb)` passes green if the promise
  // ever resolves, because the callback simply never runs.
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).provider).toBe("acme");
    // The plugin's own text, so it must not claim the gateway wrote it.
    expect((error as GatewayError).gatewayAuthored).toBe(false);
  });
});

test("a device flow with no begin is refused at registration, not at connect", async () => {
  // Discovering it when an operator clicks connect is discovering it in the
  // worst available place.
  const { begin: _dropped, ...noBegin } = kiloShaped;
  expect(() => oauthAdapter("acme", noBegin as PluginOAuthFlow)).toThrow(/begin/);
});

test("a step that throws something arbitrary is relabelled, not passed through", async () => {
  const broken: PluginOAuthFlow = {
    ...kiloShaped,
    // biome-ignore lint/correctness/useYield: throwing before any request is the case
    async *exchange() {
      throw new TypeError("undefined is not a function");
    },
  };
  const { deps } = transport(() => ({ status: 200, body: "{}" }));
  const attempt = oauthAdapter("acme", broken, ORIGINS).exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).code).toBe("AUTH");
    expect((error as GatewayError).gatewayAuthored).toBe(true);
  });
});

test("usage is optional, and omitting it is not an error", async () => {
  const provider = oauthAdapter("acme", kiloShaped, ORIGINS);
  expect(provider.usage).toBeUndefined();

  const withUsage = oauthAdapter(
    "acme",
    {
      ...kiloShaped,
      async *usage(input) {
        const res = yield {
          url: "https://api.acme.test/usage",
          method: "GET",
          headers: [["authorization", `Bearer ${input.secrets.accessToken}`]],
        };
        return {
          windows: [
            {
              windowType: "fiveHour",
              used: Number(res.body),
              limit: 100,
              resetsAt: null,
              windowMs: null,
            },
          ],
        };
      },
    },
    ORIGINS,
  );
  const { deps } = transport(() => ({ status: 200, body: "87" }));
  const report = await withUsage.usage?.(secrets, deps, {});
  expect(report?.windows[0]?.used).toBe(87);
});

test("a step that returns nothing usable is refused, not handed on", async () => {
  // Yields were validated and returns were not. `connect.ts` reads
  // `result.expiresAt` and spreads `...result.secrets`, so a bare `return;`
  // produced a raw TypeError outside every guard here — `INTERNAL`, which is
  // not retryable, ending a request the pool could have served.
  for (const bad of [undefined, "not a FlowResult", {}, { secrets: {}, providerData: null }]) {
    const broken: PluginOAuthFlow = {
      ...kiloShaped,
      async *exchange() {
        yield { url: "https://api.acme.test/codes/x", method: "GET", headers: [] };
        return bad as never;
      },
    };
    const { deps } = transport(() => ({ status: 200, body: JSON.stringify({ token: "t" }) }));
    const attempt = oauthAdapter("acme", broken, ORIGINS).exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      deps,
    );
    await expect(attempt).rejects.toThrow(GatewayError);
    await attempt.catch((error: unknown) => {
      expect((error as GatewayError).message).toContain("cannot use");
    });
  }
});

test("a yielded request with an unusable method or url never reaches the transport", async () => {
  // `nodeHttpClient` throws ERR_INVALID_HTTP_TOKEN synchronously inside its
  // Promise executor, so this would escape classification carrying the
  // plugin's own text.
  for (const request of [
    { url: "https://api.acme.test/x", method: "GET junk", headers: [] },
    { url: "not a url", method: "GET", headers: [] },
    { url: "file:///etc/passwd", method: "GET", headers: [] },
  ]) {
    const broken: PluginOAuthFlow = {
      ...kiloShaped,
      async *exchange() {
        yield request as never;
        return {} as never;
      },
    };
    const { sent, deps } = transport(() => ({ status: 200, body: "{}" }));
    await expect(
      oauthAdapter("acme", broken, ORIGINS).exchange(
        { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
        deps,
      ),
    ).rejects.toThrow(GatewayError);
    expect(sent).toEqual([]);
  }
});

test("an abandoned step still runs its own cleanup", async () => {
  // A step stopped over the cap or outside its origins is left suspended, so a
  // `finally` in the plugin never runs unless the host returns into it.
  let cleaned = false;
  const looping: PluginOAuthFlow = {
    ...kiloShaped,
    async *exchange() {
      try {
        while (true) {
          yield { url: "https://api.acme.test/poll", method: "GET", headers: [] };
        }
      } finally {
        cleaned = true;
      }
    },
  };
  const { deps } = transport(() => ({ status: 200, body: "{}" }));
  await oauthAdapter("acme", looping, ORIGINS)
    .exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      deps,
    )
    .catch(() => {});

  // Awaited indirectly: `gen.return` resolves on a microtask.
  await Promise.resolve();
  expect(cleaned).toBe(true);
});
