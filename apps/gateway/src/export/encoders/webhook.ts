import type { BatchEnvelope } from "../batch.ts";
import { RECORD_SCHEMA, type RequestRecord } from "../record.ts";

/**
 * Webhook encoding: `{"schema":"omni.request_log/v1","records":[…]}`, and its
 * optional signature. Pure: the caller passes the timestamp.
 */

const OPEN = `{"schema":${JSON.stringify(RECORD_SCHEMA)},"records":[`;
const CLOSE = "]}";

/** The body around the records, and the `,` between two of them. */
export const WEBHOOK_ENVELOPE: BatchEnvelope = {
  fixedBytes: Buffer.byteLength(OPEN) + Buffer.byteLength(CLOSE),
  separatorBytes: 1,
};

export function webhookPart(record: RequestRecord): string {
  return JSON.stringify(record);
}

/** The body from parts already encoded by {@link webhookPart}, as the batcher cut them. */
export function webhookBody(parts: readonly string[]): string {
  return `${OPEN}${parts.join(",")}${CLOSE}`;
}

export function encodeWebhook(records: readonly RequestRecord[]): string {
  return webhookBody(records.map(webhookPart));
}

export type WebhookSignature = { "x-omni-signature": string; "x-omni-timestamp": string };

/**
 * The signature headers for `body` sent at `timestamp` (unix **seconds**).
 *
 * `x-omni-signature: sha256=<hex>` is HMAC-SHA256, keyed with the signing
 * secret's UTF-8 bytes, over the exact string `<timestamp>.<body>` — the
 * decimal timestamp, a full stop, then the body bytes as sent (before any
 * transport compression). Binding the timestamp lets a receiver refuse replays
 * outside its own tolerance window. The recipe is documented for receivers in
 * README; the test verifies it against Node's `createHmac`.
 */
export function sign(body: string, secret: string, timestamp: number): WebhookSignature {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("webhook timestamp must be whole non-negative unix seconds");
  }
  const stamp = String(timestamp);
  const mac = new Bun.CryptoHasher("sha256", secret).update(`${stamp}.${body}`).digest("hex");
  return { "x-omni-signature": `sha256=${mac}`, "x-omni-timestamp": stamp };
}
