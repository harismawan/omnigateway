import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { kiloAdapter } from "@omni/providers";
import { kiloOAuth } from "../../src/oauth/kilo.ts";
import { isAuthorizationPending } from "../../src/oauth/types.ts";

const NOW = 1_000_000;
const CODES_URL = "https://api.kilo.ai/api/device-auth/codes";
const PROFILE_URL = "https://api.kilo.ai/api/profile";

type Reply = { status: number; body: unknown } | Error;

/** Answers each call from a queue and records what was asked. */
function stubHttp(...replies: Reply[]): HttpClient & { sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  const client = (async (req: HttpRequest) => {
    sent.push(req);
    const reply = replies[sent.length - 1];
    if (reply === undefined) throw new Error(`unexpected request to ${req.url}`);
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify(reply.body),
    };
  }) as HttpClient & { sent: HttpRequest[] };
  client.sent = sent;
  return client;
}

const deps = (http: HttpClient) => ({ http, now: () => NOW });

function header(req: HttpRequest | undefined, name: string): string | undefined {
  return req?.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
}

/** A pending flow as `begin()` would have left it. */
function pendingFor(code: string, expiresAt: number | null) {
  return {
    verifier: "",
    challenge: "",
    state: "",
    redirectUri: "",
    deviceCode: code,
    interval: 3,
    ...(expiresAt === null ? {} : { extra: { expiresAt } }),
  };
}

const APPROVED = {
  status: 200,
  body: { status: "approved", token: "kilo-token-1", userEmail: "user@example.com" },
};

// --- Shape -------------------------------------------------------------------

test("is registered as a device flow that cannot be pasted", () => {
  expect(kiloOAuth.id).toBe("kilo");
  expect(kiloOAuth.kind).toBe("device");
  expect(kiloOAuth.supportsManualPaste).toBe(false);
  // Kilo identifies an editor, not a machine. Declaring `true` here would fail
  // every kilo connect with an internal error, since nothing mints an id.
  expect(kiloOAuth.needsDeviceId).toBe(false);
});

test("reports no usage surface at all rather than an empty one", () => {
  // Kilo sells prepaid credit, which is not a rolling window. An account with
  // no probe reads as unknown; one with a probe that always answers `null`
  // would read as observed-and-empty.
  expect(kiloOAuth.usage).toBeUndefined();
});

// --- begin -------------------------------------------------------------------

test("begin requests a device code and shows the operator the verification url", async () => {
  const http = stubHttp({
    status: 200,
    body: { code: "KILO-CODE-1", verificationUrl: "https://kilo.ai/device?c=1", expiresIn: 600 },
  });

  const started = await kiloOAuth.begin?.({ deviceId: "" }, deps(http));

  expect(started?.authorizeUrl).toBe("https://kilo.ai/device?c=1");
  // One value serves as both: the operator reads it, and the poll redeems it.
  expect(started?.userCode).toBe("KILO-CODE-1");
  expect(started?.pending.deviceCode).toBe("KILO-CODE-1");
  expect(started?.pending.interval).toBe(3);
  expect(started?.pending.extra?.expiresAt).toBe(NOW + 600_000);

  const sent = http.sent[0];
  expect(sent?.url).toBe(CODES_URL);
  expect(sent?.method).toBe("POST");
  expect(sent?.body).toBe("");
  expect(header(sent, "x-kilocode-editorname")).toBeDefined();
});

test("begin defaults the code lifetime to five minutes when kilo states none", async () => {
  const http = stubHttp({
    status: 200,
    body: { code: "KILO-CODE-1", verificationUrl: "https://kilo.ai/device" },
  });

  const started = await kiloOAuth.begin?.({ deviceId: "" }, deps(http));

  expect(started?.pending.extra?.expiresAt).toBe(NOW + 300_000);
});

test("begin says too many authorizations are pending rather than failing generically", async () => {
  const http = stubHttp({ status: 429, body: { error: "too_many_requests" } });

  const error = await kiloOAuth.begin?.({ deviceId: "" }, deps(http)).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("RATE_LIMIT");
  expect((error as GatewayError).message).toContain("pending");
});

test("begin refuses a response that carries no code", async () => {
  const http = stubHttp({ status: 200, body: { verificationUrl: "https://kilo.ai/device" } });

  await expect(kiloOAuth.begin?.({ deviceId: "" }, deps(http))).rejects.toThrow(
    "device code endpoint returned an unusable response",
  );
});

// --- exchange: still waiting -------------------------------------------------

test("a 202 poll is pending rather than a failure", async () => {
  const http = stubHttp({ status: 202, body: {} });

  const error = await kiloOAuth
    .exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) }, deps(http))
    .catch((e: unknown) => e);

  expect(isAuthorizationPending(error)).toBe(true);
  expect(http.sent[0]?.url).toBe(`${CODES_URL}/KILO-CODE-1`);
  expect(http.sent[0]?.method).toBe("GET");
  // The poll is what earns the token; there is nothing to authenticate it with.
  expect(header(http.sent[0], "authorization")).toBeUndefined();
});

test("a 200 that is not approved is still pending", async () => {
  const http = stubHttp({ status: 200, body: { status: "waiting" } });

  const error = await kiloOAuth
    .exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) }, deps(http))
    .catch((e: unknown) => e);

  expect(isAuthorizationPending(error)).toBe(true);
});

