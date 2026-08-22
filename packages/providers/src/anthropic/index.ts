import { CONTEXT_1M_BETA, CONTEXT_1M_TOKENS, GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { applyAnthropicSystem, BODY_ORDER, orderFields, signAnthropicBody } from "../body.ts";
import { catalogLimits } from "../catalog.ts";
import { httpError } from "../http.ts";
import { mergeHeaders, orderHeaders, PROFILES } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { buildToolCloak } from "./cloak.ts";
import { decodeAnthropic, isFingerprintMessage } from "./decode.ts";
import { toWire } from "./wire.ts";

const BASE_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  capabilities: PROVIDER_CAPABILITIES.anthropic,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;

    // Anthropic's first-party surface refuses some requests on the *names* of
    // the tools they carry, and answers with a billing placeholder that says
    // nothing about tools. The API-key surface does not do this, so only the
    // OAuth leg pays for the rename.
    //
    // Derived here, in this call frame, and deliberately never attached to the
    // request: `dispatchRequest` is one shared IR object across every attempt,
    // so a cloak stored on it would survive failover and leak aliases into a
    // non-Anthropic candidate — every other encoder reads the same `.name` —
    // and would corrupt RTK's classification and the token estimate, both of
    // which key on the real names. Rebuilding it per attempt from pristine IR
    // is what makes retries and failover idempotent.
    const cloak = oauth ? buildToolCloak(req.request) : null;
    const { body, degradations } = toWire(req.request, req.model, { oauth, cloak });

    // The billing block and the agent preamble go in as system blocks, and
    // the cch token is computed over the finished bytes, so this has to run
    // before serialization.
    //
    // The upstream leg always streams, whatever the client asked for, as it
    // does for the other two providers: dispatch collects events into a
    // buffered body when the client wants one, so a non-streaming request
    // needs an event stream to collect. Asking for JSON here and then parsing
    // the reply as SSE yields no events at all. Streaming also keeps bytes
    // moving on a long generation instead of holding one response open, and
    // it is what the client this adapter mimics actually sends.
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
    const betas = new Set(req.request.betas ?? []);

    // The 1M beta is a claim about the target, so the target decides. It is
    // dropped only where the catalog positively reports a smaller window: a
    // model the catalog does not list is an operator's own id, about which
    // nothing is known, and guessing "no" there would break a custom 1M target
    // that works today.
    const notes = [...degradations];
    if (betas.has(CONTEXT_1M_BETA)) {
      const limits = catalogLimits("anthropic", req.model, oauth ? "oauth" : "apiKey");
      const window = limits?.contextWindow;
      if (window !== undefined && window < CONTEXT_1M_TOKENS) {
        betas.delete(CONTEXT_1M_BETA);
        notes.push("anthropic:context-1m-dropped");
      }
    }

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${req.credentials.accessToken}`]);
      betas.add(OAUTH_BETA);
    } else if (req.credentials.apiKey !== null) {
      protocol.push(["x-api-key", req.credentials.apiKey]);
    } else {
      throw new GatewayError("AUTH", "anthropic credential has no token", {
        provider: "anthropic",
      });
    }

    if (betas.size > 0) protocol.push(["anthropic-beta", [...betas].join(",")]);

    const profile = PROFILES.anthropic;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // Order the fields, serialize, then swap the cch placeholder for a token
    // over those exact bytes. Substitution is length-preserving.
    const bodyString = signAnthropicBody(
      JSON.stringify(orderFields(withSystem, BODY_ORDER.anthropic)),
    );

    const res = await req.http({
      provider: "anthropic",
      url: BASE_URL,
      method: "POST",
      headers,
      body: bodyString,
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) {
      const error = await httpError(res, "anthropic");
      // `httpError` is shared by every provider and maps a 400 to
      // `BAD_REQUEST` before reading the body, which is where an
      // `invalid_request_error` lands. Naming the fingerprint refusal is
      // Anthropic's business alone, so the reclassification happens here rather
      // than in the shared helper.
      //
      // The status is checked directly, not left to `error.code`: that same
      // helper maps 413 and 422 to `BAD_REQUEST` too, and can downgrade any
      // status to it on a `context_length_exceeded` body. The measured refusal
      // is a 400. `httpError` keeps no upstream `type`, so the status is what
      // stands in for the half the SSE route gets for free.
      if (res.status === 400 && isFingerprintMessage(error.message)) {
        // The degradations ride along because this is the one failure the
        // record exists to explain. An operator looking at a refusal blamed on
        // tool names asks first whether the cloak was running — and on the
        // throw path there is no `AdapterResult` to carry the answer, so
        // without this the row says only that the request was refused.
        throw new GatewayError("FINGERPRINT_REFUSED", error.message, {
          provider: "anthropic",
          degradations: notes,
          ...(error.upstreamStatus === undefined ? {} : { status: error.upstreamStatus }),
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        });
      }
      throw error;
    }
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "anthropic" });

    return {
      events: decodeAnthropic(parseSse(res.body), { cloak }),
      degradations: notes,
      ...(cloak === null ? {} : { cloakedTools: cloak.toWire.size }),
    };
  },
};

export { decodeAnthropic, toWire };
