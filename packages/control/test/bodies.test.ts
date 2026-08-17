import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BodyArtifact, createStore, deriveKey, type Store } from "@omni/store";
import { readRequestBody } from "../src/bodies.ts";

const AT = Date.UTC(2026, 7, 17, 12, 0, 0);
const REQUEST_ID = "req_11111111-2222-4333-8444-555555555555";

/**
 * Where the artifact for `AT` lands, spelled out rather than imported.
 *
 * The shard layout is UTC and is part of what an operator relies on when they
 * purge a day by hand, so a test that reaches through the store's own helper
 * would agree with any layout at all.
 */
const REL_PATH = `2026/08/17/${REQUEST_ID}.json.enc`;

/**
 * A store on disk, because the artifact tree is derived from the database path
 * and an in-memory database has nowhere to put one.
 */
async function tempStore(): Promise<{ store: Store; root: string; dir: string }> {
  const root = join(tmpdir(), `omni-control-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  return { store, root, dir: join(root, "request_bodies") };
}

async function cleanup(store: Store, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

function artifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    at: AT,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-haiku-4-5" },
        response: { ok: true },
        streamChunks: null,
        truncated: false,
      },
    ],
    error: null,
    ...overrides,
  };
}

test("a captured request reads back as its artifact", async () => {
  const { store, root } = await tempStore();
  try {
    await store.bodies.put(artifact());

    const read = await readRequestBody(store, REQUEST_ID);
    expect(read.detailState).toBe("ready");
    expect(read.at).toBe(AT);
    expect(read.sizeBytes).toBeGreaterThan(0);
    expect(read.artifact?.client.request).toEqual({ model: "fast" });
    expect(read.artifact?.attempts[0]?.provider).toBe("anthropic");
  } finally {
    await cleanup(store, root);
  }
});

/**
 * Capture is off by default, so "no row" is the ordinary answer for nearly every
 * request on nearly every installation. Reporting it as an error would make the
 * ordinary case look broken.
 */
test("a request that was never captured reads as none rather than failing", async () => {
  const { store, root } = await tempStore();
  try {
    const read = await readRequestBody(store, "req_never-captured");
    expect(read.detailState).toBe("none");
    expect(read.artifact).toBeNull();
    expect(read.at).toBeNull();
    expect(read.sizeBytes).toBe(0);
  } finally {
    await cleanup(store, root);
  }
});

test("a row whose artifact was deleted underneath it reads as missing", async () => {
  const { store, root, dir } = await tempStore();
  try {
    await store.bodies.put(artifact());
    await rm(join(dir, REL_PATH));

    const read = await readRequestBody(store, REQUEST_ID);
    expect(read.detailState).toBe("missing");
    expect(read.artifact).toBeNull();
    // The metadata survives the artifact: an operator still learns that this
    // request was captured and roughly how large it was.
    expect(read.at).toBe(AT);
    expect(read.sizeBytes).toBeGreaterThan(0);
  } finally {
    await cleanup(store, root);
  }
});

test("a row whose artifact no longer decrypts reads as corrupt", async () => {
  const { store, root, dir } = await tempStore();
  try {
    await store.bodies.put(artifact());
    await writeFile(join(dir, REL_PATH), "not the ciphertext that was written");

    const read = await readRequestBody(store, REQUEST_ID);
    expect(read.detailState).toBe("corrupt");
    expect(read.artifact).toBeNull();
  } finally {
    await cleanup(store, root);
  }
});

/**
 * The read is what a route serves, so it must not carry the layout of the
 * artifact tree. A path or a digest quoted back in a console — or in an error
 * page built from one — tells a reader where the prompt corpus lives.
 */
test("the read describes the artifact without naming where it is kept", async () => {
  const { store, root } = await tempStore();
  try {
    await store.bodies.put(artifact());
    const read = await readRequestBody(store, REQUEST_ID);

    expect(read).not.toHaveProperty("relPath");
    expect(read).not.toHaveProperty("sha256");
    expect(JSON.stringify(read)).not.toContain("request_bodies");
    expect(JSON.stringify(read)).not.toContain(root);
  } finally {
    await cleanup(store, root);
  }
});

test("a bounded artifact carries its truncation forward to the reader", async () => {
  const { store, root } = await tempStore();
  try {
    await store.bodies.put(
      artifact({
        client: { request: { model: "fast" }, response: null, truncated: true },
      }),
    );

    const read = await readRequestBody(store, REQUEST_ID);
    expect(read.truncated).toBe(true);
    expect(read.artifact?.client.truncated).toBe(true);
  } finally {
    await cleanup(store, root);
  }
});
