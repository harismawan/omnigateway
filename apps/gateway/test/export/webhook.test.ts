import { expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  encodeWebhook,
  sign,
  WEBHOOK_ENVELOPE,
  webhookBody,
  webhookPart,
} from "../../src/export/encoders/webhook.ts";
import { buildRecord } from "../../src/export/record.ts";
import { golden } from "./fixtures/golden.ts";
import { FAILURE, LABEL, NODE, SUCCESS } from "./fixtures/rows.ts";

const records = [
  buildRecord(SUCCESS, { keyLabel: LABEL, nodeId: NODE }),
  buildRecord(FAILURE, { keyLabel: null, nodeId: NODE }),
];

test("the webhook body matches its golden file", async () => {
  await golden("webhook-body.json", encodeWebhook(records));
});

test("the body is the schema name and the records, in order", () => {
  const body = JSON.parse(encodeWebhook(records));
  expect(Object.keys(body)).toEqual(["schema", "records"]);
  expect(body.schema).toBe("omni.request_log/v1");
  expect(body.records).toEqual(JSON.parse(JSON.stringify(records)));
  expect(encodeWebhook([])).toBe('{"schema":"omni.request_log/v1","records":[]}');
});

test("the body is its parts joined inside the declared envelope", () => {
  const parts = records.map(webhookPart);
  expect(webhookBody(parts)).toBe(encodeWebhook(records));
  expect(Buffer.byteLength(webhookBody([]))).toBe(WEBHOOK_ENVELOPE.fixedBytes);
  expect(WEBHOOK_ENVELOPE.separatorBytes).toBe(1);
});

/** What a receiver writes: the documented recipe, with Node's HMAC as the reference. */
function receiverVerifies(body: string, secret: string, headers: Record<string, string>): boolean {
  const timestamp = headers["x-omni-timestamp"] ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const got = headers["x-omni-signature"] ?? "";
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

test("the signature verifies with a reference HMAC over `<timestamp>.<body>`", () => {
  const body = encodeWebhook(records);
  const headers = sign(body, "whsec_🦊-secret", 1_761_350_400);
  expect(Object.keys(headers)).toEqual(["x-omni-signature", "x-omni-timestamp"]);
  expect(headers["x-omni-timestamp"]).toBe("1761350400");
  expect(headers["x-omni-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(receiverVerifies(body, "whsec_🦊-secret", headers)).toBe(true);
});

test("a fixed input signs to a fixed value", () => {
  // Pinned against `printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac k`.
  expect(sign("{}", "k", 1_700_000_000)).toEqual({
    "x-omni-signature": "sha256=c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146",
    "x-omni-timestamp": "1700000000",
  });
});

test("the signature binds the body, the timestamp and the secret", () => {
  const body = encodeWebhook(records);
  const headers = sign(body, "s", 100);
  expect(receiverVerifies(`${body} `, "s", headers)).toBe(false);
  expect(receiverVerifies(body, "t", headers)).toBe(false);
  expect(receiverVerifies(body, "s", { ...headers, "x-omni-timestamp": "101" })).toBe(false);
});

test("a timestamp that is not whole non-negative seconds is a caller bug", () => {
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    expect(() => sign("{}", "k", bad)).toThrow(/timestamp/);
  }
});
