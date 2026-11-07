import { randomBytes } from "node:crypto";
import {
  type AuthHelpers,
  type AuthResponse,
  type AuthStep,
  type DevicePluginFlow,
  type FlowResult,
  tokenErrorCode,
} from "../oauthFlow.ts";
import {
  getJsonRequest,
  getJsonUnauthenticatedRequest,
  postJsonRequest,
} from "../oauthRequests.ts";
import type { QoderCredentialBundle } from "./credential.ts";
import { encryptAuth, signAnonymous, signAuth } from "./crypto.ts";
import { syntheticUuid } from "./device.ts";
import { trustedInferenceOrigin } from "./endpoint.ts";
import { parseModelCatalog, publicModelCatalog, type QoderModel } from "./modelCatalog.ts";
import { QODER_VERSION, qoderProfile } from "./profile.ts";
import { decodeServerJson } from "./protocol.ts";

const OPENAPI = "https://openapi.qoder.sh";
const CENTER = "https://center.qoder.sh";
/** Secondary reads must not turn transient timeouts into permanent token rejection. */
function secondaryErrorCode(status: number): ReturnType<typeof tokenErrorCode> {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408) return "TIMEOUT";
  return "UPSTREAM";
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: prevent upstream values becoming header injection
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
}
function json(body: string, input: AuthHelpers): Record<string, unknown> {
  try {
    return record(decodeServerJson(body));
  } catch {
    throw input.fail("UPSTREAM", "Invalid Qoder response");
  }
}
function expires(token: Record<string, unknown>, now: number): number | null {
  const absolute = token.expires_at;
  if (typeof absolute === "string") {
    const n = Date.parse(absolute);
    if (Number.isFinite(n)) return n;
  }
  if (typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0)
    return absolute > 1e12 ? absolute : absolute * 1000;
  return typeof token.expires_in === "number" &&
    Number.isFinite(token.expires_in) &&
    token.expires_in > 0
    ? now + token.expires_in * 1000
    : null;
}
async function* read(
  url: string,
  accessToken: string | null,
  input: AuthHelpers,
): AuthStep<Record<string, unknown>> {
  const res = yield accessToken === null
    ? getJsonUnauthenticatedRequest(url, qoderProfile)
    : getJsonRequest(url, qoderProfile, { accessToken });
  if (res.status < 200 || res.status >= 300)
    throw input.fail(secondaryErrorCode(res.status), "Qoder account request failed", {
      status: res.status,
    });
  return json(res.body, input);
}
async function* discover(
  token: string,
  uid: string,
  machineId: string,
  input: AuthHelpers,
): AuthStep<string> {
  let res = yield getJsonRequest(`${CENTER}/algo/api/v5/service/region/endpoints`, qoderProfile, {
    accessToken: token,
    extraHeaders: [
      ["x-gw-user-id", uid],
      ["Cosy-MachineId", machineId],
      ["Cosy-MachineToken", machineId],
    ],
  });
  let v3 = false;
  if (res.status === 401 || res.status === 403) {
    v3 = true;
    const date = new Date(input.now()).toUTCString();
    res = yield getJsonUnauthenticatedRequest(
      `${CENTER}/algo/api/v3/service/region/endpoints`,
      qoderProfile,
      [
        ["Appcode", "cosy"],
        ["Date", date],
        ["Signature", signAnonymous(date)],
        ["Cosy-MachineId", machineId],
      ],
    );
  }
  if (res.status < 200 || res.status >= 300)
    throw input.fail(secondaryErrorCode(res.status), "Qoder endpoint discovery failed", {
      status: res.status,
    });
  const nodes = json(res.body, input).inferNodes;
  if (Array.isArray(nodes))
    for (const node of nodes) {
      const origin = trustedInferenceOrigin(v3 ? node : record(node).url);
      if (origin) return origin;
    }
  throw input.fail("UPSTREAM", "Qoder returned no trusted inference endpoint");
}
async function* finish(
  token: Record<string, unknown>,
  machineId: string,
  input: AuthHelpers,
  previous: Record<string, unknown>,
): AuthStep<FlowResult> {
  const access = text(token.token) ?? text(token.device_token);
  if (!access) throw input.fail("UPSTREAM", "Qoder returned no device token");
  const user = yield* read(`${OPENAPI}/api/v1/userinfo`, access, input);
  const userId = text(user.id) ?? text(user.user_id) ?? text(user.uid);
  const uid = text(token.user_id) ?? userId;
  if (!uid || !userId || userId !== uid)
    throw input.fail("UPSTREAM", "Invalid Qoder account identity");
  const authUser: Record<string, unknown> = {
    uid,
    security_oauth_token: access,
    data_policy_agreed: false,
  };
  const org = record(user.organization);
  const organizationId =
    text(user.orgId) ??
    text(user.organization_id) ??
    text(user.organizationId) ??
    text(org.org_id) ??
    text(org.id);
  if (organizationId) authUser.organization_id = organizationId;
  const envelope = encryptAuth(JSON.stringify(authUser), randomBytes(8).toString("hex"));
  let origin: string;
  try {
    origin = yield* discover(access, uid, machineId, input);
  } catch (error) {
    const code = record(error).code;
    const lastGood = trustedInferenceOrigin(previous.inferenceOrigin);
    if (!lastGood || (code !== "UPSTREAM" && code !== "TIMEOUT" && code !== "RATE_LIMIT"))
      throw error;
    origin = lastGood;
  }
  const authBase64 = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: syntheticUuid(input.randomState()),
      info: envelope.encryptUserInfo,
      cosyVersion: QODER_VERSION,
      ideVersion: "",
    }),
  ).toString("base64");
  const date = String(Math.floor(input.now() / 1000));
  const path = "/api/v2/model/list";
  let response: AuthResponse;
  try {
    response = yield getJsonUnauthenticatedRequest(`${origin}/algo${path}?Encode=1`, qoderProfile, [
      [
        "Authorization",
        `Bearer COSY.${authBase64}.${signAuth({ authBase64, key: envelope.key, date, body: "", path })}`,
      ],
      ["Cosy-Key", envelope.key],
      ["Cosy-Date", date],
      ["Cosy-User", uid],
      ["Cosy-MachineId", machineId],
      ["Cosy-MachineToken", machineId],
      ["Cosy-Version", QODER_VERSION],
      ["Cosy-ClientType", "5"],
      ["Cosy-Scene", "assistant"],
      ["Login-Version", "v2"],
    ]);
  } catch (error) {
    const code = record(error).code;
    if (code !== "UPSTREAM" && code !== "TIMEOUT" && code !== "RATE_LIMIT") throw error;
    response = { status: 503, headers: new Headers(), body: "" };
  }
  const unavailable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!unavailable && (response.status < 200 || response.status >= 300))
    throw input.fail(secondaryErrorCode(response.status), "Qoder model listing failed", {
      status: response.status,
    });
  let models: QoderModel[];
  try {
    models = unavailable
      ? parseModelCatalog({
          assistant: Array.isArray(previous.inferenceModels) ? previous.inferenceModels : [],
        })
      : parseModelCatalog(decodeServerJson(response.body));
  } catch {
    throw input.fail("UPSTREAM", "Invalid Qoder model catalog");
  }
  const bundle: QoderCredentialBundle = {
    version: 1,
    deviceToken: access,
    uid,
    machineId,
    ...envelope,
    origin,
    models,
    issuedAt: input.now(),
  };
  return {
    secrets: {
      accessToken: JSON.stringify(bundle),
      refreshToken: text(token.refresh_token),
      apiKey: null,
      idToken: null,
    },
    expiresAt: expires(token, input.now()),
    accountEmail: text(user.email),
    providerData: {
      ...previous,
      machineId,
      uid,
      inferenceOrigin: origin,
      ...(unavailable
        ? { catalogStatus: "unavailable" }
        : { catalogStatus: "available", modelCatalog: publicModelCatalog(models) }),
      inferenceModels: models.map((m) => ({
        key: m.key,
        display_name: m.displayName,
        is_vl: m.images,
        is_reasoning: m.reasoning,
        max_input_tokens: m.maxInputTokens,
      })),
    },
  };
}

