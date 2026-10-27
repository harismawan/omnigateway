import type { RequestLog } from "@omni/store";
import { requestLog } from "@omni/testkit";

/**
 * The rows every export golden file is generated from. A change here changes
 * every golden; regenerate with `UPDATE_GOLDEN=1` and read the diff.
 */

/** Null prototype, as the trace extractor builds it, so `__proto__` is an ordinary key. */
function metadata(entries: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/**
 * A full success: two attempts, cache traffic, RTK, a complete trace. Starts on
 * the last second of a UTC day and completes on the next, so a local-time index
 * date or a completion-time index date would both show.
 */
export const SUCCESS: RequestLog = requestLog({
  id: "req_01JB7Q2W3E4R5T6Y7U8I9O0P",
  at: Date.UTC(2026, 9, 24, 23, 59, 59, 120),
  completedAt: Date.UTC(2026, 9, 25, 0, 0, 1, 470),
  apiKeyId: "key_team",
  requestedModel: "smart",
  resolvedProvider: "anthropic",
  resolvedModel: "claude-opus-4-1",
  credentialId: "cred_a1",
  attempts: 2,
  status: 200,
  errorCode: null,
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 50_000,
  cacheWriteTokens: 800,
  ttftMs: 412,
  durationMs: 2350,
  costUsd: 0.081234,
  degradations: ["anthropic:cache-breakpoint-added"],
  prompts: ["ponytail-full@v4.9.0", "team@11"],
  rtkApplied: true,
  rtkFilterHits: 3,
  rtkOriginalCodeUnits: 9000,
  rtkCompressedCodeUnits: 2100,
  rtkEstimatedTokensSaved: 1725,
  rtkFilters: ["git-diff", "grep"],
  sessionId: "ses_8f2c",
  turnId: "turn-7",
  agent: "claude-code",
  tags: ["team:core", "ci"],
  traceMetadata: metadata([
    ["ticket", "OMNI-42"],
    ["__proto__", "kept"],
    ["note", 'say "hi"'],
  ]),
  clientRequestId: "cli-123",
  upstreamRequestId: "req_011CUabc",
});

/** A failure that never reached a provider: every nullable field null, no trace. */
export const FAILURE: RequestLog = requestLog({
  id: "req_01JB7Q2W3E4R5T6Y7U8I9O0Q",
  at: Date.UTC(2026, 9, 25, 0, 0, 0, 5),
  completedAt: Date.UTC(2026, 9, 25, 0, 0, 0, 20),
  apiKeyId: null,
  requestedModel: "gpt-5",
  resolvedProvider: null,
  resolvedModel: null,
  credentialId: null,
  attempts: 0,
  status: 503,
  errorCode: "NO_CANDIDATES",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ttftMs: null,
  durationMs: 15,
  costUsd: 0,
});

/** The key label the worker would have looked up for `SUCCESS`'s key: multi-byte on purpose. */
export const LABEL = "Équipe 🦊";
export const NODE = "node-7f3a";
