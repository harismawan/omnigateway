import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeArtifact,
  MAX_ARTIFACT_BYTES,
  MAX_ENVELOPE_BYTES,
  prepareArtifact,
} from "../../src/bodies/artifact.ts";
import { maskSecrets } from "../../src/bodies/mask.ts";
import { deriveKey } from "../../src/encryption.ts";
import type { BodyArtifact, BodyOmission } from "../../src/types.ts";

const AT = Date.UTC(2026, 7, 17, 12, 0, 0);
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const key = deriveKey("test-secret-value-for-unit-tests");

function artifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: "req_limits",
    at: AT,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
    ...overrides,
  };
}

/**
 * Prose no masking rule touches: every run of token characters is short, so
 * what survives is the payload rather than an elision of it.
 */
function prose(bytes: number): string {
  return "the quick brown fox jumps over the lazy dog "
    .repeat(Math.ceil(bytes / 44))
    .slice(0, bytes);
}

/** `depth` containers, each holding the next, with `leaf` at the bottom. */
function nested(depth: number, kind: "array" | "object", leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = kind === "array" ? [value] : { next: value };
  return value;
}

/** Walks down a `nested` value without recursion, returning its depth and leaf. */
function bottom(value: unknown): { depth: number; leaf: unknown } {
  let depth = 0;
  let at = value;
  for (;;) {
    if (Array.isArray(at)) at = at[0];
    else if (at !== null && typeof at === "object" && "next" in at) at = at.next;
    else return { depth, leaf: at };
    depth += 1;
  }
}

// ---------------------------------------------------------------------------
// The ceilings, stated as the formulas the spec gives them.
// ---------------------------------------------------------------------------

test("the artifact budget is 64 MiB and the envelope ceiling follows it", () => {
  expect(MAX_ARTIFACT_BYTES).toBe(67_108_864);
  // Legacy hex is exactly 2N + 65 bytes around N of plaintext; the binary
  // ceiling (N + 38) and gunzip's output bound are pinned by behaviour in
  // `bodies.test.ts`, and the Postgres filter in the contract suite.
  expect(MAX_ENVELOPE_BYTES).toBe(2 * MAX_ARTIFACT_BYTES + 65);
});

// ---------------------------------------------------------------------------
// Stack-safe masking.
// ---------------------------------------------------------------------------

test("masking walks 100,000-deep arrays and objects without overflowing", () => {
  for (const kind of ["array", "object"] as const) {
    const masked = maskSecrets(nested(100_000, kind, `key ${SECRET} here`));
    const seen = bottom(masked);
    expect(`${kind}: ${seen.depth}`).toBe(`${kind}: 100000`);
    expect(seen.leaf).toBe("key sk-[redacted] here");
  }
});

test("masking copies structure, masks every string, and leaves keys and scalars alone", () => {
  const shared = { token: SECRET };
  const input: unknown = JSON.parse(
    `{"__proto__":{"polluted":"${SECRET}"},"list":[1,null,true,"${SECRET}",[["${SECRET}"]]],"${SECRET}":2.5}`,
  );
  const masked = maskSecrets(input) as Record<string, unknown>;

  expect(JSON.stringify(masked)).toBe(
    `{"__proto__":{"polluted":"sk-[redacted]"},"list":[1,null,true,"sk-[redacted]",[["sk-[redacted]"]]],"${SECRET}":2.5}`,
  );
  // An own `__proto__` key stays a key rather than becoming the prototype.
  expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  // The input is never written to.
  expect(JSON.stringify(input)).toContain(SECRET);

  // A value reached twice is masked on both paths.
  expect(maskSecrets({ a: shared, b: [shared] })).toEqual({
    a: { token: "sk-[redacted]" },
    b: [{ token: "sk-[redacted]" }],
  });
  for (const scalar of [null, undefined, 0, 42, true, false]) {
    expect(maskSecrets(scalar)).toBe(scalar);
  }
  expect(maskSecrets(SECRET)).toBe("sk-[redacted]");
});

