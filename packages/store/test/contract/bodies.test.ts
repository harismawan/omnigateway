import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { SQL } from "bun";
import {
  bodiesDirFor,
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  relPathFor,
  sealArtifact,
  sha256Hex,
} from "../../src/bodies/artifact.ts";
import { decrypt, deriveKey, encrypt } from "../../src/encryption.ts";
import { createBodyRepo } from "../../src/postgres/bodies.ts";
import { createStore } from "../../src/sqlite/store.ts";
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
 * SQLite, the column on Postgres — with the row's byte count and digest kept
 * honest, so neither is what decides. `null` removes the bytes. `digest` is
 * for the tests that want the row to lie about them.
 */
async function plant(
  backend: Pick<Backend, "name">,
  s: Store,
  requestId: string,
  relPath: string,
  bytes: Uint8Array | null,
  digest?: string | null,
): Promise<void> {
  const sha256 = digest !== undefined ? digest : bytes === null ? null : await sha256Hex(bytes);
  if (backend.name === "sqlite") {
    const path = join(bodiesDirFor(s.databasePath), relPath);
    if (bytes === null) await rm(path, { force: true });
    else await writeFile(path, bytes);
    const db = new Database(s.databasePath);
    try {
      db.run("UPDATE request_bodies SET sha256 = ? WHERE request_id = ?", [sha256, requestId]);
      if (bytes !== null) {
        db.run("UPDATE request_bodies SET size_bytes = ? WHERE request_id = ?", [
          bytes.length,
          requestId,
        ]);
      }
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
    if (bytes !== null) {
      await sql.unsafe("UPDATE request_bodies SET size_bytes = $1 WHERE request_id = $2", [
        bytes.length,
        requestId,
      ]);
    }
  } finally {
    await sql.close();
  }
}

/** The opaque bytes a store holds for a request, exactly as written. */
async function stored(
  backend: Pick<Backend, "name">,
  s: Store,
  requestId: string,
  relPath: string,
): Promise<Uint8Array> {
  if (backend.name === "sqlite") {
    return new Uint8Array(await readFile(join(bodiesDirFor(s.databasePath), relPath)));
  }
  const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
  try {
    const rows: { bytes: Uint8Array }[] = await sql.unsafe(
      "SELECT bytes FROM request_bodies WHERE request_id = $1",
      [requestId],
    );
    return new Uint8Array(rows[0]?.bytes ?? []);
  } finally {
    await sql.close();
  }
}

/** Sets a row's `detail_state` the way another reader's repository would have. */
async function setState(
  backend: Pick<Backend, "name">,
  s: Store,
  requestId: string,
  state: string,
): Promise<void> {
  if (backend.name === "sqlite") {
    const db = new Database(s.databasePath);
    try {
      db.run("UPDATE request_bodies SET detail_state = ? WHERE request_id = ?", [state, requestId]);
    } finally {
      db.close();
    }
    return;
  }
  const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
  try {
    await sql.unsafe("UPDATE request_bodies SET detail_state = $1 WHERE request_id = $2", [
      state,
      requestId,
    ]);
  } finally {
    await sql.close();
  }
}

/** The `detail_state` a row holds, read past the repository so no read can repair it. */
async function persistedState(
  backend: Pick<Backend, "name">,
  s: Store,
  requestId: string,
): Promise<string | undefined> {
  if (backend.name === "sqlite") {
    const db = new Database(s.databasePath);
    try {
      return db
        .query<{ detail_state: string }, [string]>(
          "SELECT detail_state FROM request_bodies WHERE request_id = ?",
        )
        .get(requestId)?.detail_state;
    } finally {
      db.close();
    }
  }
  const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
  try {
    const rows: { detail_state: string }[] = await sql.unsafe(
      "SELECT detail_state FROM request_bodies WHERE request_id = $1",
      [requestId],
    );
    return rows[0]?.detail_state;
  } finally {
    await sql.close();
  }
}

/**
 * The reader every release before v0.13.5 shipped, restated from its source:
 * the digest, then the credential helper's `decrypt` over the bytes as text,
 * then the object check. It knows one format, and anything else is `corrupt`.
 */
async function preDualRead(
  key: CryptoKey,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<"ready" | "corrupt"> {
  try {
    if (expectedSha256 !== null && (await sha256Hex(bytes)) !== expectedSha256) return "corrupt";
    const parsed: unknown = JSON.parse(await decrypt(key, new TextDecoder().decode(bytes)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "corrupt";
    return "ready";
  } catch {
    return "corrupt";
  }
}

type Format = "legacy" | "raw" | "gzip";
const FORMATS: Format[] = ["legacy", "raw", "gzip"];

/**
 * One prepared artifact's JSON sealed in each stored format. `raw` is the
 * writer the stores call; `legacy` and `gzip` are built here from the
 * credential helper and from zlib plus WebCrypto, because no store writes
 * either any more and a reader test must not depend on a writer to exist.
 */
async function seal(format: Format, json: string, key?: CryptoKey): Promise<Uint8Array> {
  const k = key ?? (await deriveKey(SECRET));
  if (format === "legacy") return legacySeal(k, json);
  if (format === "raw") return (await sealArtifact(k, json)).bytes;
  const plain = new TextEncoder().encode(json);
  const payload = new Uint8Array(gzipSync(plain));
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode("OGBA"));
  header[4] = 1;
  header[5] = 1;
  new DataView(header.buffer).setUint32(6, plain.length, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
      k,
      payload,
    ),
  );
  const out = new Uint8Array(header.length + iv.length + sealed.length);
  out.set(header, 0);
  out.set(iv, header.length);
  out.set(sealed, header.length + iv.length);
  return out;
}

/** What every release before this one wrote: the credential string, UTF-8 encoded. */
async function legacySeal(key: CryptoKey, json: string): Promise<Uint8Array> {
  return new TextEncoder().encode(await encrypt(key, json));
}

const KEY_CANARY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A body with every property an envelope must carry through: prose that gzip
 * can shrink, a key to be masked, truncation flags set by the capture layer,
 * and a streamed attempt.
 */
function rich(requestId: string, overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  const prose = "the quick brown fox jumps over the lazy dog and keeps going. ".repeat(80);
  return artifact({
    requestId,
    client: {
      request: { prompt: prose, api_key: KEY_CANARY },
      response: { text: prose },
      truncated: true,
    },
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-opus-4-1-20250805", system: prose },
        response: { stop_reason: "end_turn" },
        streamChunks: ["event: message_start", "event: message_stop"],
        truncated: true,
      },
    ],
    ...overrides,
  });
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

  // The writer's format is a contract with every reader of the corpus, so it is
  // pinned where the bytes land — the file on SQLite, the column on Postgres —
  // rather than on the sealing function either store happens to call.
  test("put writes the binary raw envelope on every store", async () => {
    const s = await backend.fresh();
    // Compressible prose well past a kilobyte, so a writer that tried gzip
    // would take it and the codec byte would say so.
    const input = rich("req_writer_format");
    const n = Buffer.byteLength(prepareArtifact(input).json);
    const row = await s.bodies.put(input);
    const bytes = await stored(backend, s, input.requestId, row.relPath ?? "");

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("OGBA");
    expect([bytes[4], bytes[5]]).toEqual([1, 0]);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, false)).toBe(n);
    expect(bytes.length).toBe(n + 38);
    expect(row.sizeBytes).toBe(bytes.length);
    expect(row.sha256).toBe(await sha256Hex(bytes));
  });

  /**
   * The rollout rehearsed on one corpus: rows from the legacy writer, rows from
   * this release's `put`, and a row from a rollback to v0.13.5, which writes
   * legacy again. Every row must open under the current reader; a reader from
   * before v0.13.5 must open the legacy rows and call the binary ones `corrupt`,
   * which is why rolling back below v0.13.5 is unsafe while any binary row
   * remains; and the `corrupt` such a reader records must not outlive it.
   */
  test("a mixed corpus survives the rollout, and only a dual reader opens all of it", async () => {
    const s = await backend.fresh();
    const key = await deriveKey(SECRET);
    const writeLegacy = async (input: BodyArtifact): Promise<void> => {
      const row = await s.bodies.put(input);
      const bytes = await legacySeal(key, prepareArtifact(input).json);
      await plant(backend, s, input.requestId, row.relPath ?? "", bytes);
    };

    const before = rich("req_rehearse_legacy");
    await writeLegacy(before);
    const binary = [rich("req_rehearse_binary"), artifact({ requestId: "req_rehearse_small" })];
    for (const input of binary) await s.bodies.put(input);
    const rolledBack = rich("req_rehearse_rollback");
    await writeLegacy(rolledBack);
    const corpus = [before, ...binary, rolledBack];

    for (const input of corpus) {
      const read = await s.bodies.get(input.requestId);
      expect(`${input.requestId}: ${read?.row.detailState}`).toBe(`${input.requestId}: ready`);
      expect(read?.artifact).toEqual(prepareArtifact(input).artifact);
    }

    // The old reader over the same stored bytes and digests, recording its
    // verdict on the row as its own repository did.
    const isBinary = new Set(binary.map((input) => input.requestId));
    for (const input of corpus) {
      const id = input.requestId;
      const row = (await s.bodies.get(id))?.row;
      const bytes = await stored(backend, s, id, row?.relPath ?? "");
      const verdict = await preDualRead(key, bytes, row?.sha256 ?? null);
      expect(`${id}: ${verdict}`).toBe(`${id}: ${isBinary.has(id) ? "corrupt" : "ready"}`);
      await setState(backend, s, id, verdict);
    }

    // A dual reader reading the row again hands it back and repairs the state.
    for (const input of binary) {
      const id = input.requestId;
      expect(await persistedState(backend, s, id)).toBe("corrupt");
      const read = await s.bodies.get(id);
      expect(read?.row.detailState).toBe("ready");
      expect(read?.artifact).toEqual(prepareArtifact(input).artifact);
      expect(await persistedState(backend, s, id)).toBe("ready");
    }
  });

  /**
   * `prepareArtifact` omits every body and then the error, and stops there: a
   * frame of a few thousand attempts is still over budget with nothing left in
   * it but markers. The writer refuses that plaintext, so `put` throws before
   * any byte or row is written — the gateway reports a failed capture and keeps
   * the request — rather than storing an envelope every reader calls `corrupt`.
   */
  test("an artifact over budget even once stripped is refused before anything is written", async () => {
    const s = await backend.fresh();
    const attempts = Array.from({ length: 2500 }, (_, i) => ({
      attempt: i + 1,
      provider: "anthropic",
      request: { prompt: "lorem ipsum dolor sit amet ".repeat(12) },
      response: null,
      streamChunks: null,
      truncated: false,
    }));
    const huge = (requestId: string): BodyArtifact => artifact({ requestId, attempts });
    const stripped = prepareArtifact(huge("req_huge"));
    expect(child(stripped.artifact.error, "omitted")).toBe(true);
    expect(Buffer.byteLength(stripped.json)).toBeGreaterThan(MAX_ARTIFACT_BYTES);

    await expect(s.bodies.put(huge("req_huge"))).rejects.toThrow(
      /outside the binary envelope's bounds/,
    );
    expect(await s.bodies.get("req_huge")).toBeNull();
    if (backend.name === "sqlite") {
      const path = join(bodiesDirFor(s.databasePath), relPathFor("req_huge", AT));
      await expect(readFile(path)).rejects.toThrow();
    }

    // A retry that is now over budget leaves the earlier write as it was.
    const first = rich("req_huge_retry");
    const row = await s.bodies.put(first);
    await expect(s.bodies.put(huge("req_huge_retry"))).rejects.toThrow();
    const read = await s.bodies.get("req_huge_retry");
    expect(read?.row).toEqual(row);
    expect(read?.artifact).toEqual(prepareArtifact(first).artifact);
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
    const sealed = await sealArtifact(await deriveKey(SECRET), prepared.json);
    await plant(backend, s, input.requestId, row.relPath ?? "", sealed.bytes);

    const read = await s.bodies.get(input.requestId);
    expect(read?.row.detailState).toBe("ready");
    expect(read?.artifact).toEqual(prepared.artifact);
  });

  test("each stored format reads back whole, with the metadata of the bytes as stored", async () => {
    const s = await backend.fresh();
    const sizes: Record<string, number> = {};
    const plains: Record<string, number> = {};
    for (const format of FORMATS) {
      const input = rich(`req_${format}`);
      const prepared = prepareArtifact(input);
      plains[format] = Buffer.byteLength(prepared.json);
      const row = await s.bodies.put(input);
      const bytes = await seal(format, prepared.json);
      sizes[format] = bytes.length;
      const magic = new TextDecoder().decode(bytes.slice(0, 4));
      if (format === "legacy") expect(new TextDecoder().decode(bytes.slice(0, 7))).toBe("enc:v1:");
      else expect([magic, bytes[5]]).toEqual(["OGBA", format === "raw" ? 0 : 1]);

      await plant(backend, s, input.requestId, row.relPath ?? "", bytes);
      const read = await s.bodies.get(input.requestId);
      expect(read?.row.detailState).toBe("ready");
      // The byte count and digest are the stored envelope's, not the plaintext's.
      expect(read?.row.sizeBytes).toBe(bytes.length);
      expect(read?.row.sha256).toBe(await sha256Hex(bytes));
      // Whole artifact, as the writer prepared it: masked, bounded, flags kept.
      expect(read?.artifact).toEqual(prepared.artifact);
      expect(JSON.stringify(read?.artifact)).not.toContain("abcdefghij");
      expect(child(read?.artifact?.client.request, "prompt")).toContain("quick brown fox");
      expect(read?.artifact?.client.truncated).toBe(true);
      expect(read?.artifact?.attempts[0]?.truncated).toBe(true);
      expect(read?.row.truncated).toBe(true);
    }
    // Raw binary carries 38 bytes of overhead against the legacy 2N + 65, and
    // gzip beats both on prose; the formats really are three different envelopes.
    expect(sizes.raw).toBe((plains.raw ?? 0) + 38);
    expect(sizes.legacy).toBe(2 * (plains.legacy ?? 0) + 65);
    expect(sizes.gzip).toBeLessThan((sizes.raw ?? 0) / 4);
  });

  test("an omitted artifact keeps its frame in every stored format", async () => {
    const s = await backend.fresh();
    const wide: Record<string, string> = {};
    for (let i = 0; i < 80; i++) wide[`k${i}`] = "lorem ipsum dolor sit amet ".repeat(400);
    const base = artifact({
      client: { request: wide, response: wide, truncated: false },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: wide,
          response: wide,
          streamChunks: null,
          truncated: false,
        },
      ],
    });
    const prepared = prepareArtifact(base);
    expect(child(prepared.artifact.client.request, "omitted")).toBe(true);
    for (const format of FORMATS) {
      const input = { ...base, requestId: `req_omit_${format}` };
      const row = await s.bodies.put(input);
      await plant(
        backend,
        s,
        input.requestId,
        row.relPath ?? "",
        await seal(format, prepareArtifact(input).json),
      );
      const read = await s.bodies.get(input.requestId);
      expect(read?.row.detailState).toBe("ready");
      expect(read?.artifact).toEqual(prepareArtifact(input).artifact);
      expect(child(read?.artifact?.client.request, "omitted")).toBe(true);
      expect(read?.artifact?.client.truncated).toBe(true);
      expect(read?.artifact?.attempts[0]?.provider).toBe("anthropic");
    }
  });

  test("an artifact near the budget is gzipped and read back whole", async () => {
    const s = await backend.fresh();
    // Distinct keys of prose, each inside the string budget, kept under the total.
    const prose: Record<string, string> = {};
    for (let i = 0; i < 30; i++)
      prose[`k${i}`] = `section ${i}: ${"lorem ipsum dolor ".repeat(900)}`;
    const input = artifact({ client: { request: prose, response: null, truncated: false } });
    const prepared = prepareArtifact(input);
    const plain = Buffer.byteLength(prepared.json);
    expect(plain).toBeGreaterThan(256 * 1024);
    expect(plain).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    expect(child(prepared.artifact.client.request, "omitted")).toBeUndefined();

    const row = await s.bodies.put(input);
    const bytes = await seal("gzip", prepared.json);
    expect(bytes[5]).toBe(1);
    expect(bytes.length).toBeLessThan(plain / 10);
    await plant(backend, s, input.requestId, row.relPath ?? "", bytes);
    const read = await s.bodies.get(input.requestId);
    expect(read?.row.detailState).toBe("ready");
    expect(read?.row.sizeBytes).toBe(bytes.length);
    expect(read?.artifact).toEqual(prepared.artifact);
  });

  test("a retried write replaces the bytes whatever format held them", async () => {
    const s = await backend.fresh();
    const id = "req_upsert";
    const first = rich(id);
    const row = await s.bodies.put(first);
    for (const format of ["gzip", "raw"] as const) {
      await plant(
        backend,
        s,
        id,
        row.relPath ?? "",
        await seal(format, prepareArtifact(first).json),
      );
      expect((await s.bodies.get(id))?.row.detailState).toBe("ready");

      const second = rich(id, {
        client: { request: { after: format }, response: null, truncated: false },
      });
      const again = await s.bodies.put(second);
      expect(again.relPath).toBe(row.relPath);
      const read = await s.bodies.get(id);
      expect(read?.row).toEqual(again);
      expect(read?.row.detailState).toBe("ready");
      expect(read?.artifact).toEqual(prepareArtifact(second).artifact);
      // The row describes the bytes now stored, not the ones it replaced.
      const now = await stored(backend, s, id, row.relPath ?? "");
      expect(read?.row.sizeBytes).toBe(now.length);
      expect(read?.row.sha256).toBe(await sha256Hex(now));
    }
  });

  test("damaged binary envelopes are corrupt and repair restores them", async () => {
    const s = await backend.fresh();
    const key = await deriveKey(SECRET);
    const other = await deriveKey("another-secret-entirely-0123456789");
    const state = async (id: string): Promise<string | undefined> =>
      (await s.bodies.get(id))?.row.detailState;
    for (const format of ["raw", "gzip"] as const) {
      const input = rich(`req_damage_${format}`);
      const id = input.requestId;
      const row = await s.bodies.put(input);
      const rel = row.relPath ?? "";
      const good = await seal(format, prepareArtifact(input).json, key);
      const flip = (at: number): Uint8Array => {
        const bad = good.slice();
        bad[at] = (bad[at] ?? 0) ^ 0xff;
        return bad;
      };
      const damaged: [string, Uint8Array][] = [
        ["flipped version", flip(4)],
        ["flipped codec", flip(5)],
        ["flipped length", flip(9)],
        ["flipped iv", flip(12)],
        ["flipped ciphertext", flip(30)],
        ["flipped tag", flip(good.length - 1)],
        ["short by a byte", good.slice(0, -1)],
        ["trailing byte", new Uint8Array([...good, 0])],
        ["header alone", good.slice(0, 10)],
        ["sealed under another key", await seal(format, prepareArtifact(input).json, other)],
      ];

      await plant(backend, s, id, rel, good);
      expect(await state(id)).toBe("ready");
      for (const [name, bytes] of damaged) {
        // With an honest digest only GCM and the header can refuse it; with none
        // at all, the same.
        for (const digest of [undefined, null]) {
          await plant(backend, s, id, rel, bytes, digest);
          expect(`${format} ${name}: ${await state(id)}`).toBe(`${format} ${name}: corrupt`);
          await plant(backend, s, id, rel, good);
          expect(`${format} ${name}: ${await state(id)}`).toBe(`${format} ${name}: ready`);
        }
      }

      // Good bytes under a digest that is not theirs: the row is what lies.
      await plant(backend, s, id, rel, good, "0".repeat(64));
      expect(await state(id)).toBe("corrupt");
      // A missing digest is not evidence of damage when GCM verifies.
      await plant(backend, s, id, rel, good, null);
      expect(await state(id)).toBe("ready");

      // Absent, then back: both transitions are recoverable and the artifact
      // is whole again afterwards.
      await plant(backend, s, id, rel, null);
      expect(await state(id)).toBe("missing");
      await plant(backend, s, id, rel, good);
      const repaired = await s.bodies.get(id);
      expect(repaired?.row.detailState).toBe("ready");
      expect(repaired?.artifact).toEqual(prepareArtifact(input).artifact);
    }
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

    // Byte compatibility, not a migration tool: the same opaque envelope is
    // planted into a SQLite file and a Postgres bytea under one derived key,
    // and each store opens what the other wrote.
    test("an envelope written by one backend opens on the other, in both directions", async () => {
      const pg = await backend.fresh();
      const root = join(tmpdir(), `omni-contract-cross-${crypto.randomUUID()}`);
      await mkdir(root, { recursive: true });
      const lite = await createStore({
        path: join(root, "omnigateway.db"),
        encryptionKey: await deriveKey(SECRET),
      });
      const sqlite = { name: "sqlite" } as const;
      try {
        const stores = { sqlite: { s: lite, b: sqlite }, postgres: { s: pg, b: backend } };
        for (const [from, to] of [
          ["sqlite", "postgres"],
          ["postgres", "sqlite"],
        ] as const) {
          for (const format of FORMATS) {
            const input = rich(`req_cross_${from}_${format}`);
            const prepared = prepareArtifact(input);
            const source = stores[from];
            const dest = stores[to];
            const sourceRow = await source.s.bodies.put(input);
            await plant(
              source.b,
              source.s,
              input.requestId,
              sourceRow.relPath ?? "",
              await seal(format, prepared.json),
            );
            const opaque = await stored(
              source.b,
              source.s,
              input.requestId,
              sourceRow.relPath ?? "",
            );

            const destRow = await dest.s.bodies.put(input);
            expect(destRow.relPath).toBe(sourceRow.relPath);
            await plant(dest.b, dest.s, input.requestId, destRow.relPath ?? "", opaque);

            const there = await dest.s.bodies.get(input.requestId);
            const label = `${from} to ${to} ${format}`;
            expect(`${label}: ${there?.row.detailState}`).toBe(`${label}: ready`);
            expect(there?.artifact).toEqual(prepared.artifact);
            expect(await stored(dest.b, dest.s, input.requestId, destRow.relPath ?? "")).toEqual(
              opaque,
            );
            const back = await source.s.bodies.get(input.requestId);
            expect(there?.row.sizeBytes).toBe(back?.row.sizeBytes ?? -1);
            expect(there?.row.sha256).toBe(back?.row.sha256 ?? "missing");
          }
        }
      } finally {
        lite.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