export const qoderOAuthFlow: DevicePluginFlow = {
  kind: "device",
  needsDeviceId: false,
  supportsManualPaste: false,
  // biome-ignore lint/correctness/useYield: start is local; begin prepares the actual authorization
  async *start() {
    return {
      authorizeUrl: "",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
    };
  },
  // biome-ignore lint/correctness/useYield: browser device URL needs no upstream request
  async *begin(input) {
    const pkce = input.pkce();
    const nonce = syntheticUuid(input.randomState());
    const machineId = text(input.providerData?.machineId) ?? syntheticUuid(input.randomState());
    const params = new URLSearchParams({
      challenge: pkce.challenge,
      challenge_method: "S256",
      nonce,
      machine_id: machineId,
      client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    });
    return {
      authorizeUrl: `https://qoder.com/device/selectAccounts?${params}`,
      pending: {
        ...pkce,
        state: nonce,
        redirectUri: "",
        interval: 1,
        extra: { machineId, deadline: input.now() + 300000 },
      },
    };
  },
  async *exchange(input) {
    const machineId = text(input.pending.extra?.machineId);
    const deadline = input.pending.extra?.deadline;
    if (!machineId || typeof deadline !== "number" || input.now() >= deadline)
      throw input.fail("AUTH", "Qoder authorization expired");
    const params = new URLSearchParams({
      nonce: input.pending.state,
      verifier: input.pending.verifier,
      challenge_method: "S256",
    });
    const res = yield getJsonUnauthenticatedRequest(
      `${OPENAPI}/api/v1/deviceToken/poll?${params}`,
      qoderProfile,
    );
    if (res.status === 404) throw input.keepPolling("http_404");
    if (res.status < 200 || res.status >= 300)
      throw input.fail(tokenErrorCode(res.status), "Qoder device authorization failed", {
        status: res.status,
      });
    return yield* finish(json(res.body, input), machineId, input, {});
  },
  async *refresh(input) {
    const machineId = text(input.providerData.machineId);
    if (!machineId) throw input.fail("AUTH", "Qoder device identity missing; reconnect required");
    const res = yield postJsonRequest(`${OPENAPI}/api/v1/deviceToken/refresh`, qoderProfile, {
      contentType: "application/json",
      body: JSON.stringify({ refresh_token: input.refreshToken, machine_id: machineId }),
    });
    if (res.status < 200 || res.status >= 300)
      throw input.fail(tokenErrorCode(res.status), "Qoder token refresh failed", {
        status: res.status,
      });
    return yield* finish(
      {
        ...json(res.body, input),
        refresh_token: text(json(res.body, input).refresh_token) ?? input.refreshToken,
      },
      machineId,
      input,
      input.providerData,
    );
  },
};
