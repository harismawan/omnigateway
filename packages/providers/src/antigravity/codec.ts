import { createHash } from "node:crypto";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeAntigravityStream } from "./decode.ts";
import { antigravityProfile } from "./profile.ts";
import { toAntigravityWire } from "./wire.ts";

/**
 * **Inference goes to `daily-cloudcode-pa`, not to `cloudcode-pa`, and the
 * difference is entitlement rather than failover.**
 *
 * Measured 2026-09-05 against a live free-tier account, byte-identical request
 * to each host: `daily-cloudcode-pa.googleapis.com` answered 200 with content,
 * `cloudcode-pa.googleapis.com` answered `429 RESOURCE_EXHAUSTED`. The account's
 * own quota RPC reported 0% of both windows used at the time and the Antigravity
 * IDE was generating normally, so the 429 was never about quota — plain
 * `cloudcode-pa` is Gemini Code Assist's surface and does not serve Antigravity's
 * models to this tier.
 *
 * A first version of this file used one host for everything and called the
 * others "failover omniroute rotates through". That was wrong in the way that
 * costs the most: every request failed, and the error the upstream chose to
 * return pointed at the account rather than at the URL. The bootstrap and quota
 * RPCs in `oauth.ts` genuinely do live on `cloudcode-pa` — they were verified
 * working there in the same session — so the split is real and each side is
 * pinned by its own test.
 *
 * The streaming endpoint is used even for a non-streaming client request: plain
 * `v1internal:generateContent` answers 400 on several models because Cloud Code
 * converts the call to an OpenAI-shaped one internally and injects
 * `stream_options` without setting `stream: true`. Dispatch already serves a
 * non-streaming client by collecting the stream.
 *
 * ponytail: one runtime host, no rotation. omniroute falls back to
 * `cloudcode-pa` and a sandbox host; add that if `daily-` is ever measured
 * unavailable, but note the fallback host is the one that refuses this tier.
 */
const URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

/** Domain separator, so this hash can never collide with another use of a request id. */
const REQUEST_NAMESPACE = "omni-antigravity-req";

/**
 * A UUID derived from a value, in the v4-looking shape Cloud Code's own client
 * sends.
 *
 * Derived rather than minted, because `buildRequest` must describe the same
 * request given the same input — the host may build once and send on more than
 * one attempt. When dispatch supplies a request id it is reused directly, so
 * this only covers the callers that have none.
 */
function derivedRequestId(seed: string): string {
  const h = createHash("sha256").update(`${REQUEST_NAMESPACE}:${seed}`).digest("hex");
  const variant = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * The account's Cloud Code project, minted during OAuth and frozen onto the
 * credential.
 *
 * Refused here rather than sent empty. Google answers a blank `project` with a
 * 400 whose text names nothing an operator could act on, so the failure is
 * raised with the one instruction that fixes it. `gatewayAuthored` is not
 * settable from a codec, so this reaches the log as a classified `AUTH` with the
 * message withheld unless debug is on — which is the correct trade: the code and
 * the credential id are what the operator needs to find the account.
 */
function projectOf(input: CodecInput): string {
  const stored = input.credentials.providerData.projectId;
  const project = typeof stored === "string" ? stored.trim() : "";
  if (project.length === 0) {
    throw input.fail(
      "AUTH",
      "antigravity credential has no Cloud Code project; reconnect the account",
    );
  }
  return project;
}

export const antigravityCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const accessToken = input.credentials.accessToken;
    if (accessToken === null || accessToken.length === 0) {
      // No API key arm: `v1internal` is the IDE's surface and authenticates with
      // a Google account. The catalog says `authTypes: ["oauth"]` for the same
      // reason, so a key credential should never reach here.
      throw input.fail("AUTH", "antigravity credential has no access token");
    }

    const project = projectOf(input);
    const requestId =
      input.requestId !== undefined && input.requestId.length > 0
        ? input.requestId
        : derivedRequestId(`${input.model}:${project}`);

    const { body, degradations } = toAntigravityWire(input.request, input.model, {
      project,
      requestId,
    });

    const protocol: HeaderPair[] = [["Authorization", `Bearer ${accessToken}`]];
    const headers = orderHeaders(
      mergeHeaders(antigravityProfile.headers, protocol),
      antigravityProfile.order,
    );

    return {
      request: {
        url: URL,
        method: "POST",
        headers,
        // `orderFields` is not used, and that is the point: the envelope's key
        // set is closed — Google refuses an unknown top-level name — so
        // `wire.ts` builds it literally, in `antigravityBodyOrder`'s order,
        // rather than assembling it from a table that would happily carry one
        // more key.
        body: JSON.stringify(body),
      },
      degradations,
    };
  },

  decode({ body }) {
    return decodeAntigravityStream(parseSse(body));
  },
};
