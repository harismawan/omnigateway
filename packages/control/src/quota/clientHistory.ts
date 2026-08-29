import type { ProviderId } from "@omni/ir";
import type { Store, WindowType } from "@omni/store";
import { usedRatioOf } from "./headroom.ts";
import { retainedSpan } from "./history.ts";

/**
 * One retained reading of one account's quota window, as a fraction.
 *
 * The same disclosure `AccountQuota` makes, over time rather than at now: the
 * account is named, its ceiling is not. `usedRatio` is never null here — a
 * reading against an unstated ceiling is not a percentage of anything, and it is
 * dropped rather than drawn at zero, the rule `quotaSegments` already applies to
 * the operator's own readings.
 */
export type AccountQuotaSample = {
  credentialId: string;
  label: string;
  provider: ProviderId;
  windowType: WindowType;
  observedAt: number;
  usedRatio: number;
  resetsAt: number | null;
  windowMs: number | null;
};

export type AccountQuotaHistoryInput = {
  since?: string | number | undefined;
  until?: string | number | undefined;
};

export type AccountQuotaHistoryResult = { samples: AccountQuotaSample[] };

/**
 * The retained readings behind the client screen's quota charts.
 *
 * One series per account and window, which is what lets a key holder see which
 * account is filling up rather than only that one of them is.
 *
 * ## What is not here
 *
 * No gateway rate. The operator's panel corroborates provider units against this
 * gateway's own token throughput, and that aggregate covers every key on the
 * installation — a number about the operator's traffic, not this client's, and
 * one no client is entitled to.
 *
 * No `used` and no `limit`, for the reason `AccountQuota` omits them: an account
 * a client can watch filling up is not an account whose size it has been told.
 */
export async function accountQuotaHistory(
  deps: { store: Store; now: () => number },
  input: AccountQuotaHistoryInput,
): Promise<AccountQuotaHistoryResult> {
  const { since, until } = await retainedSpan(deps, input);

  const [samples, credentials] = await Promise.all([
    deps.store.credentials.listQuotaSamples({ since, until }),
    deps.store.credentials.list(),
  ]);

  const byId = new Map(credentials.map((credential) => [credential.id, credential]));

  const out: AccountQuotaSample[] = [];
  for (const sample of samples) {
    const credential = byId.get(sample.credentialId);
    // A sample whose credential is gone names an account that no longer serves
    // anything, exactly as the live reading of it would.
    if (credential === undefined) continue;

    const usedRatio = usedRatioOf(sample.used, sample.limit);
    if (usedRatio === null) continue;

    out.push({
      credentialId: credential.id,
      label: credential.label,
      provider: credential.provider,
      windowType: sample.windowType,
      observedAt: sample.observedAt,
      usedRatio,
      resetsAt: sample.resetsAt,
      windowMs: sample.windowMs,
    });
  }

  return {
    samples: out.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.label.localeCompare(b.label) ||
        a.windowType.localeCompare(b.windowType) ||
        a.observedAt - b.observedAt,
    ),
  };
}
