import type { Dirent } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { decrypt } from "../encryption.ts";
import type { BodyArtifact, BodyAttempt } from "../types.ts";
import { boundValue } from "./bound.ts";
import { maskSecrets, maskString } from "./mask.ts";

/**
 * Present from the first release rather than added once the shape changes.
 * OmniRoute is on its fifth revision of an artifact of this kind, so a reader
 * that has to cope with more than one shape is a certainty, not a hypothetical.
 */
export const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * The ceiling on one serialized artifact, applied after structural bounding.
 *
 * Bounding is per-value, so a payload can respect every one of its limits and
 * still be enormous in aggregate — eighty keys of sixty-four kilobytes each is
 * five megabytes of valid, bounded JSON. Past this the bodies are replaced by a
 * marker that records why, which is neither writing it oversized nor dropping it
 * without a trace.
 */
export const MAX_ARTIFACT_BYTES = 512 * 1024;

/**
 * The row cap, which is what actually bounds disk.
 *
 * The retention window is what an operator reasons about, and it bounds nothing:
 * at sustained load a week of full traffic is unbounded in practice. This is the
 * backstop that keeps a busy week from filling the disk.
 */
export const BODY_ROW_CAP = 100_000;

/** Sits beside the database file, so one directory is the whole installation. */
export const BODIES_DIRNAME = "request_bodies";

/**
 * What replaces the bodies of an artifact too large to store.
 *
 * A marker rather than silence: an operator looking at an incident needs to know
 * the difference between "capture was off" and "capture ran and this was too big
 * to keep", and those are the same absence otherwise.
 */
export type BodyOmission = {
  omitted: true;
  reason: string;
  serializedBytes: number;
};

const encoder = new TextEncoder();

export function bodiesDirFor(databasePath: string): string {
  return join(dirname(databasePath), BODIES_DIRNAME);
}

/**
 * The character set a request id may use, because it becomes a path segment.
 *
 * The gateway mints `req_<uuid>`, but the id reaches here as data and a hostile
 * one containing `..` or a separator would write outside the shard directory.
 * Validating the id is cheaper and more obviously correct than sanitising it:
 * there is no legitimate id this rejects.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeRequestId(id: string): boolean {
  return SAFE_REQUEST_ID.test(id);
}

/**
 * `YYYY/MM/DD/<requestId>.json.enc`, in UTC.
 *
 * UTC rather than local time because a shard path is a durable name: local
 * midnight moves twice a year, and a DST fold would put two different days'
 * artifacts in one directory while leaving another empty. The date only has to
 * shard evenly and let a whole day be purged as a unit, and it does both without
 * agreeing with the operator's calendar.
 */
