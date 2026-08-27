import type { ProviderId } from "@omni/ir";
import type { Store, WindowType } from "@omni/store";

/**
 * How much room a provider has left, with nothing said about which account has
 * it.
 *
 * The client-facing answer to "why am I being throttled". A key holder can see
 * that a provider is near its ceiling without learning how many accounts the
 * operator runs, what they are called, or which one served their request — that
 * is the operator's infrastructure and it is not the client's business.
 *
 * Redaction happens here rather than in the route so that the identifiers are
 * absent from the payload itself. A route that fetched the full shape and
 * omitted fields while rendering would still put them on the wire the day
 * somebody added a generic serializer.
 */
export type ProviderHeadroom = {
  provider: ProviderId;
  windowType: WindowType;
  /**
   * The best headroom any one account of this provider still has, 0..100.
   *
   * The minimum consumption across the provider's credentials, not the maximum
   * and not the mean. The router serves a request from whichever account can
   * take it, so one exhausted account among five does not throttle anybody, and
   * reporting the worst case would have a client chasing a limit that is not
   * affecting them. The mean would describe a fleet nobody is routed to.
   *
   * Null where no account reported a ceiling. Missing data is unknown, never
   * unlimited.
   */
  usedPercent: number | null;
  /**
   * When the account behind `usedPercent` rolls over, or null where it did not
   * say. The instant that matters is the one attached to the account actually
   * serving, so this tracks the same window the percentage came from rather
   * than being the earliest reset of the group.
   */
  resetsAt: number | null;
};

/**
 * Provider-level headroom, with credential identity removed.
 *
 * Reads the same `quota_windows` rows the operator's panel reads. Credentials
 * are joined only to learn which provider each row belongs to; no credential id
 * or label reaches the result.
 */
export async function providerHeadroom(store: Store): Promise<ProviderHeadroom[]> {
  const [windows, credentials] = await Promise.all([
    store.credentials.listQuota(),
    store.credentials.list(),
  ]);

  const providerOf = new Map<string, ProviderId>();
  for (const credential of credentials) providerOf.set(credential.id, credential.provider);

  /** Best (lowest) consumption seen so far per provider and window. */
  const best = new Map<string, ProviderHeadroom>();

  for (const window of windows) {
    const provider = providerOf.get(window.credentialId);
    // A quota row whose credential has been removed names an account that no
    // longer serves anything. Dropping it is right, and it is also what keeps a
    // dangling id from reaching a client through the group key.
    if (provider === undefined) continue;

    const percent =
      window.limit === null || window.limit === 0
        ? null
        : Math.min(100, Math.max(0, (window.used / window.limit) * 100));

    const groupKey = `${provider}:${window.windowType}`;
    const current = best.get(groupKey);

    if (current === undefined) {
      best.set(groupKey, {
        provider,
        windowType: window.windowType,
        usedPercent: percent,
        resetsAt: window.resetsAt,
      });
      continue;
    }

    // A known figure always beats an unknown one: an account that reported a
    // ceiling tells the client more than one that did not, whichever came first.
    if (current.usedPercent === null) {
      if (percent !== null) {
        best.set(groupKey, {
          provider,
          windowType: window.windowType,
          usedPercent: percent,
          resetsAt: window.resetsAt,
        });
      }
      continue;
    }

    if (percent !== null && percent < current.usedPercent) {
      best.set(groupKey, {
        provider,
        windowType: window.windowType,
        usedPercent: percent,
        resetsAt: window.resetsAt,
      });
    }
  }

  return [...best.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.windowType.localeCompare(b.windowType),
  );
}
