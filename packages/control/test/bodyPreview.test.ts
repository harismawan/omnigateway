import { expect, test } from "bun:test";
import { previewBody } from "../src/bodies.ts";

test("all parts keep their prefix even when aggregate escaped previews exceed 8 MiB", () => {
  const text = "\u0000".repeat(400_000);
  const pair = { request: text, response: text, truncated: false };
  const body = previewBody("id", null, {
    row: {
      requestId: "id",
      at: 1,
      relPath: null,
      sha256: null,
      sizeBytes: 1,
      detailState: "ready",
      truncated: false,
    },
    artifact: {
      schemaVersion: 1,
      requestId: "id",
      at: 1,
      client: pair,
      attempts: [1, 2, 3].map((attempt) => ({
        ...pair,
        attempt,
        provider: "test",
        streamChunks: null,
      })),
      error: null,
    },
  });
  expect(body.parts).toHaveLength(9);
  for (const part of body.parts.slice(0, 8)) {
    expect(part.preview).toBe(JSON.stringify(text).slice(0, 1024 * 1024));
    expect(part.sizeBytes).toBe(2_400_002);
  }
});

test("each part has a code-point-safe 1 MiB JSON prefix and its full byte size", () => {
  const value = "é🙂".repeat(200_000);
  const json = JSON.stringify(value);
  const preview = previewBody("id", null, {
    row: {
      requestId: "id",
      at: 1,
      relPath: null,
      sha256: null,
      sizeBytes: 2,
      detailState: "ready",
      truncated: false,
    },
    artifact: {
      schemaVersion: 1,
      requestId: "id",
      at: 1,
      client: { request: value, response: value, truncated: false },
      attempts: [],
      error: null,
    },
  });
  expect(preview.parts).toHaveLength(3);
  for (const part of preview.parts.slice(0, 2)) {
    expect(Buffer.byteLength(part.preview)).toBeLessThanOrEqual(1024 * 1024);
    expect(json.startsWith(part.preview)).toBe(true);
    expect(part.preview).not.toContain("�");
    expect(part.sizeBytes).toBe(Buffer.byteLength(json));
    expect(part.previewTruncated).toBe(true);
  }
});

test("a supplementary code point crossing the character slice is not replaced", () => {
  const value = `${" ".repeat(1024 * 1024 - 2)}🙂tail`;
  const body = previewBody("id", null, {
    row: {
      requestId: "id",
      at: 1,
      relPath: null,
      sha256: null,
      sizeBytes: 2,
      detailState: "ready",
      truncated: false,
    },
    artifact: {
      schemaVersion: 1,
      requestId: "id",
      at: 1,
      client: { request: value, response: null, truncated: false },
      attempts: [],
      error: null,
    },
  });
  expect(body.parts[0]?.preview).not.toContain("�");
  expect(JSON.stringify(value).startsWith(body.parts[0]?.preview ?? "")).toBe(true);
});

test("old omission markers retain their reason and nullable serialized size", () => {
  for (const serializedBytes of [null, 800_000]) {
    const marker = {
      omitted: true as const,
      reason: "artifact exceeded 524288 bytes after structural bounding",
      serializedBytes,
    };
    const body = previewBody("id", "omitted", {
      row: {
        requestId: "id",
        at: 1,
        relPath: null,
        sha256: null,
        sizeBytes: 2,
        detailState: "ready",
        truncated: true,
      },
      artifact: {
        schemaVersion: 1,
        requestId: "id",
        at: 1,
        client: { request: marker, response: null, truncated: true },
        attempts: [],
        error: null,
      },
    });
    expect(body.parts[0]?.omitted).toEqual(marker);
    expect(body.bodyState).toBe("omitted");
  }
});
