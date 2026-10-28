import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { codexModel } from "./codexCatalog.ts";
import { codexSecretsFrom } from "./codexIdentity.ts";
import { decodeResponses } from "./decode.ts";
import { openaiBodyOrder, openaiProfile } from "./profile.ts";
import { toResponsesWire } from "./wire.ts";

const OAUTH_URL = "https://chatgpt.com/backend-api/codex/responses";
const API_URL = "https://api.openai.com/v1/responses";

const HEADER_SAFE = /^[\x21-\x7e]+$/;

/**
 * Codex's `x-codex-routing-hint`: the model, and the service tier when the
 * request names one (`model=<m>;tier=<t>`). Both reach a header, so a value
 * outside printable ASCII drops out rather than failing the write.
 */
function routingHint(model: string, tier: unknown): string | undefined {
  if (!HEADER_SAFE.test(model)) return undefined;
  if (typeof tier === "string" && HEADER_SAFE.test(tier) && !tier.includes(";")) {
    return `model=${model};tier=${tier}`;
  }
  return `model=${model}`;
}

/**
 * OpenAI as a codec.
 *
 * The request shape differs by credential type. An API key goes to
 * `api.openai.com` as a standard Responses request. An OAuth token goes to the
 * Codex backend presenting itself as Codex 0.165.0's interactive TUI: Codex's
 * headers in Codex's order, the responses-lite body, per-turn metadata, and a
 * zstd body — `docs/superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md`.
 * Both are pinned in `openaiCodec.test.ts` and `openaiCodexFingerprint.test.ts`.
 */
export const openaiCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const oauth = input.credentials.accessToken !== null;
    const accountId = input.credentials.providerData.accountId;
    // The per-credential installation id and id salt, minted by the OAuth flow.
    const secrets = oauth ? codexSecretsFrom(input.credentials.providerData) : {};
    const { body, degradations, cacheKey, codex } = toResponsesWire(input.request, input.model, {
      oauth,
      requestId: input.requestId,
      startedAt: input.requestStartedAt,
      accountId: typeof accountId === "string" ? accountId : undefined,
      installationId: secrets.installationId,
      idSalt: secrets.idSalt,
    });

    const protocol: HeaderPair[] = [];
    if (codex !== undefined) {
      protocol.push(
        ["x-codex-window-id", codex.windowId],
        ["x-codex-turn-metadata", codex.turnMetadata],
      );
      // `add_responses_lite_header`: only for a lite model.
      if (codexModel(input.model).lite) {
        protocol.push(["x-openai-internal-codex-responses-lite", "true"]);
      }
      const hint = routingHint(input.model, body.service_tier);
      if (hint !== undefined) protocol.push(["x-codex-routing-hint", hint]);
    }

    // The Codex backend routes its prompt cache by `session-id` alone, measured
    // live: with it stable, sends 2-4 read ~16.5k of ~16.7k tokens; with the body
    // field alone, or a stable `thread-id` under a changing `session-id`, zero.
    // `thread-id` and `x-client-request-id` are identity, not affinity; Codex
    // sends all three, equal to `prompt_cache_key`, on both hosts. Numbers:
    // client-identity spec History.
    protocol.push(
      ["x-client-request-id", cacheKey],
      ["session-id", cacheKey],
      ["thread-id", cacheKey],
    );
    if (oauth) protocol.push(["content-encoding", "zstd"]);
    protocol.push(["content-type", "application/json"]);

    if (oauth) {
      protocol.push(["authorization", `Bearer ${input.credentials.accessToken}`]);
      // Required by the Codex backend to select the billing account. Stored on
      // the credential at OAuth time.
      if (typeof accountId === "string") protocol.push(["chatgpt-account-id", accountId]);
      // Set here so it lands where hyper writes it, last before the length,
      // rather than wherever the transport would add its own.
      protocol.push(["host", "chatgpt.com"]);
    } else if (input.credentials.apiKey !== null) {
      protocol.push(["authorization", `Bearer ${input.credentials.apiKey}`]);
    } else {
      throw input.fail("AUTH", "openai credential has no token");
    }

    // The originator header and `accept: text/event-stream` come from the profile.
    const headers = orderHeaders(
      mergeHeaders(openaiProfile.headers, protocol),
      openaiProfile.order,
    );

    // What the **client** asked to get back, which decides whether reasoning
    // items are the client's to replay or a thinking block for it to read. Read
    // off the client's own bag, not the built body: the OAuth leg sends Codex's
    // `include` on every request, and reading that would turn every reasoning
    // item into an openai-native block, hide thinking from clients that never
    // asked, and pin every conversation to OpenAI from turn 2.
    const include = input.request.vendor?.openai?.include;
    const nativeReasoning =
      Array.isArray(include) && include.includes("reasoning.encrypted_content");

    return {
      decodeState: { nativeReasoning },
      request: {
        // The Codex endpoint only streams. Non-streaming client requests are
        // served by collecting the stream in dispatch, so always ask for SSE.
        url: oauth ? OAUTH_URL : API_URL,
        method: "POST",
        headers,
        // JSON here, compressed by the transport, so body capture records the
        // JSON. Codex compresses every request to its own backend.
        body: JSON.stringify(orderFields({ ...body, stream: true }, openaiBodyOrder)),
        ...(oauth ? { bodyEncoding: "zstd" as const } : {}),
      },
      degradations,
    };
  },

  decode({ body, decodeState }) {
    const state = decodeState as { nativeReasoning?: boolean } | undefined;
    return decodeResponses(parseSse(body), { nativeReasoning: state?.nativeReasoning === true });
  },
};
