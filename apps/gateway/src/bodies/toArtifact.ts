import {
  ARTIFACT_SCHEMA_VERSION,
  type BodyArtifact,
  type BodyAttempt,
  type BodyOmission,
} from "@omni/store";
import type { CapturedParts } from "../bodyCapture.ts";

/**
 * The reason an abandoned capture's artifact carries. Recognised by
 * `omitted: true`, never by this text.
 */
export const BUDGET_OMISSION_REASON = "capture budget exhausted";

/** JSON where it parses, the raw text otherwise: a body is whatever was sent. */
function asBody(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Captured text as the artifact `store.bodies.put` takes.
 *
 * **Transitional.** It parses on the main thread, which is what the body
 * writer exists to stop; the writer does this off-thread and this file goes
 * with it. An abandoned capture becomes the omission marker every reader
 * already knows, with the attempt frame and the error kept: which providers
 * were tried is cheap, and is what an operator opening it is after.
 */
export function toArtifact(parts: CapturedParts): BodyArtifact {
  const base = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    requestId: parts.requestId,
    at: parts.at,
    error: parts.error,
  };
  if (parts.abandoned !== null) {
    const marker: BodyOmission = {
      omitted: true,
      reason: BUDGET_OMISSION_REASON,
      serializedBytes: null,
    };
    return {
      ...base,
      client: { request: marker, response: marker, truncated: true },
      attempts: parts.attempts.map(
        (attempt): BodyAttempt => ({
          attempt: attempt.attempt,
          provider: attempt.provider,
          request: marker,
          response: marker,
          streamChunks: null,
          truncated: true,
        }),
      ),
    };
  }
  const response = parts.client.response;
  return {
    ...base,
    client: {
      request: asBody(parts.client.request),
      // A frame list is the response as it was streamed; only a rendered body parses.
      response: Array.isArray(response) ? response : asBody(response),
      truncated: parts.client.truncated,
    },
    attempts: parts.attempts.map(
      (attempt): BodyAttempt => ({
        attempt: attempt.attempt,
        provider: attempt.provider,
        request: asBody(attempt.request),
        response: asBody(attempt.response),
        streamChunks: attempt.streamChunks,
        truncated: attempt.truncated,
      }),
    ),
  };
}
