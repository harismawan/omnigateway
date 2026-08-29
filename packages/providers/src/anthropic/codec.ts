import { CONTEXT_1M_BETA, CONTEXT_1M_TOKENS, GatewayError } from "@omni/ir";
import { applyAnthropicSystem, orderFields, signAnthropicBody } from "../body.ts";
import { catalogLimits } from "../catalog.ts";
import type { CodecErrorInput, CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { buildToolCloak, type ToolCloak } from "./cloak.ts";
import { decodeAnthropic, isFingerprintMessage } from "./decode.ts";
import { anthropicBodyOrder, anthropicProfile } from "./profile.ts";
import { toWire } from "./wire.ts";

const BASE_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * What this codec puts in `decodeState`, and the only thing that reads it back.
 *
 * `decodeState` is `unknown` to the host by design, so the narrowing has to
 * happen here. It is written as a guard rather than a cast because the host is
 * permitted to hand back exactly what `buildRequest` returned and nothing
 * enforces that at a type level — and a cast would turn a host bug into a
 * `TypeError` inside `decode`, which is the one place `guardStream` would
 * relabel as an upstream failure and fail over on.
 */
function cloakOf(state: unknown): ToolCloak | null {
  if (state === null || typeof state !== "object") return null;
  const cloak = (state as { cloak?: unknown }).cloak;
  if (cloak === null || cloak === undefined || typeof cloak !== "object") return null;
  // The two maps, checked rather than asserted. An earlier version stopped at
  // the null check and cast, while its docblock claimed a guard — so any
  // non-null wrong value did exactly what the comment said it avoided, and the
  // comment was the only thing anybody would have read.
  const { toWire, fromWire } = cloak as { toWire?: unknown; fromWire?: unknown };
  return toWire instanceof Map && fromWire instanceof Map ? (cloak as ToolCloak) : null;
}

/**
 * Anthropic as a codec.
 *
 * The third conversion, and the one that exercises every optional part of the
 * contract: `decodeState` carries the tool cloak, `cloakedTools` carries its
 * size, and `classifyError` names the fingerprint refusal. The other two
 * providers converted so far use none of them, so this is the first evidence
 * that those three exist in a usable shape rather than a plausible one — which
 * is why it was done before the contract is published rather than after.
 *
 * Nothing moved except the transport. `toWire`, `buildToolCloak`,
 * `applyAnthropicSystem`, `signAnthropicBody`, `anthropicProfile`,
 * `anthropicBodyOrder`, `catalogLimits` and `decodeAnthropic` are the adapter's,
 * unchanged, and `packages/providers/test/anthropicCodec.test.ts` pins the bytes
 * against literals captured from that adapter before it was replaced.
 */
export const anthropicCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const oauth = input.credentials.accessToken !== null;

    // Anthropic's first-party surface refuses some requests on the *names* of
    // the tools they carry, and answers with a billing placeholder that says
    // nothing about tools. The API-key surface does not do this, so only the
    // OAuth leg pays for the rename.
    //
    // Derived here, in this call frame, and deliberately never attached to the
    // request: `input.request` is one shared IR object across every attempt, so
    // a cloak stored on it would survive failover and leak aliases into a
    // non-Anthropic candidate — every other encoder reads the same `.name` — and
    // would corrupt RTK's classification and the token estimate, both of which
    // key on the real names. Rebuilding it per attempt from pristine IR is what
    // makes retries and failover idempotent, and it is also why the contract
    // requires `buildRequest` to be pure: the host may call it once per attempt.
    const cloak = oauth ? buildToolCloak(input.request) : null;
    const { body, degradations } = toWire(input.request, input.model, {
      oauth,
      cloak,
      autoCache: input.autoCacheEnabled === true,
    });

    // The billing block and the agent preamble go in as system blocks, and the
    // cch token is computed over the finished bytes, so this has to run before
    // serialization.
    //
    // The upstream leg always streams, whatever the client asked for: dispatch
    // collects events into a buffered body when the client wants one, so a
    // non-streaming request needs an event stream to collect. Asking for JSON
    // here and then parsing the reply as SSE yields no events at all.
    const withSystem: Record<string, unknown> = {
      ...body,
      system: applyAnthropicSystem(body.system ?? []),
      stream: true,
    };

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["anthropic-version", API_VERSION],
      // Constant, because the request above always streams.
      ["Accept", "text/event-stream"],
    ];

    // The client's own betas ride along: the fields they authorise are already
    // forwarded through `vendor`, and Anthropic rejects such a field outright
    // when the header does not name its beta.
    const betas = new Set(input.request.betas ?? []);

    // The 1M beta is a claim about the target, so the target decides. It is
    // dropped only where the catalog positively reports a smaller window: a
    // model the catalog does not list is an operator's own id, about which
    // nothing is known, and guessing "no" there would break a custom 1M target
    // that works today.
    const notes = [...degradations];
    if (betas.has(CONTEXT_1M_BETA)) {
      const limits = catalogLimits("anthropic", input.model, oauth ? "oauth" : "apiKey");
      const window = limits?.contextWindow;
      if (window !== undefined && window < CONTEXT_1M_TOKENS) {
        betas.delete(CONTEXT_1M_BETA);
        notes.push("anthropic:context-1m-dropped");
      }
    }

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${input.credentials.accessToken}`]);
      betas.add(OAUTH_BETA);
    } else if (input.credentials.apiKey !== null) {
      protocol.push(["x-api-key", input.credentials.apiKey]);
    } else {
      throw new GatewayError("AUTH", "anthropic credential has no token", {
        provider: "anthropic",
      });
    }

    if (betas.size > 0) protocol.push(["anthropic-beta", [...betas].join(",")]);

    const headers = orderHeaders(
      mergeHeaders(anthropicProfile.headers, protocol),
      anthropicProfile.order,
    );

    return {
      request: {
        url: BASE_URL,
        method: "POST",
        headers,
        // Order the fields, serialize, then swap the cch placeholder for a token
        // over those exact bytes. Substitution is length-preserving.
        body: signAnthropicBody(JSON.stringify(orderFields(withSystem, anthropicBodyOrder))),
      },
      decodeState: { cloak },
      degradations: notes,
      ...(cloak === null ? {} : { cloakedTools: cloak.toWire.size }),
    };
  },

  decode({ body, decodeState }) {
    return decodeAnthropic(parseSse(body), { cloak: cloakOf(decodeState) });
  },

  classifyError(input: CodecErrorInput): GatewayError | undefined {
    // `httpError` is shared by every provider and maps a 400 to `BAD_REQUEST`
    // before reading the body, which is where an `invalid_request_error` lands.
    // Naming the fingerprint refusal is Anthropic's business alone, so the
    // reclassification happens here rather than in the shared helper.
    //
    // The status is checked directly, not left to `fallback.code`: that same
    // helper maps 413 and 422 to `BAD_REQUEST` too, and can downgrade any status
    // to it on a `context_length_exceeded` body. The measured refusal is a 400.
    // `httpError` keeps no upstream `type`, so the status is what stands in for
    // the half the SSE route gets for free.
    if (input.status !== 400 || !isFingerprintMessage(input.fallback.message)) return undefined;

    // `fallback.message`, not `input.body`. The two differ: the host has already
    // pulled `error.message` out of the JSON and truncated it, and matching the
    // raw document instead would also match a body that merely quotes the phrase
    // somewhere other than the message.
    //
    // The degradations ride along because this is the one failure the record
    // exists to explain. An operator looking at a refusal blamed on tool names
    // asks first whether the cloak was running — and on the throw path there is
    // no result to carry the answer, so without this the row says only that the
    // request was refused.
    return new GatewayError("FINGERPRINT_REFUSED", input.fallback.message, {
      provider: "anthropic",
      degradations: input.degradations,
      ...(input.fallback.upstreamStatus === undefined
        ? {}
        : { status: input.fallback.upstreamStatus }),
      ...(input.fallback.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: input.fallback.retryAfterMs }),
    });
  },
};
