import { expect, test } from "bun:test";
import { getJsonRequest, getJsonUnauthenticatedRequest, kiloProfile } from "@omni/providers";
import type { FlowResult, OAuthProvider } from "../../src/oauth/types.ts";

/**
 * The GET builders, and the compile-time guard around them.
 *
 * These tested `getJson`/`getJsonUnauthenticated` until those were deleted: the
 * flows describe requests now and the host sends them, so nothing in production
 * called either. The **properties** did not stop mattering, so they moved here
 * rather than being deleted with the functions — and the builders had no golden
 * pin of their own, so dropping `Accept` from the shared GET passed the whole
 * suite.
 */

function headers(req: { headers: readonly (readonly string[])[] }, name: string): string[] {
  return req.headers
    .filter(([n]) => n?.toLowerCase() === name.toLowerCase())
    .map(([, v]) => v ?? "");
}

test("getJsonRequest authenticates the read and keeps the client identity", () => {
  const sent = getJsonRequest("https://api.kilo.ai/api/profile", kiloProfile, {
    accessToken: "kilo-token-1",
    extraHeaders: [["X-Kilocode-OrganizationID", "org-42"]],
  });

  expect(sent.method).toBe("GET");
  expect(headers(sent, "authorization")).toEqual(["Bearer kilo-token-1"]);
  expect(headers(sent, "accept")).toEqual(["application/json"]);
  expect(headers(sent, "x-kilocode-organizationid")).toEqual(["org-42"]);
  // The profile's own identity still travels: a probe that reads an account as
  // a different client than inference uses is a louder signal than either.
  expect(headers(sent, "x-kilocode-editorname")).not.toEqual([]);
});

test("getJsonUnauthenticatedRequest sends no Authorization at all, not an empty one", () => {
  const sent = getJsonUnauthenticatedRequest(
    "https://api.kilo.ai/api/device-auth/codes/KILO-1",
    kiloProfile,
  );

  // Absent, not `Bearer ` and not `Bearer null`: an empty bearer is a
  // credential claim rather than the absence of one, and upstream answers the
  // two differently.
  expect(headers(sent, "authorization")).toEqual([]);
  expect(headers(sent, "accept")).toEqual(["application/json"]);
  expect(headers(sent, "x-kilocode-editorname")).not.toEqual([]);
});

test("getJsonRequest will not compile without a credential", () => {
  // A `usage()` probe reads a nullable token off `UsageSecrets`. This is what
  // forces each one to say what it does about a credential that has none: drop
  // the guard and the probe would go out unauthenticated, read its own 401 as
  // "no usage data", and leave the account reading unknown forever with nothing
  // logged. `@ts-expect-error`, not a runtime assertion, because the whole
  // value of the guard is that it fires before the code ever runs.
  type Authenticated = Parameters<typeof getJsonRequest>[2];
  const withoutCredential: Authenticated = {
    // @ts-expect-error `accessToken` is `string`; use getJsonUnauthenticatedRequest.
    accessToken: null,
  };
  expect(withoutCredential.accessToken).toBeNull();
});

// --- The question a device flow has to answer --------------------------------

const RESULT: FlowResult = {
  secrets: { accessToken: "t", refreshToken: null, apiKey: null, idToken: null },
  expiresAt: null,
  accountEmail: null,
  providerData: {},
};

const START = {
  authorizeUrl: "https://example.test/device",
  pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
};

test("a device provider will not compile without saying whether it needs a device id", () => {
  // The whole point of moving the enforcement back into `deviceIdFrom`: a new
  // device flow has to state the fact the shared check reads, at the point of
  // writing, rather than inheriting a default that reads as an oversight.
  // Making `needsDeviceId` optional makes this directive unused, which
  // `bun run typecheck` reports as an error.
  // @ts-expect-error `needsDeviceId` is required on the device variant.
  const undeclared: OAuthProvider = {
    id: "kilo",
    kind: "device",
    supportsManualPaste: false,
    start: () => START,
    begin: async () => START,
    exchange: async () => RESULT,
    refresh: async () => RESULT,
  };
  expect(undeclared.kind).toBe("device");
});

test("a pkce provider is never asked the device question", () => {
  // The counterweight to the churn: `needsDeviceId` lives on the device variant
  // alone, so the three redirect flows do not answer a question about a device
  // identity they cannot have. Declaring one is a compile error, not a field
  // that quietly does nothing.
  const redirect: OAuthProvider = {
    id: "grok",
    kind: "pkce",
    supportsManualPaste: true,
    start: () => START,
    exchange: async () => RESULT,
    refresh: async () => RESULT,
    // @ts-expect-error a redirect flow has no device identity to need.
    needsDeviceId: false,
  };
  expect(redirect.kind).toBe("pkce");
});
