import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpRequest, HttpResponse } from "@omni/providers";
import { OAUTH_PROVIDERS } from "../../src/oauth/index.ts";
import { oauthAdapter, type PluginOAuthFlow } from "../../src/oauth/pluginFlow.ts";
import {
  isAuthorizationPending,
  type OAuthDeps,
  type OAuthProvider,
} from "../../src/oauth/types.ts";
import { anthropicOAuth, grokOAuth, kiloOAuth, kimiOAuth, openaiOAuth } from "./builtins.ts";

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
  const provider = oauthAdapter("acme", kiloShaped, { origins: ORIGINS });

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
  const provider = oauthAdapter("acme", kiloShaped, { origins: ORIGINS });

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
  const provider = oauthAdapter("acme", kiloShaped, { origins: ORIGINS });
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
  const provider = oauthAdapter("acme", wandering, { origins: ORIGINS });

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
  const provider = oauthAdapter("acme", looping, { origins: ORIGINS });

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
  const attempt = oauthAdapter("acme", impostor, { origins: ORIGINS }).exchange(
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
  const attempt = oauthAdapter("acme", broken, { origins: ORIGINS }).exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    // `UPSTREAM`, not `AUTH`. `createRefresher` reads `AUTH` as "the provider
    // repudiated this refresh token" and disables the account; a plugin bug is
    // not that, and neither is a connection reset.
    expect((error as GatewayError).code).toBe("UPSTREAM");
    expect((error as GatewayError).gatewayAuthored).toBe(true);
  });
});

