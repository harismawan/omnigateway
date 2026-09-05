/**
 * Muse's device flow and the key mint that follows it.
 *
 * The mint is what makes this suite unlike the other four device tests: a
 * successful `exchange` or `refresh` is **two** requests, and the credential it
 * returns carries secrets from both. Most of what can go wrong here is a
 * crossing of the two — the token used where the key belongs, the key's
 * failures read as the token's — so the stub sequences responses rather than
 * answering every call the same way.
 */

import { expect, test } from "bun:test";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { isAuthorizationPending } from "../../src/oauth/types.ts";
import { museOAuth } from "./builtins.ts";

const NOW = 1_000_000;
const CLIENT_ID = "1031625952748946";
const PENDING = { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc-1" };

type Reply = { status: number; body: unknown };

/**
 * Answers each call from the queue in turn, recording every request.
 *
 * Running out is a thrown error rather than a repeat of the last reply: a flow
 * that made an unexpected third call would otherwise be handed a valid mint
 * response and pass.
 */
function sequence(...replies: Reply[]): HttpClient & { seen: () => HttpRequest[] } {
  const seen: HttpRequest[] = [];
  let i = 0;
  const client = (async (req: HttpRequest) => {
    seen.push(req);
    const reply = replies[i++];
    if (reply === undefined) throw new Error(`unexpected request ${i} to ${req.url}`);
    return {
      status: reply.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify(reply.body),
    };
  }) as HttpClient & { seen: () => HttpRequest[] };
  client.seen = () => seen;
  return client;
}

const TOKEN: Reply = {
  status: 200,
  body: { access_token: "oauth-tok", refresh_token: "oauth-refresh", expires_in: 3600 },
};
/**
 * Shaped on a live `muse-code/key` response, with the identifying values
 * replaced. The field set is the real one — fifteen fields, `base_url` among
 * them — rather than the twelve the binary's serde metadata named.
 */
const MINTED: Reply = {
  status: 200,
  body: {
    api_key: "meta-key",
    base_url: "https://api.meta.ai/v1",
    user_email: "dev@example.com",
    user_full_name: "A Developer",
    is_subs_active: true,
    subs_tier_id: "tier-2",
    subs_tier_name: "Muse Pro",
    is_subs_upgrade_available: false,
    has_payment_method: true,
    require_payment: false,
    can_subscribe: false,
    show_subs_upsell: false,
    payment_method: null,
    action_url: "https://dev.meta.ai/billing/",
    subs_usage: {
      window: { used_percent: 40, resets_at: 1_700_000_600, window_duration_mins: 300 },
      weekly: { used_percent: 9, resets_at: 1_700_086_400 },
    },
  },
};

test("is registered as a device flow that cannot be pasted and mints no fingerprint", () => {
  expect(museOAuth.kind).toBe("device");
  expect(museOAuth.supportsManualPaste).toBe(false);
  // The launcher sends `client_id` and nothing else on any leg. Declaring
  // `true` would have `connect.ts` demand an identity no request carries.
  expect(museOAuth.needsDeviceId).toBe(false);
});

test("begin asks auth.meta.com for a device code and surfaces the user code", async () => {
  const http = sequence({
    status: 200,
    body: {
      device_code: "dc-1",
      user_code: "WDJB-MJHT",
      verification_uri: "https://auth.meta.com/device",
      verification_uri_complete: "https://auth.meta.com/device?code=WDJB-MJHT",
      interval: 5,
    },
  });
  const started = await museOAuth.begin?.({ deviceId: "" }, { http, now: () => NOW });

  expect(started?.userCode).toBe("WDJB-MJHT");
  // The complete uri wins: it embeds the code, so the operator approves in one
  // click instead of retyping it.
  expect(started?.authorizeUrl).toBe("https://auth.meta.com/device?code=WDJB-MJHT");
  expect(started?.pending.deviceCode).toBe("dc-1");
  expect(started?.pending.interval).toBe(5);

  const [req] = http.seen();
  expect(req?.url).toBe("https://auth.meta.com/oidc/device/authorization/");
  expect(req?.body).toBe(`client_id=${CLIENT_ID}`);
  expect(req?.headers).toContainEqual(["Content-Type", "application/x-www-form-urlencoded"]);
  // JSON, not the profile's `text/event-stream`. Asking for SSE from an
  // endpoint that answers JSON is a lie upstream is entitled to act on.
  expect(req?.headers).toContainEqual(["Accept", "application/json"]);
  expect(req?.headers).toContainEqual(["x-api-version", "1.0.0"]);
});

test("a device code with no interval falls back rather than polling flat out", async () => {
  const http = sequence({
    status: 200,
    body: { device_code: "dc-1", user_code: "WDJB-MJHT" },
  });
  const started = await museOAuth.begin?.({ deviceId: "" }, { http, now: () => NOW });

  expect(started?.pending.interval).toBe(5);
});

test("approval buys a token, and the token buys the key", async () => {
  const http = sequence(TOKEN, MINTED);
  const result = await museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW });

  const [token, mint] = http.seen();
  expect(token?.url).toBe("https://auth.meta.com/oidc/device/token/");
  expect(token?.body).toBe(
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc-1&client_id=${CLIENT_ID}`,
  );
  expect(mint?.url).toBe("https://api.meta.ai/muse-code/key");
  // The mint is the one call the OAuth token is for.
  expect(mint?.headers).toContainEqual(["Authorization", "Bearer oauth-tok"]);

  // All three secrets, which is the shape the codec and the refresher rely on:
  // the key for every request, the pair for renewing it.
  expect(result.secrets.accessToken).toBe("oauth-tok");
  expect(result.secrets.refreshToken).toBe("oauth-refresh");
  expect(result.secrets.apiKey).toBe("meta-key");
  expect(result.accountEmail).toBe("dev@example.com");
  expect(result.providerData.subscriptionTier).toBe("Muse Pro");
  expect(result.providerData.subscriptionActive).toBe(true);
  // The mint states where inference goes, and the client follows it.
  expect(result.providerData.baseUrl).toBe("https://api.meta.ai/v1");
  // The OAuth token's expiry, not the key's, which Meta states nowhere. Every
  // refresh re-mints, so the key is replaced at least as often as this.
  expect(result.expiresAt).toBe(NOW + 3_600_000);
});

test("authorization_pending is a distinguishable error, and no mint is attempted", async () => {
  const http = sequence({ status: 400, body: { error: "authorization_pending" } });
  try {
    await museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW });
    throw new Error("expected throw");
  } catch (error) {
    expect(isAuthorizationPending(error)).toBe(true);
  }
  // One request, not two: a flow that minted on an unapproved token would spend
  // a poll interval on a call that cannot succeed.
  expect(http.seen()).toHaveLength(1);
});

test("slow_down is pending too, rather than a failure the operator sees", async () => {
  const http = sequence({ status: 400, body: { error: "slow_down" } });
  try {
    await museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW });
    throw new Error("expected throw");
  } catch (error) {
    expect(isAuthorizationPending(error)).toBe(true);
  }
});

test("an expired device code says so, and says what to do", async () => {
  const http = sequence({ status: 400, body: { error: "expired_token" } });

  // Not pending: polling a dead code forever is the failure this separates out.
  await expect(
    museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW }),
  ).rejects.toMatchObject({
    code: "AUTH",
    message: "muse device code expired; start the authorization again",
  });
});

test("exchange without a pending flow is a gateway bug, and is classified as one", async () => {
  const http = sequence();

  await expect(
    museOAuth.exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      { http, now: () => NOW },
    ),
  ).rejects.toMatchObject({ code: "INTERNAL" });
  expect(http.seen()).toHaveLength(0);
});

test("an account with no payment method is refused with the step the operator must take", async () => {
  // `AUTH` disables the credential, which is right: no amount of retrying adds
  // a payment method, and an enabled account with none fails every routed
  // request instead of being visibly parked.
  const http = sequence(TOKEN, { status: 200, body: { require_payment: true, api_key: "unused" } });

  await expect(
    museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW }),
  ).rejects.toMatchObject({
    code: "AUTH",
    message:
      "muse requires a payment method on the Meta account; add one at https://dev.meta.ai and reconnect",
  });
});

test("a 200 carrying no key is refused rather than stored as a working credential", async () => {
  // What an account that has not finished Model API onboarding gets. Storing it
  // would produce a credential the router happily selects and the codec then
  // refuses on every request.
  const http = sequence(TOKEN, { status: 200, body: { api_key: "" } });

  await expect(
    museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW }),
  ).rejects.toMatchObject({
    code: "AUTH",
    message:
      "muse key mint returned an empty api key; finish onboarding at https://dev.meta.ai and reconnect",
  });
});

test("a rejected saved login is AUTH; a bad minute upstream is not", async () => {
  // `createRefresher` disables a credential on `AUTH` alone, so a 500 from the
  // mint must not be classified as one — that would permanently disable healthy
  // accounts during an outage.
  await expect(
    museOAuth.exchange(
      { code: "", pending: PENDING },
      { http: sequence(TOKEN, { status: 401, body: {} }), now: () => NOW },
    ),
  ).rejects.toMatchObject({ code: "AUTH" });

  await expect(
    museOAuth.exchange(
      { code: "", pending: PENDING },
      { http: sequence(TOKEN, { status: 503, body: {} }), now: () => NOW },
    ),
  ).rejects.toMatchObject({ code: "UPSTREAM" });

  await expect(
    museOAuth.exchange(
      { code: "", pending: PENDING },
      { http: sequence(TOKEN, { status: 429, body: {} }), now: () => NOW },
    ),
  ).rejects.toMatchObject({ code: "RATE_LIMIT" });
});

test("refresh renews the token and mints a fresh key", async () => {
  const http = sequence(
    { status: 200, body: { access_token: "tok-2", refresh_token: "refresh-2", expires_in: 60 } },
    { status: 200, body: { api_key: "key-2", is_subs_active: true } },
  );
  const result = await museOAuth.refresh("refresh-1", { http, now: () => NOW }, {});

  const [token, mint] = http.seen();
  expect(token?.body).toBe(
    `grant_type=refresh_token&refresh_token=refresh-1&client_id=${CLIENT_ID}`,
  );
  // The *new* token mints the new key. Minting with the old one would refresh
  // the pair and leave the credential authenticating with a stale key.
  expect(mint?.headers).toContainEqual(["Authorization", "Bearer tok-2"]);
  expect(result.secrets.accessToken).toBe("tok-2");
  expect(result.secrets.refreshToken).toBe("refresh-2");
  expect(result.secrets.apiKey).toBe("key-2");
});

test("a refresh response that omits refresh_token keeps the one it was given", async () => {
  // Reading the omission as null would destroy a working credential on its
  // first refresh and force the operator to reconnect by hand.
  const http = sequence(
    { status: 200, body: { access_token: "tok-2", expires_in: 60 } },
    { status: 200, body: { api_key: "key-2" } },
  );
  const result = await museOAuth.refresh("refresh-1", { http, now: () => NOW }, {});

  expect(result.secrets.refreshToken).toBe("refresh-1");
});

test("a token response with a blank access token never reaches the mint", async () => {
  const http = sequence({ status: 200, body: { access_token: "" } });

  await expect(
    museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW }),
  ).rejects.toThrow("token endpoint returned no access_token");
  expect(http.seen()).toHaveLength(1);
});

test("the mint is sent an empty object, never an empty body", async () => {
  // Measured against the live endpoint: `""` is refused with 400 "Request body
  // is required but was empty or null" and mints nothing, so a credential could
  // never be created at all. The contents are ignored; the syntax is not.
  const http = sequence(TOKEN, MINTED);
  await museOAuth.exchange({ code: "", pending: PENDING }, { http, now: () => NOW });

  const mint = http.seen()[1];
  expect(mint?.body).toBe("{}");
  expect(mint?.headers).toContainEqual(["Content-Type", "application/json"]);
});

test("a base url outside meta.ai is refused, and the codec's constant stands", async () => {
  // This value decides where a decrypted key is sent, so a response cannot
  // redirect it. `.meta.ai` with the dot, so `evilmeta.ai` is refused too.
  for (const base of [
    "https://evilmeta.ai/v1",
    "https://api.meta.ai.attacker.example/v1",
    "http://api.meta.ai/v1",
    "not a url",
  ]) {
    const http = sequence(TOKEN, {
      status: 200,
      body: { api_key: "meta-key", base_url: base },
    });
    const result = await museOAuth.exchange(
      { code: "", pending: PENDING },
      { http, now: () => NOW },
    );
    // Absent rather than stored-and-ignored: the codec falls back on absence,
    // and a rejected value left in `providerData` is one a later reader trusts.
    expect({ base, stored: result.providerData.baseUrl }).toEqual({ base, stored: undefined });
  }
});

test("the usage probe reads both windows off a fresh mint", async () => {
  const http = sequence(MINTED);
  const report = await museOAuth.usage?.(
    { accessToken: "oauth-tok" },
    { http, now: () => NOW },
    {},
  );

  expect(report?.windows.map((w) => [w.windowType, w.used, w.limit])).toEqual([
    ["fiveHour", 40, 100],
    ["weekly", 9, 100],
  ]);
  // Stated by the payload, not inferred from the window's name.
  expect(report?.windows[0]?.windowMs).toBe(300 * 60_000);

  const [call] = http.seen();
  expect(call?.url).toBe("https://api.meta.ai/muse-code/key");
  expect(call?.body).toBe("{}");
});

test("a pay-as-you-go account reports unknown quota rather than an empty one", async () => {
  // The live shape for an account with no subscription: fourteen fields and no
  // `subs_usage` at all. Reporting zeros would have the console draw a full
  // allowance nobody has.
  const http = sequence({
    status: 200,
    body: { api_key: "meta-key", is_subs_active: false, require_payment: false },
  });
  const report = await museOAuth.usage?.(
    { accessToken: "oauth-tok" },
    { http, now: () => NOW },
    {},
  );

  expect(report).toBe(null);
});

test("the usage probe never judges the credential it reads", async () => {
  // A probe reports; `require_payment` is `exchange`'s verdict to make, not
  // this one's. Throwing AUTH from here would disable an account over a quota
  // read, and the poller runs unattended.
  const http = sequence({ status: 200, body: { require_payment: true } });

  expect(await museOAuth.usage?.({ accessToken: "oauth-tok" }, { http, now: () => NOW }, {})).toBe(
    null,
  );
});
