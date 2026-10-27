import type {
  BodyArtifact,
  BodyDetailState,
  BodyOmission,
  BodyRead,
  RequestLog,
  Store,
} from "@omni/store/types";

export type BodyPart =
  | "client.request"
  | "client.response"
  | `attempt.${number}.request`
  | `attempt.${number}.response`
  | "error";
export type BodyPreview = {
  requestId: string;
  detailState: BodyDetailState;
  truncated: boolean;
  sizeBytes: number;
  at: number | null;
  bodyState: RequestLog["bodyState"];
  parts: Array<{
    part: BodyPart;
    sizeBytes: number;
    preview: string;
    previewTruncated: boolean;
    omitted: BodyOmission | null;
  }>;
};
export type RequestBodyRead = BodyPreview;
export const BODY_PREVIEW_BYTES = 1024 * 1024;

export function isBodyPart(part: string): part is BodyPart {
  return /^(?:client\.(?:request|response)|attempt\.\d+\.(?:request|response)|error)$/.test(part);
}

/** Serialization is shared by the writer and the CLI, never called by HTTP handlers. */
export function* bodyParts(artifact: BodyArtifact): Generator<[BodyPart, unknown]> {
  yield ["client.request", artifact.client.request];
  yield ["client.response", artifact.client.response];
  for (const attempt of artifact.attempts) {
    yield [`attempt.${attempt.attempt}.request`, attempt.request];
    yield [`attempt.${attempt.attempt}.response`, attempt.response];
  }
  yield ["error", artifact.error];
}

function omission(value: unknown): BodyOmission | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return v.omitted === true && typeof v.reason === "string"
    ? {
        omitted: true,
        reason: v.reason,
        serializedBytes: typeof v.serializedBytes === "number" ? v.serializedBytes : null,
      }
    : null;
}

/** First bytes of serialized JSON; a partial UTF-8 code point is never included. */
export function previewBody(
  requestId: string,
  bodyState: RequestLog["bodyState"],
  read: BodyRead | null,
): BodyPreview {
  const result: BodyPreview = {
    requestId,
    bodyState,
    detailState: read?.row.detailState ?? "none",
    truncated: read?.row.truncated ?? false,
    sizeBytes: read?.row.sizeBytes ?? 0,
    at: read?.row.at ?? null,
    parts: [],
  };
  let replyBytes = 0;
  if (read?.artifact)
    for (const [part, value] of bodyParts(read.artifact)) {
      const json = JSON.stringify(value ?? null);
      const sizeBytes = Buffer.byteLength(json);
      // Inspect at most 1 MiB code units, then trim by bytes without allocating the full part.
      const bytes = new TextEncoder().encode(json.slice(0, BODY_PREVIEW_BYTES));
      let end = Math.min(bytes.length, BODY_PREVIEW_BYTES);
      if (end < bytes.length) while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
      const preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      replyBytes += Buffer.byteLength(JSON.stringify(preview)) + 1024;
      if (replyBytes > 8 * BODY_PREVIEW_BYTES) throw new Error("body preview reply exceeds 8 MiB");
      result.parts.push({
        part,
        sizeBytes,
        preview,
        previewTruncated: end < sizeBytes,
        omitted: omission(value),
      });
    }
  return result;
}

export type BodyDecoder = (requestId: string) => Promise<BodyPreview>;

/** Gateway injects the host; the local CLI decodes in its own process. */
export async function readRequestBody(
  store: Store,
  requestId: string,
  decode?: BodyDecoder,
): Promise<BodyPreview> {
  if (decode) return decode(requestId);
  const [read, log] = await Promise.all([store.bodies.get(requestId), store.usage.get(requestId)]);
  return previewBody(requestId, log?.bodyState ?? null, read);
}