export function relPathFor(requestId: string, at: number): string {
  const date = new Date(at);
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}/${requestId}.json.enc`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied into a buffer of its own because `digest` will not accept a view
  // over a possibly-shared one. The digest is over the same bytes either way,
  // and this runs twice per artifact rather than per byte of traffic.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `truncated` is an OR, never a recomputation.
 *
 * Bounding is one of two independent ways a body ends up incomplete, and it is
 * the only one visible from here. The other is the capture layer's: a client
 * that hung up mid-stream, a drain that ended on a source error, a response
 * past the byte cap. Those are facts the gateway knows and this function cannot
 * observe — a payload truncated by a disconnect is structurally unremarkable, so
 * deriving the flag from the value alone reports it as complete.
 *
 * An earlier version took only `{request, response}`, which silently discarded
 * the incoming flag and made every gateway-side truncation unrecordable.
 */
function bodyPair(pair: { request: unknown; response: unknown; truncated?: boolean }): {
  request: unknown;
  response: unknown;
  truncated: boolean;
} {
  const request = boundValue(maskSecrets(pair.request));
  const response = boundValue(maskSecrets(pair.response));
  return {
    request: request.value,
    response: response.value,
    truncated: pair.truncated === true || request.truncated || response.truncated,
  };
}

function omission(serializedBytes: number): BodyOmission {
  return {
    omitted: true,
    reason: `artifact exceeded ${MAX_ARTIFACT_BYTES} bytes after structural bounding`,
    serializedBytes,
  };
}

/**
 * Replaces every body with the marker, keeping the frame.
 *
 * The attempt list, its order, and its providers are what make an artifact a
 * story rather than a blob, and they cost nothing to keep. What goes is only the
 * payloads that made it too large. The error survives here because it is the one
 * field an operator opening an oversized artifact is most likely to be after.
 */
function omitBodies(artifact: BodyArtifact, marker: BodyOmission): BodyArtifact {
  return {
    ...artifact,
    client: { request: marker, response: marker, truncated: true },
    attempts: artifact.attempts.map(
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

/**
 * Masks, bounds, and if necessary omits — the whole of what has to happen to a
 * body before it may be written.
 *
 * Masking runs before bounding on purpose. Bounding truncates strings, and a
 * secret cut in half is a secret that may no longer match the rule that would
 * have caught it whole.
 *
 * Pure, so the bounds can be tested without a filesystem, and separate from the
 * repository so there is one place to look when asking what a stored artifact
 * has had done to it.
 */
export function prepareArtifact(input: BodyArtifact): { artifact: BodyArtifact; json: string } {
  const client = bodyPair(input.client);
  const attempts = input.attempts.map((attempt): BodyAttempt => {
    const pair = bodyPair(attempt);
    // Frames are strings by their type, and bounding an array of strings yields
    // an array of strings: the array is trimmed to its last frames and each
    // frame to its own byte budget. The assertion restates that, and is the only
    // place `boundValue`'s `unknown` result is narrowed by construction.
    const chunks =
      attempt.streamChunks === null ? null : boundValue(attempt.streamChunks.map(maskString));
    return {
      attempt: attempt.attempt,
      provider: attempt.provider,
      request: pair.request,
      response: pair.response,
      streamChunks: chunks === null ? null : (chunks.value as string[]),
      truncated: pair.truncated || (chunks?.truncated ?? false),
    };
  });
  const error = boundValue(maskSecrets(input.error));

  const bounded: BodyArtifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    requestId: input.requestId,
    at: input.at,
    client,
    attempts,
    error: error.value,
  };

  const json = JSON.stringify(bounded);
  // `byteLength` measures without materialising the bytes: `encoder.encode`
  // allocated a whole second copy of a body that is already at the budget.
  const size = Buffer.byteLength(json);
  if (size <= MAX_ARTIFACT_BYTES) return { artifact: bounded, json };

  const marker = omission(size);
  const omitted = omitBodies(bounded, marker);
  const omittedJson = JSON.stringify(omitted);
  if (Buffer.byteLength(omittedJson) <= MAX_ARTIFACT_BYTES) {
    return { artifact: omitted, json: omittedJson };
  }

  // The error was worth keeping right up until it was the thing over the
  // budget. "Never written oversized" is the stronger promise of the two.
  const stripped: BodyArtifact = { ...omitted, error: marker };
  return { artifact: stripped, json: JSON.stringify(stripped) };
}

/**
 * The largest stored envelope any reader will acquire: a legacy envelope around
 * one full artifact budget, `enc:v1:` hex being exactly `2N + 65` bytes.
 *
 * A ceiling on what a supported writer produced, not on what the format can
 * express. Past it the bytes are `corrupt` — present, and not to be read — and
 * are left where they are, so a later release can relax it and the ordinary
 * corrupt-to-ready recovery hands them back. Exported for the Postgres repo,
 * which has to apply it in SQL before the column leaves the server.
 */
export const MAX_ENVELOPE_BYTES = 2 * MAX_ARTIFACT_BYTES + 65;

const BINARY_MAGIC = encoder.encode("OGBA");
const LEGACY_PREFIX = encoder.encode("enc:v1:");

/**
 * Version 1 fixes everything the header does not say: AES-256-GCM, a 12-byte IV,
 * a 16-byte tag, UTF-8 JSON, and the codec numbering below. Changing any of them
 * is a new version, never something inferred from the payload.
 */
const BINARY_VERSION = 1;
/** Magic, version, codec, and claimed length — and GCM's additional data. */
const BINARY_HEADER_BYTES = 10;
const BINARY_IV_BYTES = 12;
const BINARY_TAG_BYTES = 16;
const BINARY_OVERHEAD = BINARY_HEADER_BYTES + BINARY_IV_BYTES + BINARY_TAG_BYTES;
const MAX_BINARY_ENVELOPE_BYTES = MAX_ARTIFACT_BYTES + BINARY_OVERHEAD;

/** Plaintext stored as it is. */
const CODEC_RAW = 0;
/** Plaintext as a gzip stream (RFC 1952), compressed before it is encrypted. */
const CODEC_GZIP = 1;

/**
 * The gzip policy the benchmark measured against raw, and which no store writes:
 * at the 512 KiB cap it cost more seal latency than its budget allowed
 * (docs/superpowers/plans/2026-10-10-body-artifact-storage-benchmark.md). Below
 * the cutoff gzip is not tried, since its header and footer eat most of what a
 * small body could save. Level 1 is the cheapest native setting. A saving under
 * the minimum is not worth a decompression on every read.
 */
const GZIP_MIN_PLAINTEXT_BYTES = 1024;
const GZIP_LEVEL = 1;
const GZIP_MIN_SAVING_BYTES = 64;
/** A gzip member's fixed header and footer, before any deflate data. */
const GZIP_FRAME_BYTES = 18;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Copies a range into a buffer of its own, which is what WebCrypto accepts. */
function own(bytes: Uint8Array, start: number, end?: number): Uint8Array<ArrayBuffer> {
  return bytes.slice(start, end);
}

/** What a store records about the bytes it wrote: their length and their digest. */
type SealedArtifact = { bytes: Uint8Array; sha256: string };

/**
 * The plaintext as the binary envelope carries it, or a refusal.
 *
 * The budget is enforced here rather than trusted from `prepareArtifact`, whose
 * last fallback does not recheck it — a frame of a few thousand attempts is over
 * budget with every body already replaced by its marker. An envelope the reader
 * would refuse must not be one a writer makes, so `put` throws instead, before
 * anything is written. The plaintext is what is measured, never a compressed
 * form, so a body over budget is not admitted for compressing well.
 */
function plaintextOf(json: string): Uint8Array {
  const plain = encoder.encode(json);
  if (plain.length < 1 || plain.length > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact plaintext is outside the binary envelope's bounds");
  }
  return plain;
}

/**
 * The writer both stores call: the binary envelope, codec raw.
 *
 * Every reader since v0.13.5 opens it; a reader older than that calls it
 * `corrupt`, which is why writing it was a release of its own. The digest is over the whole stored
 * envelope, not the plaintext, so on-disk truncation or bit-rot is detectable by
 * a reader that does not hold `OMNI_ENCRYPTION_KEY` at all.
 */
export async function sealArtifact(key: CryptoKey, json: string): Promise<SealedArtifact> {
  const plain = plaintextOf(json);
  return sealBinary(key, plain.length, CODEC_RAW, plain);
}

/**
 * The binary envelope under the gzip policy: codec gzip where the policy's
 * cutoff and minimum saving are met, raw otherwise.
 *
 * Not a writer any store uses — see the policy above. It stays so the benchmark
 * can go on measuring it against `sealArtifact`, and `level` is the benchmark's
 * own knob. A compressor that fails is an error, not a quiet fallback to raw: the
 * only caller is measuring gzip, and a raw envelope would misreport it.
 */
export async function sealArtifactWithGzip(
  key: CryptoKey,
  json: string,
  level: number = GZIP_LEVEL,
): Promise<SealedArtifact> {
  const plain = plaintextOf(json);
  if (plain.length < GZIP_MIN_PLAINTEXT_BYTES) {
    return sealBinary(key, plain.length, CODEC_RAW, plain);
  }
  const packed = await gzipAsync(plain, { level });
  if (plain.length - packed.length < GZIP_MIN_SAVING_BYTES) {
    return sealBinary(key, plain.length, CODEC_RAW, plain);
  }
  return sealBinary(key, plain.length, CODEC_GZIP, packed);
}

/** Header, a fresh IV, and the payload sealed with the header as additional data. */
async function sealBinary(
  key: CryptoKey,
  claimed: number,
  codec: number,
  payload: Uint8Array,
): Promise<SealedArtifact> {
  const bytes = new Uint8Array(BINARY_OVERHEAD + payload.length);
  bytes.set(BINARY_MAGIC, 0);
  bytes[4] = BINARY_VERSION;
  bytes[5] = codec;
  new DataView(bytes.buffer).setUint32(6, claimed, false);
  const iv = crypto.getRandomValues(new Uint8Array(BINARY_IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: own(bytes, 0, BINARY_HEADER_BYTES),
      tagLength: BINARY_TAG_BYTES * 8,
    },
    key,
    own(payload, 0),
  );
  bytes.set(iv, BINARY_HEADER_BYTES);
  bytes.set(new Uint8Array(sealed), BINARY_HEADER_BYTES + BINARY_IV_BYTES);
  return { bytes, sha256: await sha256Hex(bytes) };
}

/** Why a stored artifact could not be handed back. */
export type ArtifactFailure = "missing" | "corrupt";

export type ArtifactRead =
  | { ok: true; artifact: BodyArtifact }
  | { ok: false; failure: ArtifactFailure };

/**
 * Reads one artifact, reporting rather than throwing.
 *
 * Every way this can fail — the file has gone, the digest disagrees, the key is
 * wrong, the plaintext is not JSON — is a state the caller has to render, not an
 * error it can act on. A body corpus and its index will drift, and the reader is
 * where that has to be survivable.
 */
export async function readArtifact(
  key: CryptoKey,
  dir: string,
  relPath: string,
  expectedSha256: string | null,
): Promise<ArtifactRead> {
  const acquired = await acquireArtifact(join(dir, relPath));
  if (!(acquired instanceof Uint8Array)) return { ok: false, failure: acquired };
  return decodeArtifact(key, acquired, expectedSha256);
}

/**
 * The file's bytes, read through one handle and never more than the ceiling.
 *
 * The size comes from the open handle rather than a `stat` of the path, and the
 * read asks for one byte more than it promised: a file that grew after the size
 * was taken is seen growing instead of being read at whatever length it reached.
 * A file too large to read is `corrupt` — the bytes exist — while one that cannot
 * be opened or read is `missing`, as it always was.
 */
async function acquireArtifact(path: string): Promise<Uint8Array | ArtifactFailure> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return "missing";
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_ENVELOPE_BYTES) return "corrupt";
    const buffer = new Uint8Array(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled > size ? "corrupt" : buffer.subarray(0, filled);
  } catch {
    return "missing";
  } finally {
    await handle.close().catch(() => {});
  }
}

const LEGACY_HEX = /^(?:[0-9a-f]{2})*$/;
const LEGACY_IV_HEX_CHARS = 24;
const LEGACY_TAG_HEX_CHARS = 32;

/**
 * The shape the legacy writer emitted, checked before `decrypt` sees it.
 *
 * `decrypt` is the credential helper and accepts any IV length AES-GCM does, so
 * an envelope sealed with a 16-byte IV would authenticate. Nothing here ever
 * wrote one, and the reader should not vouch for the shape of a file it did not
 * write. Legacy is read only now, until the last such row expires. Kept out of `encryption.ts`, whose rules belong to credentials.
 */
function isLegacyStructure(text: string): boolean {
  const parts = text.split(":");
  const [scheme, version, iv, body, tag] = parts;
  return (
    parts.length === 5 &&
    scheme === "enc" &&
    version === "v1" &&
    iv !== undefined &&
    body !== undefined &&
    tag !== undefined &&
    iv.length === LEGACY_IV_HEX_CHARS &&
    tag.length === LEGACY_TAG_HEX_CHARS &&
    LEGACY_HEX.test(iv) &&
    LEGACY_HEX.test(body) &&
    LEGACY_HEX.test(tag)
  );
}

/** A binary envelope whose header this reader implements, not yet authenticated. */
type BinaryEnvelope = {
  header: Uint8Array<ArrayBuffer>;
  codec: number;
  claimed: number;
  iv: Uint8Array<ArrayBuffer>;
  sealed: Uint8Array<ArrayBuffer>;
};

/**
 * Whether a payload of this length is one the codec could have produced for the
 * claimed plaintext length. False for a codec this reader does not implement,
 * which is how an unknown codec is refused before anything is decrypted. A gzip
 * payload says nothing about its expanded length, so beyond holding a frame it
 * answers only to the binary ceiling, like any other.
 */
function payloadFits(codec: number, payloadBytes: number, claimed: number): boolean {
  switch (codec) {
    case CODEC_RAW:
      return payloadBytes === claimed;
    case CODEC_GZIP:
      return payloadBytes >= GZIP_FRAME_BYTES;
    default:
      return false;
  }
}

/** The authenticated payload, turned back into the UTF-8 JSON it was sealed from. */
async function expand(codec: number, payload: Uint8Array, claimed: number): Promise<Uint8Array> {
  switch (codec) {
    case CODEC_RAW:
      return payload;
    case CODEC_GZIP:
      return gunzipArtifact(payload, claimed);
    default:
      throw new Error("unsupported artifact codec");
  }
}

/**
 * Expands an authenticated gzip payload to exactly `claimed` bytes, or throws.
 *
 * The budget is zlib's own `maxOutputLength`, so a payload that would expand
 * past it is stopped inside the inflate rather than measured after it: thirty
 * concatenated members of zeros fit under the binary ceiling and stand for half
 * a gigabyte. Concatenated members are a gzip stream like any other and decode
 * when their whole output is the claimed length.
 *
 * zlib stops at a zero byte after a member and returns what it had, treating
 * the rest as padding; anything else after a member it refuses. `bytesWritten`
 * counts the input it consumed, which stops short of that padding, so it must be
 * the whole payload. Exported for the test that proves the limit is native.
 */
export async function gunzipArtifact(payload: Uint8Array, claimed: number): Promise<Uint8Array> {
  const result: unknown = await gunzipAsync(payload, {
    maxOutputLength: MAX_ARTIFACT_BYTES,
    info: true,
  });
  const inflated = inflateResult(result);
  if (inflated === null) throw new Error("gzip result has an unexpected shape");
  if (inflated.consumed !== payload.length) throw new Error("bytes follow the gzip stream");
  if (inflated.output.length !== claimed) throw new Error("gzip output is not the claimed length");
  return inflated.output;
}

/**
 * `info: true` resolves to `{ buffer, engine }`, which the zlib typings do not
 * describe, so it is narrowed from `unknown` rather than asserted.
 */
function inflateResult(result: unknown): { output: Uint8Array; consumed: number } | null {
  if (typeof result !== "object" || result === null) return null;
  if (!("buffer" in result) || !("engine" in result)) return null;
  const { buffer, engine } = result;
  if (!(buffer instanceof Uint8Array) || typeof engine !== "object" || engine === null) return null;
  if (!("bytesWritten" in engine) || typeof engine.bytesWritten !== "number") return null;
  return { output: buffer, consumed: engine.bytesWritten };
}

/**
 * Reads the header and refuses anything this reader does not implement, all
 * before a digest is taken or a byte decrypted. The header is unauthenticated
 * at this point, so it only ever narrows: it can reject an envelope, and once
 * GCM has vouched for it, it may govern how the payload is expanded.
 */
function parseBinary(bytes: Uint8Array): BinaryEnvelope | null {
  if (bytes.length < BINARY_OVERHEAD || bytes.length > MAX_BINARY_ENVELOPE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  const codec = view.getUint8(5);
  const claimed = view.getUint32(6, false);
  if (version !== BINARY_VERSION) return null;
  if (claimed < 1 || claimed > MAX_ARTIFACT_BYTES) return null;
  if (!payloadFits(codec, bytes.length - BINARY_OVERHEAD, claimed)) return null;
  return {
    header: own(bytes, 0, BINARY_HEADER_BYTES),
    codec,
    claimed,
    iv: own(bytes, BINARY_HEADER_BYTES, BINARY_HEADER_BYTES + BINARY_IV_BYTES),
    sealed: own(bytes, BINARY_HEADER_BYTES + BINARY_IV_BYTES),
  };
}

async function openBinary(key: CryptoKey, envelope: BinaryEnvelope): Promise<string> {
  const payload = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: envelope.iv,
      additionalData: envelope.header,
      tagLength: BINARY_TAG_BYTES * 8,
    },
    key,
    envelope.sealed,
  );
  // Only now, with the header authenticated, may its codec and claimed length
  // decide how the payload is expanded. Fatal, so a byte that is not UTF-8 is a
  // corrupt artifact rather than a replacement character inside one that parses.
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await expand(envelope.codec, new Uint8Array(payload), envelope.claimed),
  );
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

/**
 * The half of a read that is about the bytes rather than where they came from:
 * format, bounds, digest, decryption, and the shape check on the plaintext.
 * Shared with the Postgres repo, which reads the same envelopes out of a `bytea`
 * column.
 *
 * The leading bytes choose the format exactly, and nothing falls back: a binary
 * envelope that fails is not then tried as legacy, nor the reverse, and bytes
 * that are neither are `corrupt`. Every refusal that can be made on the shape
 * alone is made before the digest is taken, so an oversized or malformed
 * envelope costs neither a copy nor a decryption.
 */
export async function decodeArtifact(
  key: CryptoKey,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<ArtifactRead> {
  const corrupt: ArtifactRead = { ok: false, failure: "corrupt" };
  try {
    if (bytes.length > MAX_ENVELOPE_BYTES) return corrupt;
    let unseal: () => Promise<string>;
    if (startsWith(bytes, BINARY_MAGIC)) {
      const envelope = parseBinary(bytes);
      if (envelope === null) return corrupt;
      unseal = () => openBinary(key, envelope);
    } else if (startsWith(bytes, LEGACY_PREFIX)) {
      // Within the ceiling, a well-formed legacy envelope's body hex is at most
      // twice the artifact budget: the ceiling is that limit, stated once.
      const text = new TextDecoder().decode(bytes);
      if (!isLegacyStructure(text)) return corrupt;
      unseal = () => decrypt(key, text);
    } else {
      return corrupt;
    }
    if (expectedSha256 !== null && (await sha256Hex(bytes)) !== expectedSha256) return corrupt;
    const parsed: unknown = JSON.parse(await unseal());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return corrupt;
    return { ok: true, artifact: parsed as BodyArtifact };
  } catch {
    return corrupt;
  }
}

export async function writeArtifact(
  dir: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

/**
 * Deletes an artifact and any shard directories its removal emptied.
 *
 * A file that is already gone is a success: deletion is called from sweeps that
 * are reconciling a table against a tree, and the tree having got there first is
 * the outcome they wanted.
 */
export async function deleteArtifact(dir: string, relPath: string): Promise<void> {
  const full = join(dir, relPath);
  try {
    await unlink(full);
  } catch {
    return;
  }
  // Up to, but never including, the bodies directory itself. `rmdir` fails on a
  // directory that still holds artifacts, which is exactly the stop condition.
  let parent = dirname(full);
  while (parent.length > dir.length && parent.startsWith(dir + sep)) {
    try {
      await rmdir(parent);
    } catch {
      return;
    }
    parent = dirname(parent);
  }
}

/**
 * Every artifact path under the bodies directory, relative and slash-separated
 * so it compares directly against `rel_path`.
 *
 * Walked by hand rather than with a recursive `readdir` option so the traversal
 * is the same on every runtime this has to run on, and so a directory that has
 * never been created reads as an empty tree rather than an error.
 */
export async function listArtifacts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(dir, "");
  return out;
}
