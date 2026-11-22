import type {
  AccountQuota,
  AccountQuotaSample,
  ClientQuotaHistoryResponse,
  ClientRequestLog,
} from "../../src/api/types.ts";

/**
 * The key sets of the console's hand-kept client wire mirrors.
 *
 * A `Record<keyof T, true>` rather than a runtime sample: it is the type itself
 * being checked, so a field added to the mirror without a line here is a
 * compile error, and a line here without the field is one too.
 * `rustMirrors.test.ts` then compares each list with the Rust code that emits
 * the shape.
 */
const CLIENT_REQUEST_LOG: Record<keyof ClientRequestLog, true> = {
  at: true,
  attempts: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  costUsd: true,
  degradations: true,
  durationMs: true,
  errorCode: true,
  id: true,
  inputTokens: true,
  outputTokens: true,
  requestedModel: true,
  resolvedModel: true,
  resolvedProvider: true,
  rtkApplied: true,
  rtkEstimatedTokensSaved: true,
  state: true,
  status: true,
  ttftMs: true,
};

const ACCOUNT_QUOTA: Record<keyof AccountQuota, true> = {
  credentialId: true,
  exhaustsAt: true,
  label: true,
  observedAt: true,
  provider: true,
  ratePerHourRatio: true,
  resetsAt: true,
  rolledOver: true,
  stale: true,
  survives: true,
  usedRatio: true,
  windowMs: true,
  windowType: true,
};

const ACCOUNT_QUOTA_SAMPLE: Record<keyof AccountQuotaSample, true> = {
  credentialId: true,
  label: true,
  observedAt: true,
  provider: true,
  resetsAt: true,
  usedRatio: true,
  windowMs: true,
  windowType: true,
};

/**
 * The history envelope. `truncated` is read as `history.data?.truncated ===
 * true`, so a server that stopped sending it would read as "nothing was cut".
 */
const CLIENT_QUOTA_HISTORY_RESPONSE: Record<keyof ClientQuotaHistoryResponse, true> = {
  samples: true,
  truncated: true,
};

export const CLIENT_REQUEST_LOG_KEYS: readonly string[] = Object.keys(CLIENT_REQUEST_LOG);
export const ACCOUNT_QUOTA_KEYS: readonly string[] = Object.keys(ACCOUNT_QUOTA);
export const ACCOUNT_QUOTA_SAMPLE_KEYS: readonly string[] = Object.keys(ACCOUNT_QUOTA_SAMPLE);
export const CLIENT_QUOTA_HISTORY_RESPONSE_KEYS: readonly string[] = Object.keys(
  CLIENT_QUOTA_HISTORY_RESPONSE,
);
