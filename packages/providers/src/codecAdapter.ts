import { GatewayError, type ProviderId } from "@omni/ir";
import type { ProviderCodec } from "./codec.ts";
import { httpError } from "./http.ts";
import type { AdapterRequest, AdapterResult, Capabilities, ProviderAdapter } from "./types.ts";

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
      const built = codec.buildRequest({
        request: req.request,
        model: req.model,
        credentials: req.credentials,
        ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
        ...(req.autoCache === undefined ? {} : { autoCacheEnabled: req.autoCache }),
      });

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
        const classified = codec.classifyError?.({
          status: res.status,
          body: text,
          headers: res.headers,
        });
        if (classified !== undefined) throw classified;
        throw await httpError({ ...res, text: async () => text }, id);
      }

      if (res.body === null) {
        throw new GatewayError("UPSTREAM", "empty response body", { provider: id });
      }

      return {
        events: codec.decode({
          body: res.body,
          decodeState: built.decodeState,
          headers: res.headers,
        }),
        degradations: [...(built.degradations ?? [])],
        ...(built.cloakedTools === undefined ? {} : { cloakedTools: built.cloakedTools }),
      };
    },
  };
}