// ---------------------------------------------------------------------------
// No structural bounding: a body is stored whole or omitted whole.
// ---------------------------------------------------------------------------

test("a 100 KiB string, a 500-item array, deep nesting and wide objects survive whole", () => {
  const long = prose(100 * 1024);
  const messages = Array.from({ length: 500 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
  const wide: Record<string, number> = {};
  for (let i = 0; i < 200; i++) wide[`k${i}`] = i;
  const deep = nested(50, "object", "leaf");
  const request = { prompt: long, messages, wide, deep };
  const chunks = Array.from({ length: 300 }, (_, i) => `event: delta\ndata: ${i}`);

  const prepared = prepareArtifact(
    artifact({
      client: { request, response: { text: long }, truncated: false },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request,
          response: null,
          streamChunks: chunks,
          truncated: false,
        },
      ],
      error: { detail: long },
    }),
  );

  // Compared as serialized text, so a failure reports which part was cut rather
  // than printing a hundred kilobytes of diff.
  const parsed = JSON.parse(prepared.json) as BodyArtifact;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  expect({
    clientRequest: same(parsed.client.request, request),
    clientResponse: same(parsed.client.response, { text: long }),
    attemptRequest: same(parsed.attempts[0]?.request, request),
    streamChunks: same(parsed.attempts[0]?.streamChunks, chunks),
    error: same(parsed.error, { detail: long }),
  }).toEqual({
    clientRequest: true,
    clientResponse: true,
    attemptRequest: true,
    streamChunks: true,
    error: true,
  });
  // Nothing was cut, so nothing claims to have been.
  expect(prepared.artifact.client.truncated).toBe(false);
  expect(prepared.artifact.attempts[0]?.truncated).toBe(false);
});

// Native serialization takes about a second to overflow its stack however deep
// the input is past that point, and the two tests below reach the `RangeError`
// once and twice, so each is given room for it.
test("a native serialization RangeError records the bodies as nesting too deep", () => {
  // Deep enough that `JSON.stringify` overflows however small the body is.
  const deep = nested(100_000, "array", "leaf");
  const prepared = prepareArtifact(
    artifact({
      client: { request: deep, response: { ok: true }, truncated: false },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: { model: "fast" },
          response: { ok: true },
          streamChunks: null,
          truncated: false,
        },
      ],
      error: { code: "UPSTREAM", status: 502 },
    }),
  );

  const marker: BodyOmission = { omitted: true, reason: "nesting too deep", serializedBytes: null };
  // Through the JSON, so a failure prints the small artifact written rather than
  // the hundred-thousand-level input.
  const written = JSON.parse(prepared.json) as BodyArtifact;
  expect(written.client).toEqual({ request: marker, response: marker, truncated: true });
  // The frame survives: which provider was tried, and what the request failed with.
  expect(written.attempts).toEqual([
    {
      attempt: 1,
      provider: "anthropic",
      request: marker,
      response: marker,
      streamChunks: null,
      truncated: true,
    },
  ]);
  expect(prepared.artifact.error).toEqual({ code: "UPSTREAM", status: 502 });
  expect(JSON.parse(prepared.json)).toEqual(prepared.artifact);
}, 10_000);

test("a too-deep error is omitted along with the bodies", () => {
  const prepared = prepareArtifact(artifact({ error: nested(100_000, "object", "leaf") }));
  const marker: BodyOmission = { omitted: true, reason: "nesting too deep", serializedBytes: null };
  expect(prepared.artifact.client.request).toEqual(marker);
  expect(prepared.artifact.error).toEqual(marker);
  expect(JSON.parse(prepared.json)).toEqual(prepared.artifact);
}, 10_000);

