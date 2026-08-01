import type { RequestLog, Store } from "@omni/store";

/**
 * Persists a finished request log.
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
    console.error("failed to persist request log", {
      requestId: log.id,
      // The message only; a store error must not drag a row's contents into stdout.
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
