import type { QuotaSample, Store } from "@omni/store";

const DAY_MS = 24 * 60 * 60 * 1000;

export type QuotaHistoryInput = {
  since?: string | number | undefined;
  until?: string | number | undefined;
  /** Omitted means every credential. */
  credentialId?: string | undefined;
};

/** A finite number, or the fallback. Both callers hand this function strings. */
function instant(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The retained readings for a span, as the Accounts disclosure charts them.
 *
 * Samples only: the burn estimate rides the health endpoint and is not repeated
 * here. The span is clamped to what pruning leaves readable, so a request for
 * "everything" cannot read further back than the rows actually go.
 */
export async function quotaHistory(
  deps: { store: Store; now: () => number },
  input: QuotaHistoryInput,
): Promise<QuotaSample[]> {
  const now = deps.now();
  const settings = await deps.store.config.getSettings();
  const oldest = now - settings.logRetentionDays * DAY_MS;

  const since = Math.max(instant(input.since, oldest), oldest);
  const until = Math.min(instant(input.until, now), now);
  const credentialId = input.credentialId?.trim();

  return deps.store.credentials.listQuotaSamples({
    since,
    until,
    ...(credentialId === undefined || credentialId.length === 0 ? {} : { credentialId }),
  });
}