/** An artifact whose prepared JSON is exactly `bytes` long, padded in `client.request`. */
function sized(bytes: number): BodyArtifact {
  const empty = Buffer.byteLength(prepareArtifact(artifact({ client: pad("") })).json);
  return artifact({ client: pad(prose(bytes - empty)) });
}

function pad(request: string): BodyArtifact["client"] {
  return { request, response: null, truncated: false };
}

test("an artifact exactly at the budget is kept; one byte more is an omission", () => {
  const at = prepareArtifact(sized(MAX_ARTIFACT_BYTES));
  expect(Buffer.byteLength(at.json)).toBe(MAX_ARTIFACT_BYTES);
  expect(typeof at.artifact.client.request).toBe("string");

  const past = prepareArtifact(
    artifact({
      ...sized(MAX_ARTIFACT_BYTES + 1),
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: null,
          response: null,
          streamChunks: ["event: ping"],
          truncated: false,
        },
      ],
    }),
  );
  const marker = past.artifact.client.request as BodyOmission;
  expect(marker.omitted).toBe(true);
  expect(marker.reason).toBe(`artifact exceeded ${MAX_ARTIFACT_BYTES} bytes`);
  // The size of what would have been written, so the operator can see by how much.
  expect(marker.serializedBytes).toBeGreaterThan(MAX_ARTIFACT_BYTES);
  expect(past.artifact.client.truncated).toBe(true);
  expect(past.artifact.attempts[0]?.provider).toBe("anthropic");
  expect(past.artifact.attempts[0]?.streamChunks).toBeNull();
  expect(Buffer.byteLength(past.json)).toBeLessThan(1024);
  expect(JSON.parse(past.json)).toEqual(past.artifact);
});

test("a frame still over budget with every body omitted is refused, not written oversized", () => {
  // The frame is what omission keeps, so a frame past the budget on its own is
  // the one input every marker cannot rescue. Unreachable from the gateway,
  // which names providers from its own registry; the re-check is what keeps
  // `prepareArtifact` from ever returning JSON a reader would refuse.
  const frame = artifact({
    attempts: [
      {
        attempt: 1,
        provider: "p".repeat(MAX_ARTIFACT_BYTES),
        request: null,
        response: null,
        streamChunks: null,
        truncated: false,
      },
    ],
    error: { code: "UPSTREAM" },
  });
  let thrown: unknown;
  try {
    prepareArtifact(frame);
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof Error ? thrown.message : thrown).toBe(
    `artifact exceeded ${MAX_ARTIFACT_BYTES} bytes with every body omitted`,
  );
});