test("usage is optional, and omitting it is not an error", async () => {
  const provider = oauthAdapter("acme", kiloShaped, { origins: ORIGINS });
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
    { origins: ORIGINS },
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
    const attempt = oauthAdapter("acme", broken, { origins: ORIGINS }).exchange(
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
      oauthAdapter("acme", broken, { origins: ORIGINS }).exchange(
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
  await oauthAdapter("acme", looping, { origins: ORIGINS })
    .exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      deps,
    )
    .catch(() => {});

  // Awaited indirectly: `gen.return` resolves on a microtask.
  await Promise.resolve();
  expect(cleaned).toBe(true);
});

test("a transport failure is raised into the step, so a flow can tolerate one", async () => {
  // A flow can have a request whose failure is not the flow's failure: kilo
  // reads the billing organization with a token it has already earned, and an
  // operator whose browser said "approved" must not be told the connect failed
  // because a secondary read was reset.
  //
  // That tolerance is unwritable if the host throws *past* the generator — a
  // suspended generator's own `try` never sees a rejection raised outside it,
  // so the step is simply abandoned. Owned here rather than left to kilo's
  // suite, because it is a property of the contract and kilo is one caller.
  let caught: unknown = null;
  const tolerant: PluginOAuthFlow = {
    ...kiloShaped,
    async *exchange() {
      let org: string | null = null;
      try {
        yield { url: "https://api.acme.test/profile", method: "GET", headers: [] };
      } catch (error) {
        caught = error;
        org = null;
      }
      return {
        secrets: { accessToken: "kept", refreshToken: null, apiKey: null, idToken: null },
        expiresAt: null,
        accountEmail: null,
        providerData: { orgId: org },
      };
    },
  };

  const deps: OAuthDeps = {
    http: async () => {
      throw new Error("connection reset");
    },
    now: () => 1_000_000,
  };

  const result = await oauthAdapter("acme", tolerant, { origins: ORIGINS }).exchange(
    { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
    deps,
  );

  // The step saw it, and the flow completed with the credential it had earned.
  expect(caught).toBeInstanceOf(GatewayError);
  expect(result.secrets.accessToken).toBe("kept");
  expect(result.providerData).toEqual({ orgId: null });
});

test("a step that does not catch still fails, unchanged", async () => {
  // The other half. Raising into the generator must not turn a real transport
  // failure into a silent success for every flow that never asked to tolerate
  // one.
  const deps: OAuthDeps = {
    http: async () => {
      throw new Error("connection reset");
    },
    now: () => 1_000_000,
  };
  await expect(
    oauthAdapter("acme", kiloShaped, { origins: ORIGINS }).exchange(
      {
        code: "",
        pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "d" },
      },
      deps,
    ),
  ).rejects.toThrow(GatewayError);
});

test("a network failure during refresh does not disable the credential", async () => {
  // The boundary that matters, and the one nothing was watching. Every
  // host-built failure went out as `AUTH` for a commit, and `createRefresher`
  // reads `AUTH` as a repudiated refresh token — so a DNS blip disabled the
  // account. Across all five built-ins, because none of them catches its own
  // token call.
  //
  // Asserted against a **real built-in flow**, not a fixture: the fixture is
  // where this hid. `refresh.test.ts` pins the same property one layer up by
  // stubbing a provider that already returns `NETWORK`, so it could never see a
  // flow classifying its own transport failure.
  const deps: OAuthDeps = {
    http: async () => {
      throw new Error("connection reset");
    },
    now: () => 1_000_000,
  };

  // Four of the five. `kilo` is excluded because its refresh performs no
  // request and throws `AUTH` on purpose — its device flow cannot refresh at
  // all, so the credential genuinely does need reconnecting. That is the
  // contract working: a flow that means `AUTH` says so through its own `fail`,
  // and the host never says it on the flow's behalf.
  for (const provider of [anthropicOAuth, openaiOAuth, kimiOAuth, grokOAuth]) {
    const attempt = provider.refresh("a-refresh-token", deps, {});
    await attempt.catch((error: unknown) => {
      const code = error instanceof GatewayError ? error.code : "not-a-gateway-error";
      expect({ provider: provider.id, code }).toEqual({ provider: provider.id, code: "UPSTREAM" });
    });
    await expect(attempt).rejects.toThrow();
  }
});

test("a step that never yields is bounded by the wall clock, not only by the cap", async () => {
  // The cap bounds requests; this bounds time. A generator that never yields
  // and never returns reaches the cap never — and the test named for the cap
  // uses a *yielding* loop, so it pins the other shape entirely and its name
  // overstated what existed.
  const stuck: PluginOAuthFlow = {
    ...kiloShaped,
    async *exchange() {
      // Never yields and never returns, which is the shape the request cap
      // cannot see. Biome does not flag it because the `yield` below is
      // unreachable rather than absent — which is also why it has to be here.
      await new Promise(() => {});
      yield { url: "https://api.acme.test/never", method: "GET", headers: [] };
      throw new Error("unreachable");
    },
  };
  const { deps } = transport(() => ({ status: 200, body: "{}" }));

  // Raced against a short timer rather than waiting out the real deadline. This
  // asserts the step does not resolve on its own; the deadline's own value is
  // documented at its definition, and waiting 150s here would be the slowest
  // test in the suite by two orders of magnitude.
  const outcome = await Promise.race([
    oauthAdapter("acme", stuck, { origins: ORIGINS })
      .exchange(
        { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
        deps,
      )
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(outcome).toBe("pending");
});

test("a built-in oauth failure keeps the flag its log line reads", async () => {
  // The property `reasonField` consumes, asserted where it belongs. The
  // round-trip through the log line itself lives in `apps/gateway`, which is
  // the only layer allowed to import both.
  //
  // Before the ports a built-in flow's errors carried no provider, so the
  // reason printed. Routing them through the plugin-facing `fail` stamped
  // `provider` and left `gatewayAuthored` off, which turned both of
  // `reasonField`'s arms false and withheld the sentence.
  const builtIn: GatewayError = await kiloOAuth
    .refresh("token", { http: async () => ({}) as never, now: () => 0 }, {})
    .then(() => {
      throw new Error("kilo refresh resolved, but it has no refresh to perform");
    })
    .catch((error: unknown) => error as GatewayError);
  expect(builtIn.provider).toBe("kilo");
  expect(builtIn.gatewayAuthored).toBe(true);

  // A plugin's own text stays unattributed: it is unknown in exactly the way an
  // upstream body is.
  const pluginSide: PluginOAuthFlow = {
    ...kiloShaped,
    // biome-ignore lint/correctness/useYield: throwing before any request is the case
    async *refresh(input) {
      throw input.fail("UPSTREAM", "PROMPT LEAK");
    },
  };
  const { deps } = transport(() => ({ status: 200, body: "{}" }));
  const fromPlugin: GatewayError = await oauthAdapter("acme", pluginSide, { origins: ORIGINS })
    .refresh("token", deps, {})
    .then(() => {
      throw new Error("the plugin flow resolved, but it throws unconditionally");
    })
    .catch((error: unknown) => error as GatewayError);
  expect(fromPlugin.gatewayAuthored).toBe(false);
});

test("a body that cannot be read is a transport failure, not an empty response", async () => {
  // Every flow reads an empty 2xx as "no access_token" and raises `AUTH`, and
  // `createRefresher` disables the account on `AUTH`. So swallowing a failed
  // read into `""` turned a socket reset partway through a token response into
  // a disabled credential — where the unguarded read it replaced surfaced the
  // transient error it is.
  const flow: PluginOAuthFlow = {
    ...kiloShaped,
    async *refresh() {
      yield { url: "https://api.acme.test/token", method: "POST", headers: [], body: "{}" };
      throw new Error("unreachable: the read above fails");
    },
  };
  const deps: OAuthDeps = {
    http: async () => ({
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => {
        throw new Error("socket hang up");
      },
    }),
    now: () => 1_000_000,
  };

  const error: GatewayError = await oauthAdapter("acme", flow, { origins: ORIGINS })
    .refresh("token", deps, {})
    .then(() => {
      throw new Error("resolved despite an unreadable body");
    })
    .catch((raised: unknown) => raised as GatewayError);

  // Not `AUTH`: nothing about a failed read says the provider repudiated this
  // credential.
  expect(error.code).toBe("UPSTREAM");
});

/**
 * The two gaps the "test file unchanged is the proof" claim did not reach.
 *
 * Thirteen non-equivalent mutants survived the whole suite before these: all
 * seven usage-probe mutants (kimi and openai had no wired `usage` test at all,
 * so the probe could be pointed at the *token* endpoint and stay green), the
 * GET builder's `Accept` header, and every one of the four deadline mutants —
 * including the pair the design names as its headline finding.
 *
 * Walked from the registry rather than listed, so a sixth built-in is covered
 * the day it is added.
 */
type Sent = { url: string; method: string; headers: readonly (readonly string[])[] };

function recorder(): { sent: Sent[]; deps: OAuthDeps } {
  const sent: Sent[] = [];
  return {
    sent,
    deps: {
      http: async (req) => {
        sent.push({ url: req.url, method: req.method, headers: req.headers });
        return { status: 200, headers: new Headers(), body: null, text: async () => "{}" };
      },
      now: () => 1_000_000,
    },
  };
}

/**
 * Where this provider's `refresh` sends its token call.
 *
 * Read from the flow rather than from a table of literals, so the usage-probe
 * assertion above cannot drift from the endpoint it is protecting against.
 */
async function tokenUrlOf(provider: OAuthProvider): Promise<string | undefined> {
  const { sent, deps } = recorder();
  await provider.refresh("t", deps, {}).catch(() => {});
  return sent[0]?.url;
}

test("every usage probe reads a usage endpoint, authenticated, and gates on status", async () => {
  for (const [id, provider] of Object.entries(OAUTH_PROVIDERS)) {
    if (provider.usage === undefined) continue;

    const { sent, deps } = recorder();
    await provider.usage({ accessToken: "tok" }, deps, {});

    expect({ id, calls: sent.length }).toEqual({ id, calls: 1 });
    const call = sent[0];
    expect({ id, method: call?.method }).toEqual({ id, method: "GET" });

    // **The URL, which is the assertion that matters.** A probe pointed at the
    // *token* endpoint sends a bearer token to the credential-minting URL, and
    // that mutant survived the whole suite — including a first draft of this
    // test, which checked the method and the authorization header and never
    // where the request went.
    //
    // Compared against the flow's own token call rather than a literal, so this
    // stays true when a vendor moves an endpoint: what must never happen is the
    // two becoming the same.
    const tokenCall = await tokenUrlOf(provider);
    expect({ id, sameAsToken: call?.url === tokenCall }).toEqual({ id, sameAsToken: false });
    expect({
      id,
      authed: call?.headers.some(([k]) => k?.toLowerCase() === "authorization"),
    }).toEqual({ id, authed: true });
    // `Accept` is added by the shared GET builder and had no pin anywhere.
    expect({ id, accepts: call?.headers.some(([k]) => k?.toLowerCase() === "accept") }).toEqual({
      id,
      accepts: true,
    });
  }
});

test("a usage endpoint that refuses the read reports nothing rather than a verdict", async () => {
  // The status gate, which two providers dropped without a test noticing. A
  // probe reports; it never judges the credential.
  for (const [id, provider] of Object.entries(OAUTH_PROVIDERS)) {
    if (provider.usage === undefined) continue;
    const deps: OAuthDeps = {
      http: async () => ({
        status: 401,
        headers: new Headers(),
        body: null,
        text: async () => "{}",
      }),
      now: () => 1_000_000,
    };
    expect({
      id,
      report: await provider.usage({ accessToken: "t" }, deps, {}),
    }).toEqual({ id, report: null });
  }
});

test("a token call gets 30s and a usage probe gets 15s, as the design says", async () => {
  // The design's headline finding is that the built-ins use **two** deadlines
  // and one host constant would have quadrupled the shorter one silently. All
  // four deadline mutants survived the whole suite before this — nothing in the
  // repository read the signal, so the finding described a regression that
  // could be reintroduced silently in either direction.
  //
  // `AbortSignal.timeout(n)` does not expose `n`, so it is recorded at the
  // source and restored afterwards.
  const asked: number[] = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    asked.push(ms);
    return real.call(AbortSignal, ms);
  };

  try {
    const { deps } = recorder();
    const provider = OAUTH_PROVIDERS.anthropic;
    if (provider === undefined) throw new Error("anthropic is not installed");

    asked.length = 0;
    await provider.refresh("t", deps, {}).catch(() => {});
    expect(asked).toEqual([30_000]);

    asked.length = 0;
    await provider.usage?.({ accessToken: "t" }, deps, {});
    expect(asked).toEqual([15_000]);
  } finally {
    AbortSignal.timeout = real;
  }
});
