import { GatewayError, type ProviderId } from "@omni/ir";
import type { ProviderCodec } from "./codec.ts";
import { httpError } from "./http.ts";
import type { AdapterRequest, AdapterResult, Capabilities, ProviderAdapter } from "./types.ts";

/**
 * The error a codec's own failure becomes.
 *
 * `UPSTREAM` rather than `INTERNAL`, and that choice is the whole point.
 * `RETRYABLE.INTERNAL` is false, so a codec that threw would end the request
 * after one attempt with a 500 — while a pool with three other candidates sat
 * unused. A plugin's bug is not a reason to refuse a request the installation
 * can still serve, and rule 15 is explicit that a plugin failure is skipped and
 * reported rather than fatal.
 *
 * The provider is named because that is what makes it actionable: the operator
 * needs to know which plugin, and `provider` is the field the redaction gate
 * reads. The codec's own message is deliberately *not* carried — it is authored
 * outside this repository and `LogFields` is a closed allowlist, the same reason
 * a throwing channel handler is reported without its error body.
 */
function codecFailure(id: ProviderId, hook: string, what: string): GatewayError {
  // `UPSTREAM` is in `RETRYABLE`, which is what makes the failover happen; no
  // option needs to say so, and one that did would be a second source of truth.
  return new GatewayError("UPSTREAM", `${id} codec ${hook} ${what}`, { provider: id });
}

/**
 * What a codec may write into `request_logs.degradations`.
 *
 * Sixteen entries of sixty-four characters, which is far above what any shipped
 * adapter produces (`anthropic:oauth-system-prefix` is the longest at 29) and
 * far below what would matter in a row. Non-strings are dropped rather than
 * coerced: `String(someObject)` produces `[object Object]`, which is a value
 * that looks like data and explains nothing.
 */
function boundedDegradations(entries: readonly string[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, 16)
    .map((entry) => entry.slice(0, 64));
}

/** Runs one codec hook, turning anything it throws into a failover-able error. */
function guard<T>(id: ProviderId, hook: string, run: () => T): T {
  try {
    return run();
  } catch {
    throw codecFailure(id, hook, "threw");
  }
}

/**
 * Runs the request a codec describes, so a codec can be used wherever an
 * adapter is expected.
 *
 * This is the whole host side of the codec contract, and its length is the
 * argument for the contract: everything an adapter does beyond building a
 * request and reading a stream is here, once, rather than repeated in each
 * provider. Six copies of these twenty lines are what `send()` currently is.
 *
 * Dispatch keeps every decision it already owned — which credential, which
 * deadline, whether to retry, whether to fail over. Nothing in this file
 * decides anything; it performs.
 */
export function codecAdapter(
  id: ProviderId,
  capabilities: Capabilities,
  codec: ProviderCodec,
): ProviderAdapter {
  return {
    id,
    capabilities,
    async send(req: AdapterRequest): Promise<AdapterResult> {
      const built = guard(id, "buildRequest", () =>
        codec.buildRequest({
          request: req.request,
          model: req.model,
          credentials: req.credentials,
          ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
          ...(req.autoCache === undefined ? {} : { autoCacheEnabled: req.autoCache }),
        }),
      );
      if (
        typeof built?.request?.url !== "string" ||
        typeof built.request.method !== "string" ||
        typeof built.request.body !== "string" ||
        !Array.isArray(built.request.headers)
      ) {
        throw codecFailure(id, "buildRequest", "did not return a usable request");
      }

      // `provider` and `signal` are stamped here rather than taken from the
      // codec. The first is the host's own id for it — a codec naming a
      // different provider would put that name into `LogFields.provider` and
      // into the error a client sees. The second is dispatch's deadline; a
      // codec that supplied its own could outlive it.
      const res = await req.http({
        provider: id,
        url: built.request.url,
        method: built.request.method,
        headers: built.request.headers,
        body: built.request.body,
        signal: req.signal,
      });

      if (res.status < 200 || res.status >= 300) {
        // Read once. `httpError` also consumes the body, so a codec that wants
        // to inspect it has to be given the text rather than the response —
        // which is also why `classifyError` takes a string and cannot re-read
        // the stream or reach the socket.
        const text = await res.text().catch(() => "");
        const classified = guard(id, "classifyError", () =>
          codec.classifyError?.({
            status: res.status,
            body: text,
            headers: res.headers,
            // What the request gave up, so a refusal caused by exactly that can
            // say so. `dispatch` writes `error.degradations` into `request_logs`.
            degradations: built.degradations ?? [],
            decodeState: built.decodeState,
          }),
        );
        if (classified !== undefined) throw classified;
        // Built field by field, never `{ ...res }`. On a captured request the
        // response is `bodyCapture`'s wrapper, whose `body` is a *getter* that
        // tees the upstream stream and starts a capture drain — and object
        // spread reads getters. Spreading here invoked it on a response nothing
        // was going to read: the error body was recorded twice, `asBody()` could
        // no longer parse it as JSON, and an abandoned tee branch buffered the
        // whole body with `settle()` waiting on a drain that existed for no
        // reason. `httpError` never reads `body`, so `null` is the honest value.
        throw await httpError(
          { status: res.status, headers: res.headers, body: null, text: async () => text },
          id,
        );
      }

      const body = res.body;
      if (body === null) {
        throw new GatewayError("UPSTREAM", "empty response body", { provider: id });
      }

      return {
        events: guard(id, "decode", () =>
          codec.decode({
            body,
            decodeState: built.decodeState,
            headers: res.headers,
          }),
        ),
        // Bounded, because a codec is third-party code and these strings land
        // in `request_logs.degradations`. The field beside this one is a
        // *count* precisely because tool names are client free text and
        // `LogFields` is the redaction boundary — handing the same untrusted
        // source an unbounded string array into a stored column would be the
        // same mistake with a different shape. Caps rather than refusal: a
        // chatty codec loses detail, it does not lose its request.
        degradations: boundedDegradations(built.degradations),
        ...(built.cloakedTools === undefined ? {} : { cloakedTools: built.cloakedTools }),
      };
    },
  };
}
