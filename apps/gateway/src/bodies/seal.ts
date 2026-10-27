import { access, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BodyArtifact, BodyOmission, BodyRepo } from "@omni/store/types";
import {
  ARTIFACT_SCHEMA_VERSION,
  prepareArtifact,
  relPathFor,
  STAGING_DIRNAME,
  sealArtifact,
  stagingPathFor,
} from "../../../../packages/store/src/bodies/artifact.ts";
import type { BodyMeta, MainMessage, WorkerMessage } from "./protocol.ts";

function asBody(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
type Assembly = {
  generation: number;
  parts: Map<string, { chunks: Uint8Array[]; seq: number; last: boolean }>;
};
type Deps = {
  key: CryptoKey;
  dir: string | null;
  bodies?: Pick<BodyRepo, "writeRow">;
  post(message: WorkerMessage): void;
  close?: () => Promise<void>;
};

/** Worker-only assembly, sealing and file/bytea ownership. Never opens main SQLite. */
export function createBodyWriter(deps: Deps) {
  const assemblies = new Map<string, Assembly>();
  const approvals = new Map<string, { path: string; resolve(): void }>();
  const publications = new Map<string, (accepted: boolean | null) => void>();
  let chain = Promise.resolve();
  let paused = false;
  let resuming: Promise<void> | undefined;

  function artifact(meta: BodyMeta, assembly: Assembly | undefined): BodyArtifact {
    const text = (part: string): string | null => {
      const chunks = assembly?.parts.get(part);
      if (chunks === undefined) return null;
      if (!chunks.last) throw new Error("incomplete body part");
      const decoder = new TextDecoder();
      return (
        chunks.chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode()
      );
    };
    const frames = (prefix: string): string[] => {
      const result: string[] = [];
      for (let i = 0; assembly?.parts.has(`${prefix}.${i}`); i++)
        result.push(text(`${prefix}.${i}`) ?? "");
      return result;
    };
    const marker: BodyOmission = {
      omitted: true,
      reason: meta.abandoned === "backlog" ? "backlog" : "capture budget exhausted",
      serializedBytes: null,
    };
    const omitted = meta.abandoned !== null;
    return {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      requestId: meta.requestId,
      at: meta.at,
      error: meta.error,
      client: {
        request: omitted ? marker : asBody(text("client.request")),
        response: omitted
          ? marker
          : meta.client.responseFrames
            ? frames("client.frame")
            : asBody(text("client.response")),
        truncated: omitted || meta.client.truncated,
      },
      attempts: meta.attempts.map((a, i) => {
        const response = omitted
          ? null
          : (text(`attempt.${i}.response`) ??
            (assembly?.parts.has(`attempt.${i}.chunk.0`)
              ? frames(`attempt.${i}.chunk`).join("")
              : null));
        return {
          attempt: a.attempt,
          provider: a.provider,
          request: omitted ? marker : asBody(text(`attempt.${i}.request`)),
          response: omitted ? marker : asBody(response),
          streamChunks:
            !omitted && a.streamChunks
              ? (response ?? "")
                  .replaceAll("\r\n", "\n")
                  .split("\n\n")
                  .filter((f) => f.length > 0)
              : null,
          truncated: omitted || a.truncated,
        };
      }),
    };
  }
  async function write(meta: BodyMeta, assembly: Assembly | undefined): Promise<void> {
    let staging: string | null = null;
    let final: string | null = null;
    try {
      const prepared = prepareArtifact(artifact(meta, assembly));
      const sealed = await sealArtifact(deps.key, prepared.json);
      const relPath = relPathFor(meta.requestId, meta.at);
      const row = {
        requestId: meta.requestId,
        generation: meta.generation,
        at: meta.at,
        relPath,
        sizeBytes: sealed.bytes.length,
        sha256: sealed.sha256,
        truncated:
          prepared.artifact.client.truncated || prepared.artifact.attempts.some((a) => a.truncated),
        omitted: prepared.omitted || meta.abandoned !== null,
      };
      if (deps.dir !== null) {
        staging = stagingPathFor(deps.dir, meta.requestId, crypto.randomUUID());
        await mkdir(dirname(staging), { recursive: true });
        const file = await open(staging, "wx", 0o600);
        try {
          await file.writeFile(sealed.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        if (paused) throw new Error("writer paused");
        await new Promise<void>((resolve) => {
          approvals.set(meta.requestId, { path: relPath, resolve });
          deps.post({
            type: "publishing",
            requestId: meta.requestId,
            generation: meta.generation,
            relPath,
          });
        });
        if (paused) throw new Error("writer paused");
        const target = join(deps.dir, relPath);
        await mkdir(dirname(target), { recursive: true });
        // A restarted/duplicate capture must never overwrite a published file.
        const exists = await access(target).then(
          () => true,
          () => false,
        );
        if (exists) throw new Error("artifact already exists");
        await rename(staging, target);
        final = target;
        staging = null;
      } else {
        if (!(await deps.bodies?.writeRow({ ...row, bytes: sealed.bytes }))) {
          deps.post({ type: "unowned", requestId: meta.requestId, generation: meta.generation });
          return;
        }
      }
      if (paused) throw new Error("writer paused");
      const accepted = await new Promise<boolean | null>((resolve) => {
        publications.set(meta.requestId, resolve);
        deps.post({ type: "written", ...row });
      });
      if (accepted === false && final !== null) await unlink(final);
      final = null;
      deps.post({ type: "cleaned", requestId: meta.requestId, generation: meta.generation });
    } catch {
      if (final !== null) await unlink(final);
      deps.post({ type: "write-failed", requestId: meta.requestId, generation: meta.generation });
    } finally {
      if (staging !== null) await unlink(staging).catch(() => {});
      approvals.delete(meta.requestId);
      publications.delete(meta.requestId);
    }
  }
  return {
    async handle(message: MainMessage): Promise<void> {
      if (message.type === "publish-ok") {
        const approval = approvals.get(message.requestId);
        if (approval?.path === message.relPath) approval.resolve();
        return;
      }
      if (message.type === "publish-result") {
        publications.get(message.requestId)?.(message.accepted);
        return;
      }
      if (message.type === "part") {
        if (resuming !== undefined) await resuming;
        if (paused) return;
        let assembly = assemblies.get(message.requestId);
        if (assembly === undefined) {
          assembly = { generation: message.generation, parts: new Map() };
          assemblies.set(message.requestId, assembly);
        }
        let part = assembly.parts.get(message.part);
        if (part === undefined) {
          part = { chunks: [], seq: 0, last: false };
          assembly.parts.set(message.part, part);
        }
        if (assembly.generation !== message.generation || part.seq !== message.seq || part.last)
          throw new Error("invalid body sequence");
        part.seq++;
        part.last = message.last;
        part.chunks.push(new Uint8Array(message.bytes));
        deps.post({
          type: "slice-ack",
          requestId: message.requestId,
          generation: message.generation,
          bytes: message.bytes.byteLength,
        });
        return;
      }
      if (message.type === "meta") {
        if (resuming !== undefined) await resuming;
        if (paused) return;
        let assembly = assemblies.get(message.requestId);
        assemblies.delete(message.requestId);
        if (message.abandoned !== null) {
          assembly?.parts.clear();
          assembly = undefined;
          deps.post({
            type: "discarded",
            requestId: message.requestId,
            generation: message.generation,
          });
        }
        chain = chain.then(() => (paused ? undefined : write(message, assembly)));
        return chain;
      }
      if (message.type === "pause" || message.type === "stop") {
        paused = true;
        assemblies.clear();
        // Abandon the current staged/publication wait before closing handles.
        for (const approval of approvals.values()) approval.resolve();
        // A main-connection commit may have happened but not replied. Unknown
        // disposition preserves the final file; orphan sweep reconciles later.
        for (const resolve of publications.values()) resolve(null);
        await chain;
        await deps.close?.();
        if (message.type === "pause") deps.post({ type: "paused" });
      } else if (message.type === "resume") {
        // Pause ACK (or actual old-thread close) precedes resume. No live write
        // owns staging now; remove even fresh remnants of the replaced DB.
        resuming = (async () => {
          await chain;
          if (deps.dir !== null) {
            const dir = join(deps.dir, STAGING_DIRNAME);
            const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const file of files) if (file.isFile()) await unlink(join(dir, file.name));
          }
          paused = false;
        })();
        await resuming;
        resuming = undefined;
      }
    },
  };
}
