import { GatewayError, type StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import type { CredentialSecrets, CredentialView } from "@omni/store";
import type { Candidate } from "../router/index.ts";

export type AttemptResult = {
  events: AsyncGenerator<StreamEvent, void, undefined>;
  degradations: string[];
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
}): Promise<AttemptResult> {
  const { candidate, adapter, http, now, signal, refresh, refreshLeadMs } = opts;
  const credential = candidate.credential;

  let secrets = await credential.secrets();

  const stale =
    credential.authType === "oauth" &&
    credential.expiresAt !== null &&
    credential.expiresAt - refreshLeadMs <= now;

  if (stale) {
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
  });
}
