import { GatewayError, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { CredentialSecrets, CredentialView, Store } from "@omni/store";
import type { OAuthProvider } from "./types.ts";

export type RefreshDeps = {
  store: Store;
  providers: Readonly<Record<ProviderId, OAuthProvider>>;
  http: HttpClient;
  now: () => number;
  logger?: Logger;
};

export type Refresher = (credential: CredentialView) => Promise<CredentialSecrets>;

export function createRefresher(deps: RefreshDeps): Refresher {
  const logger = deps.logger ?? noopLogger;

  /**
   * One in-flight refresh per credential.
   *
   * Concurrent requests routinely pick the same credential in the instant it
   * expires. If each ran its own refresh, a provider that rotates refresh
   * tokens would invalidate every rotation but the last, permanently breaking
   * the credential. Callers share one promise instead.
   *
   * Contract, because the map key does not say it out loud: entries are keyed
   * by credential id, and `run` reads the secrets and provider data off the
   * `CredentialView` the *first* caller supplied. A second caller that passes a
   * different (say, staler) view of the same credential gets the first caller's
   * result, not one derived from its own view. That is deliberate — a
   * credential has exactly one current token, and whichever view observed it
   * first is as good as any other for producing the next one.
   */
  const inFlight = new Map<string, Promise<CredentialSecrets>>();

  async function run(credential: CredentialView): Promise<CredentialSecrets> {
    const secrets = await credential.openForRefresh();
    if (secrets.refreshToken === null) {
      throw new GatewayError("AUTH", `credential ${credential.id} has no refresh token`);
    }

    const provider = deps.providers[credential.provider];
    logger.debug("refreshing credential", {
      provider: credential.provider,
      credentialId: credential.id,
    });

    let result: Awaited<ReturnType<OAuthProvider["refresh"]>>;
    try {
      result = await provider.refresh(
        secrets.refreshToken,
        { http: deps.http, now: deps.now },
        credential.providerData,
      );
    } catch (error) {
      // AUTH means the provider repudiated the refresh token: retrying cannot
      // help, and leaving the credential enabled burns one attempt on every
      // subsequent request. Anything else (network, timeout) is transient.
      if (error instanceof GatewayError && error.code === "AUTH") {
        logger.warn("credential disabled: refresh token rejected", {
          provider: credential.provider,
          credentialId: credential.id,
          code: "AUTH",
        });
        await deps.store.credentials.update(credential.id, {
          enabled: false,
          // Recorded here rather than at the call site so the background sweep
          // and a live request leave the same evidence behind. Without it the
          // console cannot tell a repudiated account from a switched-off one.
          disabledReason: "tokenRejected",
          disabledAt: deps.now(),
        });
      }
      throw error;
    }

    // Two writes, not one: `update` takes a `Partial<Credential>`, and
    // `Credential` has no secrets member — token material only goes through
    // `updateSecrets`, which is the half that encrypts. `expiresAt` rides along
    // with the secrets it belongs to rather than being written twice.
    await deps.store.credentials.updateSecrets(credential.id, result.secrets, result.expiresAt);
    await deps.store.credentials.update(credential.id, {
      accountEmail: result.accountEmail ?? credential.accountEmail,
      // Merge: a refresh response may omit fields the connect flow captured,
      // such as the Kimi device id.
      providerData: { ...credential.providerData, ...result.providerData },
    });

    logger.debug("credential refreshed", {
      provider: credential.provider,
      credentialId: credential.id,
    });

    return result.secrets;
  }

  return function refresh(credential) {
    const existing = inFlight.get(credential.id);
    if (existing !== undefined) return existing;

    const promise = run(credential).finally(() => {
      // Cleared on both paths: caching a rejection would make one transient
      // network error stick to the credential forever.
      inFlight.delete(credential.id);
    });

    inFlight.set(credential.id, promise);
    return promise;
  };
}