test("a cyclic value is masked without looping and is refused when serialized", () => {
  // Not JSON-shaped, so never captured from the wire; the walk must still end
  // rather than spin, and the refusal is the serializer's, as it always was.
  const cyclic: Record<string, unknown> = { token: SECRET };
  cyclic.self = cyclic;
  const masked = maskSecrets(cyclic) as Record<string, unknown>;
  expect(masked.token).toBe("sk-[redacted]");
  expect(masked.self).toBe(masked);
  expect(() => prepareArtifact(artifact({ error: cyclic }))).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// Legacy: artifacts written under the 512 KiB cap, by the writer and reader of
// that era. The fixtures are checked in, sealed under the test key, so nothing
// here can regenerate them with today's code.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "../fixtures/bodies");

type Manifest = Record<string, { sha256: string; artifact: BodyArtifact }>;

test("512 KiB-era envelopes still decode, each to the artifact it was written from", async () => {
  const manifest = JSON.parse(await readFile(join(FIXTURES, "manifest.json"), "utf8")) as Manifest;
  const names = Object.keys(manifest).sort();
  expect(names).toEqual([
    "binary-gzip.json.enc",
    "binary-raw-omitted.json.enc",
    "binary-raw.json.enc",
    "legacy-hex-omitted.json.enc",
    "legacy-hex.json.enc",
  ]);

  for (const name of names) {
    const entry = manifest[name];
    if (entry === undefined) throw new Error(name);
    const bytes = new Uint8Array(await readFile(join(FIXTURES, name)));
    for (const digest of [entry.sha256, null]) {
      const read = await decodeArtifact(await key, bytes, digest);
      expect(`${name}: ${read.ok}`).toBe(`${name}: true`);
      if (read.ok) expect(read.artifact).toEqual(entry.artifact);
    }
  }
});

test("a 512 KiB-era omission marker decodes as itself, whatever its reason says", async () => {
  for (const name of ["legacy-hex-omitted.json.enc", "binary-raw-omitted.json.enc"]) {
    const bytes = new Uint8Array(await readFile(join(FIXTURES, name)));
    const read = await decodeArtifact(await key, bytes, null);
    if (!read.ok) throw new Error(`${name} did not decode`);
    const marker = read.artifact.client.request as BodyOmission;
    // The old reason, which no longer matches the one written today: nothing
    // that reads a marker may depend on its text.
    expect(marker).toEqual({
      omitted: true,
      reason: "artifact exceeded 524288 bytes after structural bounding",
      serializedBytes: marker.serializedBytes,
    });
    expect(marker.serializedBytes).toBeGreaterThan(524_288);
    expect(read.artifact.client.truncated).toBe(true);
    expect(read.artifact.attempts[0]?.provider).toBe("anthropic");
  }
});

test("an old artifact keeps the cuts structural bounding made when it was written", async () => {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, "binary-raw.json.enc")));
  const read = await decodeArtifact(await key, bytes, null);
  if (!read.ok) throw new Error("fixture did not decode");
  const request = read.artifact.client.request as { messages: unknown[]; deep: unknown };
  // Thirty turns were sent; the old bound kept the last twenty-four.
  expect(request.messages).toHaveLength(24);
  expect(JSON.stringify(request.deep)).toContain("[omitted: nesting past 6 levels]");
});

// ---------------------------------------------------------------------------
// The read ceiling keeps its meaning at the new size.
// ---------------------------------------------------------------------------

/** Decodes with crypto watched, so a refusal can be placed before or after the digest. */
async function watched(
  bytes: Uint8Array,
  expected: string | null,
): Promise<{ ok: boolean; digests: number; decrypts: number }> {
  const k = await key;
  const digest = spyOn(crypto.subtle, "digest");
  const decrypt = spyOn(crypto.subtle, "decrypt");
  try {
    const read = await decodeArtifact(k, bytes, expected);
    return { ok: read.ok, digests: digest.mock.calls.length, decrypts: decrypt.mock.calls.length };
  } finally {
    digest.mockRestore();
    decrypt.mockRestore();
  }
}

/**
 * A legacy envelope of exactly `length` bytes, well formed in every way the
 * reader checks before the digest: `enc:v1:`, a 24-hex IV, even-length body
 * hex, a 32-hex tag. Zeros rather than ciphertext, so it costs one fill.
 */
function legacyShaped(length: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(0x30);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode("enc:v1:"), 0);
  bytes[7 + 24] = 0x3a;
  bytes[length - 33] = 0x3a;
  return bytes;
}

test("a legacy envelope at the ceiling is taken as far as its digest; one byte more is not", async () => {
  // A wrong digest stops it before decryption, which at this size the old
  // credential helper takes seconds over; what is shown is that the size and
  // shape checks let it through.
  const at = legacyShaped(MAX_ENVELOPE_BYTES);
  expect(await watched(at, "0".repeat(64))).toEqual({ ok: false, digests: 1, decrypts: 0 });

  const past = legacyShaped(MAX_ENVELOPE_BYTES + 2);
  expect(await watched(past, "0".repeat(64))).toEqual({ ok: false, digests: 0, decrypts: 0 });
  expect(await watched(past.subarray(0, MAX_ENVELOPE_BYTES + 1), null)).toEqual({
    ok: false,
    digests: 0,
    decrypts: 0,
  });
});
