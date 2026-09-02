import { expect, test } from "bun:test";
import type { BodyArtifact } from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

const AT = Date.UTC(2026, 7, 17, 12, 0, 0);

function artifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: "req_11111111-2222-4333-8444-555555555555",
    at: AT,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
    ...overrides,
  };
}

/** Steps into a parsed artifact without pretending to know its shape. */
function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

forEachStore((backend) => {
  test("an artifact round-trips masked, bounded, encrypted, and named by UTC date", async () => {
    const s = await backend.fresh();
    const marker = "CANARY-MARKER-DO-NOT-LEAK";
    const input = artifact({
      client: {
        request: { prompt: marker, api_key: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
        response: { text: marker },
        truncated: false,
      },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: { model: "claude-opus-4-1-20250805" },
          response: { stop_reason: "end_turn" },
          streamChunks: ["event: message_start", "event: message_stop"],
          truncated: false,
        },
      ],
    });
    const row = await s.bodies.put(input);
    expect(row.detailState).toBe("ready");
    expect(row.truncated).toBe(false);
    expect(row.relPath).toBe(`2026/08/17/${input.requestId}.json.enc`);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sizeBytes).toBeGreaterThan(0);

    const read = await s.bodies.get(input.requestId);
    expect(read?.row).toEqual(row);
    expect(read?.artifact?.schemaVersion).toBe(1);
    expect(read?.artifact?.attempts[0]?.streamChunks).toEqual([
      "event: message_start",
      "event: message_stop",
    ]);
    expect(child(read?.artifact?.client.request, "prompt")).toBe(marker);
    // Masking ran before the write: the key is gone and its absence is not truncation.
    expect(child(read?.artifact?.client.request, "api_key")).not.toContain("abcdefghij");
    expect(await s.bodies.get("nope")).toBeNull();

    // A retried write replaces rather than failing on the primary key.
    const again = await s.bodies.put({ ...input, at: AT + 1 });
    expect(again.at).toBe(AT + 1);
    expect((await s.bodies.get(input.requestId))?.row.at).toBe(AT + 1);
  });

  test("a request id that could escape a shard directory is rejected on every store", async () => {
    const s = await backend.fresh();
    for (const hostile of ["../../etc/passwd", "a/b", "req .json", "", "..", "req\0x"]) {
      await expect(s.bodies.put(artifact({ requestId: hostile }))).rejects.toThrow(
        /not safe to use as an artifact path segment/,
      );
    }
    expect(await s.bodies.get("../../etc/passwd")).toBeNull();
  });

  test("prune drops rows older than the cutoff and the row cap trims oldest first", async () => {
    const s = await backend.fresh();
    for (let i = 0; i < 5; i++) {
      await s.bodies.put(artifact({ requestId: `req_${i}`, at: AT + i }));
    }
    expect(await s.bodies.prune(AT + 2)).toBe(2);
    expect(await s.bodies.get("req_1")).toBeNull();
    expect(await s.bodies.get("req_2")).not.toBeNull();
    expect(await s.bodies.pruneToCap(1)).toBe(2);
    expect(await s.bodies.get("req_3")).toBeNull();
    expect(await s.bodies.get("req_4")).not.toBeNull();
    expect(await s.bodies.pruneToCap(1)).toBe(0);
    expect(await s.bodies.prune(0)).toBe(0);
    expect(typeof (await s.bodies.sweepOrphans())).toBe("number");
  });
});
