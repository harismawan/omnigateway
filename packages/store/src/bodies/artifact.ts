import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { decrypt, encrypt } from "../encryption.ts";
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
  const size = encoder.encode(json).length;
  if (size <= MAX_ARTIFACT_BYTES) return { artifact: bounded, json };

  const marker = omission(size);
  const omitted = omitBodies(bounded, marker);
  const omittedJson = JSON.stringify(omitted);
  if (encoder.encode(omittedJson).length <= MAX_ARTIFACT_BYTES) {
    return { artifact: omitted, json: omittedJson };
  }

  // The error was worth keeping right up until it was the thing over the
  // budget. "Never written oversized" is the stronger promise of the two.
  const stripped: BodyArtifact = { ...omitted, error: marker };
  return { artifact: stripped, json: JSON.stringify(stripped) };
}

/**
 * Encrypts under the store's field key and reports the bytes as stored.
 *
 * The digest is over the ciphertext, not the plaintext, so on-disk truncation or
 * bit-rot is detectable by a reader that does not hold `OMNI_ENCRYPTION_KEY` at
 * all. That is what lets `corrupt` be a state the reader reports rather than an
 * exception it raises.
 */
export async function sealArtifact(
  key: CryptoKey,
  json: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = encoder.encode(await encrypt(key, json));
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
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(dir, relPath)));
  } catch {
    return { ok: false, failure: "missing" };
  }
  return decodeArtifact(key, bytes, expectedSha256);
}

/**
 * The half of a read that is about the bytes rather than where they came from:
 * digest check, decryption, and the shape check on the plaintext. Shared with
 * the Postgres repo, which reads the same envelope out of a `bytea` column.
 */
export async function decodeArtifact(
  key: CryptoKey,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<ArtifactRead> {
  try {
    if (expectedSha256 !== null && (await sha256Hex(bytes)) !== expectedSha256) {
      return { ok: false, failure: "corrupt" };
    }
    const parsed: unknown = JSON.parse(await decrypt(key, new TextDecoder().decode(bytes)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, failure: "corrupt" };
    }
    return { ok: true, artifact: parsed as BodyArtifact };
  } catch {
    return { ok: false, failure: "corrupt" };
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
