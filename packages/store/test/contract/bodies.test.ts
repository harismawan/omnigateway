import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import {
  bodiesDirFor,
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  sealBinaryArtifact,
  sha256Hex,
} from "../../src/bodies/artifact.ts";
import { deriveKey, encrypt } from "../../src/encryption.ts";
import { createBodyRepo } from "../../src/postgres/bodies.ts";
import type { BodyArtifact, Store } from "../../src/types.ts";
import { type Backend, forEachStore } from "./harness.ts";

const AT = Date.UTC(2026, 7, 17, 12, 0, 0);

/** The harness's field secret, so envelopes planted here open under the store's key. */
const SECRET = "test-secret-value-for-unit-tests";
/** The read ceiling, restated rather than imported so the test cannot drift with it. */
const CEILING = 2 * MAX_ARTIFACT_BYTES + 65;

/** A JSON object of exactly `n` UTF-8 bytes. */
function paddedJson(n: number): string {
  return `{"pad":"${"x".repeat(n - 10)}"}`;
}

/**
 * Replaces an artifact's stored bytes behind the store's back — the file on
 * SQLite, the column on Postgres — with the row's digest kept honest, so the
 * digest is never what decides. `null` removes the bytes.
 */
async function plant(
  backend: Backend,
  s: Store,
  requestId: string,
  relPath: string,
  bytes: Uint8Array | null,
): Promise<void> {
  const sha256 = bytes === null ? null : await sha256Hex(bytes);
  if (backend.name === "sqlite") {
    const path = join(bodiesDirFor(s.databasePath), relPath);
    if (bytes === null) await rm(path, { force: true });
    else await writeFile(path, bytes);
    const db = new Database(s.databasePath);
    try {
      db.run("UPDATE request_bodies SET sha256 = ? WHERE request_id = ?", [sha256, requestId]);
    } finally {
      db.close();
    }
    return;
  }
  const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
  try {
    await sql.unsafe("UPDATE request_bodies SET bytes = $1, sha256 = $2 WHERE request_id = $3", [
      bytes,
      sha256,
      requestId,
    ]);
  } finally {
    await sql.close();
  }
}

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

  test("bytes past the read ceiling are corrupt, absent bytes missing, on every store", async () => {
    const s = await backend.fresh();
    const input = artifact();
    const row = await s.bodies.put(input);
    const relPath = row.relPath ?? "";
    const key = await deriveKey(SECRET);
    const state = async (): Promise<string | undefined> =>
      (await s.bodies.get(input.requestId))?.row.detailState;

    await plant(backend, s, input.requestId, relPath, null);
    expect(await state()).toBe("missing");

    // Authenticated and digest-matched: only the ceiling can turn it away, and
    // having bytes too large to read is not the same fact as having none.
    const past = new TextEncoder().encode(await encrypt(key, paddedJson(MAX_ARTIFACT_BYTES + 1)));
    expect(past.length).toBe(CEILING + 2);
    await plant(backend, s, input.requestId, relPath, past);
    expect(await state()).toBe("corrupt");

    // Exactly at the ceiling is read, and the corrupt row recovers.
    const at = new TextEncoder().encode(await encrypt(key, paddedJson(MAX_ARTIFACT_BYTES)));
    expect(at.length).toBe(CEILING);
    await plant(backend, s, input.requestId, relPath, at);
    expect(await state()).toBe("ready");
  });

  test("a binary envelope reads back on every store", async () => {
    const s = await backend.fresh();
    const input = artifact();
    const row = await s.bodies.put(input);
    const prepared = prepareArtifact(input);
    const sealed = await sealBinaryArtifact(await deriveKey(SECRET), prepared.json);
    await plant(backend, s, input.requestId, row.relPath ?? "", sealed.bytes);

    const read = await s.bodies.get(input.requestId);
    expect(read?.row.detailState).toBe("ready");
    expect(read?.artifact).toEqual(prepared.artifact);
  });

  // The outcome above cannot show *where* Postgres turned the bytes away: the
  // shared reader would also refuse them once fetched. What the guard exists for
  // is that they are never fetched, so this watches what the query returned.
  if (backend.name === "postgres") {
    test("postgres never selects bytes past the ceiling, and reports their size", async () => {
      const s = await backend.fresh();
      const input = artifact();
      const row = await s.bodies.put(input);
      await plant(backend, s, input.requestId, row.relPath ?? "", new Uint8Array(CEILING + 1));

      const real = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
      const fetched: unknown[] = [];
      const recording = {
        async unsafe(query: string, params?: unknown[]): Promise<unknown[]> {
          const rows: unknown[] = await real.unsafe(query, params);
          fetched.push(...rows);
          return rows;
        },
      };
      try {
        const repo = createBodyRepo(recording as unknown as SQL, await deriveKey(SECRET));
        expect((await repo.get(input.requestId))?.row.detailState).toBe("corrupt");
        const selected = fetched.find((r) => child(r, "request_id") === input.requestId);
        expect(selected).toBeDefined();
        expect(child(selected, "bytes")).toBeNull();
        expect(Number(child(selected, "encoded_size"))).toBe(CEILING + 1);
      } finally {
        await real.close();
      }
    });
  }
});
