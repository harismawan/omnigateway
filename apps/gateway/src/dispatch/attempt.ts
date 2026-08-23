import { GatewayError, type Logger, noopLogger, type StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import type { Candidate } from "@omni/router";
import type { CredentialSecrets, CredentialView } from "@omni/store";

export type AttemptResult = {
  events: AsyncGenerator<StreamEvent, void, undefined>;
  degradations: string[];
  /** Client tool names the adapter renamed on this attempt. A count, never the names. */
  cloakedTools?: number;
};

/**
 * Runs one candidate.
 *
 * Refreshes an OAuth token that is expired or within the lead window, then
 * hands the adapter its credentials. Throws before yielding if the upstream
 * rejects the request; the caller decides whether that is retryable.
 */
export async function attempt(opts: {
  candidate: Candidate;
  request: Parameters<ProviderAdapter["send"]>[0]["request"];
  adapter: ProviderAdapter;
  /** The order-preserving transport. Threaded through so tests can capture bytes. */
  http: HttpClient;
  now: number;
  signal: AbortSignal;
  refresh: (credential: CredentialView) => Promise<CredentialSecrets>;
  /** Refresh this far before actual expiry so a long request cannot expire mid-flight. */
  refreshLeadMs: number;
  /** Already-refreshed secrets for an AUTH retry; avoids a second refresh. */
  secrets?: CredentialSecrets;
  logger?: Logger;
  requestId?: string;
  /** Operator policy: may an adapter add a cache breakpoint the client omitted. */
  autoCache?: boolean;
}): Promise<AttemptResult> {
  const { candidate, adapter, http, now, signal, refresh, refreshLeadMs } = opts;
  const logger = opts.logger ?? noopLogger;
  const credential = candidate.credential;

  let secrets = opts.secrets ?? (await credential.openForInference());

  const stale =
    opts.secrets === undefined &&
    credential.authType === "oauth" &&
    credential.expiresAt !== null &&
    credential.expiresAt - refreshLeadMs <= now;

  if (stale) {
    logger.debug("preemptive credential refresh", {
      requestId: opts.requestId,
      provider: credential.provider,
      credentialId: credential.id,
    });
    if (!credential.hasRefreshToken) {
      throw new GatewayError("AUTH", "credential expired with no refresh token", {
        provider: credential.provider,
      });
    }
    secrets = await refresh(credential);
  }

  return adapter.send({
    request: opts.request,
    model: candidate.target.model,
    credentials: {
      accessToken: secrets.accessToken,
      apiKey: secrets.apiKey,
      providerData: credential.providerData,
    },
    http,
    signal,
    ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
    ...(opts.autoCache === undefined ? {} : { autoCache: opts.autoCache }),
  });
}
