import type { ExportReader } from "@omni/store/exportReader";
import type { RequestLog } from "@omni/store/types";
import type { Sender } from "../deliver.ts";
import type { RequestRecord } from "../record.ts";
import { createBodyBudget, pipelineReservation } from "./budget.ts";
import { scanFields } from "./scanner.ts";
import { segments } from "./segment.ts";

export const DEFAULT_BODY_BUDGET_BYTES = 192 * 1024 * 1024;
export type Attachment = {
  record: RequestRecord;
  client?: { request: string; response: string };
  release(): void;
};

export function createBodyAttacher(limit: number) {
  const budget = createBodyBudget(limit);
  return {
    held: budget.held,
    async attach(
      reader: ExportReader,
      row: RequestLog,
      record: RequestRecord,
      sender: Sender,
      signal: AbortSignal,
    ): Promise<Attachment> {
      const slot = await budget.acquire(signal);
      try {
        record.body = { state: "unavailable" };
        if (row.bodyState === "pending" || row.bodyState === "failed")
          return { record, release: slot.release };
        let probe: Awaited<ReturnType<ExportReader["bodyProbe"]>>;
        try {
          probe = await reader.bodyProbe(row.id);
        } catch {
          signal.throwIfAborted();
          return { record, release: slot.release };
        }
        signal.throwIfAborted();
        if (!probe) return { record, release: slot.release };
        const cap = sender.maxRequestBytes ?? sender.limits.bytes;
        const reserved = pipelineReservation(
          probe.encryptedBytes,
          probe.plaintextBytes,
          cap,
          Buffer.byteLength(sender.body([sender.part(record)])),
        );
        if (!slot.reserve(reserved)) {
          record.body = { state: "omitted", reason: "export budget" };
          return { record, release: slot.release };
        }
        let extracted: Awaited<ReturnType<typeof extract>>;
        try {
          extracted = await extract(reader, row.id, probe, signal);
        } catch {
          signal.throwIfAborted();
          return { record, release: slot.release };
        }
        if (!extracted) return { record, release: slot.release };
        record.body = { state: extracted.truncated ? "incomplete" : "included" };
        if (extracted.reason !== null) record.body = { state: "omitted", reason: extracted.reason };
        return extracted.reason !== null
          ? { record, release: slot.release }
          : { record, client: extracted.client, release: slot.release };
      } catch (error) {
        slot.release();
        throw error;
      }
    },
  };
}

async function extract(
  reader: ExportReader,
  id: string,
  probe: { encryptedBytes: number; plaintextBytes: number },
  signal: AbortSignal,
) {
  const envelope = await reader.bodyEnvelope(id, probe.encryptedBytes);
  signal.throwIfAborted();
  if (!envelope || envelope.bytes.length !== probe.encryptedBytes) return null;
  const text = await reader.bodyText(envelope, probe.plaintextBytes);
  signal.throwIfAborted();
  if (text === null || Buffer.byteLength(text) !== probe.plaintextBytes) return null;
  let fields: Map<string, string>;
  try {
    fields = scanFields(text, signal);
  } catch {
    signal.throwIfAborted();
    return null;
  }
  // Identity and schema are tiny scalar parses, never a client body tree.
  if (fields.get("schemaVersion") !== "1" || fields.get("requestId") !== JSON.stringify(id))
    return null;
  const request = fields.get("client.request");
  const response = fields.get("client.response");
  if (request === undefined || response === undefined) return null;
  let reason: string | null = null;
  for (const part of ["request", "response"]) {
    if (fields.get(`client.${part}.omitted`) === "true") {
      const value = scalar(fields.get(`client.${part}.reason`));
      reason = typeof value === "string" ? value : "body omitted";
    }
  }
  return {
    client: { request, response },
    reason,
    truncated: envelope.truncated || fields.get("client.truncated") === "true",
  };
}

function scalar(text: string | undefined): unknown {
  if (text === undefined || text[0] !== '"') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function bodyCuts(
  sender: Sender,
  record: RequestRecord,
  part: "request" | "response",
  text: string,
  cap: number,
): string[] {
  return segments(text, cap, (segment, n, of) => {
    const encoded = sender.bodySegment?.(record, part, segment, n, of);
    if (!encoded) throw new Error("body encoder missing");
    return requestBytes(encoded.sender, encoded.part);
  });
}

/** zlib compressBound-style headroom, including the gzip wrapper. */
export function requestBytes(sender: Sender, part: string): number {
  const bytes = Buffer.byteLength(sender.body([part]));
  return sender.gzip
    ? bytes + Math.ceil(bytes / 4096) + Math.ceil(bytes / 16384) + Math.ceil(bytes / 33554432) + 64
    : bytes;
}
