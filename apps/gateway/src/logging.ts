import type { RequestLog, Store } from "@omni/store";

function report(what: string, requestId: string, error: unknown): void {
  console.error(what, {
    requestId,
    // The message only; a store error must not drag a row's contents into stdout.
    reason: error instanceof Error ? error.message : "unknown",
  });
}

/**
 * Records a request that has started, so the console can show it running.
 *
 * The zeros this row carries are placeholders, not measurements — readers tell
 * the two apart by `state`. Never throws, for the same reason `finishLog` does
 * not: a log the operator watches must not be able to fail a request.
 */
export async function beginLog(
  store: Store,
  log: Omit<RequestLog, "state">,
  keyId: string | null,
): Promise<void> {
  try {
    await store.usage.begin({ ...log, state: "pending", apiKeyId: keyId });
  } catch (error) {
    report("failed to record request start", log.id, error);
  }
}

/**
 * Persists a finished request log, completing the pending row if one was
 * written.
 *
 * Never throws: a failure to write a log line must not turn a successful
 * proxied request into an error the client sees.
 */
export async function finishLog(
  store: Store,
  log: RequestLog,
  keyId: string | null,
): Promise<void> {
  try {
    await store.usage.append({ ...log, apiKeyId: keyId });
  } catch (error) {
    report("failed to persist request log", log.id, error);
  }
}