// --- exchange: terminal ------------------------------------------------------

test("a 403 poll is a refusal the operator made, and ends the flow", async () => {
  const http = stubHttp({ status: 403, body: {} });

  const error = await kiloOAuth
    .exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) }, deps(http))
    .catch((e: unknown) => e);

  expect(isAuthorizationPending(error)).toBe(false);
  expect((error as GatewayError).message).toContain("denied");
});

test("a 410 poll means the code expired, and ends the flow", async () => {
  const http = stubHttp({ status: 410, body: {} });

  const error = await kiloOAuth
    .exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) }, deps(http))
    .catch((e: unknown) => e);

  expect(isAuthorizationPending(error)).toBe(false);
  expect((error as GatewayError).message).toContain("expired");
});

test("a code past its stated lifetime is not polled at all", async () => {
  const http = stubHttp();

  const error = await kiloOAuth
    .exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW - 1) }, deps(http))
    .catch((e: unknown) => e);

  expect(isAuthorizationPending(error)).toBe(false);
  expect((error as GatewayError).message).toContain("expired");
  expect(http.sent).toHaveLength(0);
});

test("exchange refuses a flow that never went through begin", async () => {
  const http = stubHttp();

  await expect(
    kiloOAuth.exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      deps(http),
    ),
  ).rejects.toThrow("kilo exchange requires a pending flow produced by begin()");
  expect(http.sent).toHaveLength(0);
});

// --- exchange: approved ------------------------------------------------------

test("an approved poll yields a bare token with no refresh and no expiry", async () => {
  const http = stubHttp(APPROVED, { status: 200, body: { organizations: [] } });

  const result = await kiloOAuth.exchange(
    { code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) },
    deps(http),
  );

  expect(result.secrets.accessToken).toBe("kilo-token-1");
  // Kilo issues neither, and inventing either would have the scheduler chase a
  // refresh that can only fail.
  expect(result.secrets.refreshToken).toBeNull();
  expect(result.expiresAt).toBeNull();
  expect(result.accountEmail).toBe("user@example.com");
  expect(result.providerData.orgId).toBeUndefined();
});

test("the organization is read with the new token and frozen onto the credential", async () => {
  const http = stubHttp(APPROVED, {
    status: 200,
    body: { organizations: [{ id: "org-42" }, { id: "org-99" }] },
  });

  const result = await kiloOAuth.exchange(
    { code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) },
    deps(http),
  );

  expect(result.providerData.orgId).toBe("org-42");
  expect(http.sent[1]?.url).toBe(PROFILE_URL);
  expect(header(http.sent[1], "authorization")).toBe("Bearer kilo-token-1");
});

test("the frozen organization is what the adapter bills against", async () => {
  const connect = stubHttp(APPROVED, { status: 200, body: { organizations: [{ id: "org-42" }] } });
  const result = await kiloOAuth.exchange(
    { code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) },
    deps(connect),
  );

  const seen: HttpRequest[] = [];
  await kiloAdapter.send({
    request: {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: true,
    },
    model: "anthropic/claude-sonnet-5",
    credentials: {
      accessToken: result.secrets.accessToken,
      apiKey: null,
      providerData: result.providerData,
    },
    http: async (req: HttpRequest) => {
      seen.push(req);
      return {
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        text: async () => "",
      };
    },
    signal: new AbortController().signal,
  });

  expect(header(seen[0], "x-kilocode-organizationid")).toBe("org-42");
});

test("an account with no organization connects and sends no organization header", async () => {
  const http = stubHttp(APPROVED, { status: 200, body: { organizations: [] } });

  const result = await kiloOAuth.exchange(
    { code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) },
    deps(http),
  );

  expect(result.secrets.accessToken).toBe("kilo-token-1");
  expect(Object.keys(result.providerData)).not.toContain("orgId");
});

test("a failed profile read still completes the connect", async () => {
  // An operator who watched the browser say "approved" must not be told the
  // connect failed because a secondary read did.
  for (const failure of [
    { status: 500, body: { error: "boom" } },
    { status: 401, body: { error: "unauthorized" } },
    new Error("connection reset"),
  ] satisfies Reply[]) {
    const http = stubHttp(APPROVED, failure);

    const result = await kiloOAuth.exchange(
      { code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) },
      deps(http),
    );

    expect(result.secrets.accessToken).toBe("kilo-token-1");
    expect(result.providerData.orgId).toBeUndefined();
  }
});

test("an approved poll with no token is refused rather than stored empty", async () => {
  const http = stubHttp({ status: 200, body: { status: "approved", userEmail: "u@example.com" } });

  await expect(
    kiloOAuth.exchange({ code: "", pending: pendingFor("KILO-CODE-1", NOW + 300_000) }, deps(http)),
  ).rejects.toThrow("kilo approved the authorization without a token");
});

// --- refresh -----------------------------------------------------------------

test("refresh refuses: a kilo account is reconnected, not refreshed", async () => {
  const http = stubHttp();

  const error = await kiloOAuth.refresh("anything", deps(http), {}).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("AUTH");
  expect((error as GatewayError).message).toContain("reconnect");
  expect(http.sent).toHaveLength(0);
});
