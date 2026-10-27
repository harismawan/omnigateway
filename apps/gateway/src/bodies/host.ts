import { GatewayError, type Logger } from "@omni/ir";
import type { BodyRepo } from "@omni/store/types";
import type { CapturedParts } from "../bodyCapture.ts";
import { createWorkerHost, type HostedWorker, type Timers } from "../workerHost/instance.ts";
import type { CaptureBudget } from "./budget.ts";
import {
  BODY_QUEUE_LIMIT,
  BODY_SLICE_BYTES,
  type BodyMeta,
  type MainMessage,
  type WorkerMessage,
} from "./protocol.ts";

export type BodyWriterHost = {
  start(): Promise<void>;
  enqueue(parts: CapturedParts, generation?: number): void;
  isPending(relPath: string): boolean;
  pause(): Promise<void>;
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
  stop(): void;
  /** Five-second writer grace; unknown DB outcomes are left for recovery. */
  drain(): Promise<void>;
  generation(): number;
};
type DropReason = "budget" | "backlog" | "writer_crash" | "restore";
type Entry = {
  parts: CapturedParts;
  generation: number;
  slices: number;
  path: string | null;
  publishing: boolean;
};
type Deps = {
  spawn(): HostedWorker<MainMessage, WorkerMessage>;
  bodies: Pick<BodyRepo, "publish" | "fail">;
  budget: CaptureBudget;
  logger: Logger;
  now(): number;
  timers: Timers;
  yield?: () => Promise<void>;
  onDropped?: (reason: DropReason) => void;
};

function meta(parts: CapturedParts, generation: number, abandoned = parts.abandoned): BodyMeta {
  return {
    type: "meta",
    requestId: parts.requestId,
    generation,
    at: parts.at,
    error: parts.error,
    client: {
      truncated: parts.client.truncated,
      responseFrames: Array.isArray(parts.client.response),
    },
    attempts: parts.attempts.map((a) => ({
      attempt: a.attempt,
      provider: a.provider,
      truncated: a.truncated,
      streamChunks: a.streamChunks !== null || a.captureStreamChunks === true,
    })),
    abandoned,
  };
}

/** Raw text only; frames are separate parts, never serialized on the request thread. */
function* texts(parts: CapturedParts): Generator<[string, string]> {
  if (parts.client.request !== null) yield ["client.request", parts.client.request];
  if (Array.isArray(parts.client.response)) {
    for (const [i, frame] of parts.client.response.entries()) yield [`client.frame.${i}`, frame];
  } else if (parts.client.response !== null) yield ["client.response", parts.client.response];
  for (const [i, a] of parts.attempts.entries()) {
    if (a.request !== null) yield [`attempt.${i}.request`, a.request];
    if (Array.isArray(a.response)) {
      for (const [j, chunk] of a.response.entries()) yield [`attempt.${i}.chunk.${j}`, chunk];
    } else if (a.response !== null) yield [`attempt.${i}.response`, a.response];
    for (const [j, frame] of (a.streamChunks ?? []).entries())
      yield [`attempt.${i}.frame.${j}`, frame];
  }
}

export function createBodyWriterHost(deps: Deps): BodyWriterHost {
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const queue: Entry[] = [];
  const publications = new Set<Promise<void>>();
  let generation = 0;
  let accepting = true;
  let lifecycleEpoch = 0;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let changed = () => {};
  let pumping = false;
  let failing = false;
  let dropping: DropReason = "writer_crash";
  const pauseMessage: Extract<MainMessage, { type: "pause" }> = { type: "pause" };
  const yieldTurn = deps.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  function discard(parts: CapturedParts): void {
    deps.budget.release(parts.reservedBytes);
    parts.reservedBytes = 0;
    parts.client.request = null;
    parts.client.response = null;
    parts.attempts.length = 0;
    parts.error = null;
  }
  function release(entry: Entry): void {
    deps.budget.release(entry.slices);
    discard(entry.parts);
    entry.slices = 0;
    entries.delete(entry.parts.requestId);
    changed();
  }
  /** One failure write, no waiting ids: a blocked store must not become a queue. */
  function failPending(requestId: string): void {
    if (failing) return;
    failing = true;
    const startedGeneration = generation;
    const failure = Promise.resolve()
      .then(() => (startedGeneration === generation ? deps.bodies.fail(requestId) : undefined))
      .catch(() => {});
    publications.add(failure);
    void failure.finally(() => {
      failing = false;
      publications.delete(failure);
      changed();
    });
  }
  function fail(entry: Entry, reason: DropReason, record = true): void {
    if (entries.get(entry.parts.requestId) !== entry) return;
    if (entry.path !== null) pending.delete(entry.path);
    release(entry);
    deps.onDropped?.(reason);
    if (record) failPending(entry.parts.requestId);
  }
  const clear = (reason: DropReason, record = true): void => {
    for (const entry of entries.values()) {
      // Unknown publication decisions are not refusals: preserve owner bytes
      // and sweep protection until actual thread close, without failing its row.
      if (entry.publishing) {
        deps.onDropped?.(reason);
        release(entry);
      } else fail(entry, reason, record);
    }
    queue.length = 0;
  };
  const worker = createWorkerHost<MainMessage, WorkerMessage>({
    ...deps,
    name: "body writer",
    lifecycle: { pause: pauseMessage, resume: { type: "resume" }, stop: { type: "stop" } },
    onUnavailable: () => clear(dropping, accepting || draining),
    onExit: () => pending.clear(),
    onMessage(message) {
      if (message.type === "paused") return;
      const entry = entries.get(message.requestId);
      if (
        entry === undefined ||
        message.generation !== generation ||
        entry.generation !== generation
      )
        return;
      // Closing admission must not suppress confirmed disposal from the live
      // worker while pause settles publications. Retired-instance replies are
      // fenced by the generic host, so unknown owners still wait for close.
      if (
        !accepting &&
        message.type !== "slice-ack" &&
        message.type !== "cleaned" &&
        message.type !== "discarded" &&
        message.type !== "unowned"
      )
        return;
      if (message.type === "slice-ack") {
        const bytes = Math.min(entry.slices, message.bytes);
        entry.slices -= bytes;
        deps.budget.release(bytes);
      } else if (message.type === "publishing") {
        entry.path = message.relPath;
        pending.add(message.relPath);
        worker.post({ type: "publish-ok", requestId: message.requestId, relPath: message.relPath });
      } else if (message.type === "written") {
        entry.publishing = true;
        const publication = (async () => {
          try {
            const accepted = await deps.bodies.publish(message);
            if (entries.get(message.requestId) !== entry || generation !== message.generation)
              return;
            // Refused files remain protected until the worker confirms deletion.
            worker.post({ type: "publish-result", requestId: message.requestId, accepted }, true);
            if (accepted) {
              if (entry.path !== null) pending.delete(entry.path);
              release(entry);
            }
          } catch {
            if (generation !== message.generation || entries.get(message.requestId) !== entry)
              return;
            // A rejection is not proof that the transaction did not commit.
            // Keep the final file; only a definite false authorizes unlink.
            failPending(message.requestId);
            // Recovery is lifecycle work, not a DB operation. It can be queued
            // behind pause; never make DB settlement depend on that pause.
            void worker.recover().catch(() => {});
          }
        })();
        publications.add(publication);
        void publication.finally(() => {
          publications.delete(publication);
          changed();
        });
      } else if (message.type === "discarded") {
        deps.budget.release(entry.parts.reservedBytes);
        entry.parts.reservedBytes = 0;
      } else if (message.type === "unowned") {
        release(entry);
      } else if (message.type === "cleaned") {
        if (entry.path !== null) pending.delete(entry.path);
        release(entry);
      } else if (message.type === "write-failed") fail(entry, "writer_crash");
    },
  });

  async function send(entry: Entry): Promise<void> {
    const p = entry.parts;
    if (p.abandoned === null) {
      const encoder = new TextEncoder();
      for (const [part, text] of texts(p)) {
        let offset = 0;
        let seq = 0;
        do {
          if (entries.get(p.requestId) !== entry || !accepting) return;
          // At most 1 MiB of characters inspected/encoded in any one turn.
          let end = Math.min(text.length, offset + BODY_SLICE_BYTES);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
          let chunk = text.slice(offset, end);
          while (Buffer.byteLength(chunk) > BODY_SLICE_BYTES) {
            end = offset + Math.max(1, Math.floor((end - offset) / 2));
            if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
            chunk = text.slice(offset, end);
          }
          const size = Buffer.byteLength(chunk);
          if (!deps.budget.reserve(size)) {
            p.abandoned = "budget";
            p.client.request = null;
            p.client.response = null;
            for (const a of p.attempts) {
              a.request = null;
              a.response = null;
              a.streamChunks = null;
            }
            deps.onDropped?.("budget");
            worker.post(meta(p, entry.generation));
            return;
          }
          entry.slices += size;
          const bytes = encoder.encode(chunk).buffer;
          worker.post({
            type: "part",
            requestId: p.requestId,
            generation: entry.generation,
            part,
            seq: seq++,
            last: end === text.length,
            bytes,
          });
          offset = end;
          await yieldTurn();
        } while (offset < text.length);
      }
    }
    if (entries.get(p.requestId) === entry && accepting) worker.post(meta(p, entry.generation));
  }
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && accepting) {
        const entry = queue.shift();
        if (entry === undefined || entries.get(entry.parts.requestId) !== entry) continue;
        try {
          await send(entry);
        } catch {
          fail(entry, "writer_crash");
        }
      }
    } finally {
      pumping = false;
    }
  }
  return {
    start: () => worker.start(),
    enqueue(parts, capturedGeneration = parts.generation ?? generation) {
      // A background collector may settle after reopen. Never fail or publish
      // its id in the new database, even if the restored snapshot reused it.
      if (capturedGeneration !== generation) {
        discard(parts);
        deps.onDropped?.("restore");
        return;
      }
      if (entries.has(parts.requestId)) {
        discard(parts);
        return;
      }
      const reason =
        !accepting || draining
          ? dropping
          : worker.state() !== "running"
            ? "writer_crash"
            : entries.size >= BODY_QUEUE_LIMIT
              ? "backlog"
              : null;
      if (reason !== null) {
        discard(parts);
        deps.onDropped?.(reason);
        // Hard admission bound wins over an omission artifact per rejected id.
        // If this slot is busy, sweepPending eventually fails the stale row.
        if (accepting) failPending(parts.requestId);
        return;
      }
      const entry: Entry = { parts, generation, slices: 0, path: null, publishing: false };
      entries.set(parts.requestId, entry);
      queue.push(entry);
      // No encoding, parsing, or worker messaging on the request's stack.
      void Promise.resolve().then(pump);
    },
    isPending: (path) => pending.has(path),
    async pause() {
      ++lifecycleEpoch;
      accepting = false;
      dropping = "restore";
      pauseMessage.publications = [...entries.values()]
        .filter((e) => e.publishing)
        .map((e) => e.parts.requestId);
      // Arm worker quiescence immediately, independent of a stalled main DB.
      const quiescing = worker.pause((m) => m.type === "paused");
      let expired = false;
      let timer: unknown;
      const barrier = (async () => {
        // Timed-out operations stay tracked: every retry must wait for them.
        // Continuations can add a failure write as their publication settles.
        // Drain the actual-operation set to empty, not just its first snapshot.
        while (!expired && publications.size > 0) await Promise.all(publications);
        if (expired) return;
        for (const entry of entries.values()) {
          if (expired) return;
          if (!entry.publishing) {
            const failure = Promise.resolve()
              .then(() => deps.bodies.fail(entry.parts.requestId))
              .catch(() => {});
            publications.add(failure);
            await failure;
            publications.delete(failure);
          }
        }
      })();
      const bounded = Promise.race([
        barrier,
        new Promise<void>((_resolve, reject) => {
          timer = deps.timers.setTimeout(() => {
            expired = true;
            reject(
              new GatewayError(
                "OVERLOADED",
                "body database operations did not settle; nothing was restored",
              ),
            );
          }, 5000);
        }),
      ]);
      void barrier.finally(() => deps.timers.clearTimeout(timer));
      try {
        const results = await Promise.allSettled([quiescing, bounded]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
      } finally {
        expired = true;
        deps.timers.clearTimeout(timer);
        clear("restore", false);
      }
    },
    async resume(swapped) {
      const resumed = ++lifecycleEpoch;
      if (swapped && publications.size > 0) {
        throw new GatewayError("OVERLOADED", "body database operations still pending");
      }
      if (swapped) generation++;
      await worker.resume(swapped);
      if (resumed === lifecycleEpoch) {
        accepting = true;
        dropping = "writer_crash";
      }
    },
    async halt() {
      ++lifecycleEpoch;
      accepting = false;
      clear("restore");
      await worker.halt();
    },
    stop() {
      ++lifecycleEpoch;
      accepting = false;
      worker.stop();
    },
    drain() {
      if (drainPromise !== undefined) return drainPromise;
      draining = true;
      ++lifecycleEpoch;
      dropping = "writer_crash";
      drainPromise = (async () => {
        let timer: unknown;
        await new Promise<void>((resolve) => {
          changed = () => {
            if (entries.size === 0 && publications.size === 0) resolve();
          };
          timer = deps.timers.setTimeout(() => {
            accepting = false;
            worker.stop(true);
            resolve();
          }, 5000);
          changed();
        });
        deps.timers.clearTimeout(timer);
        accepting = false;
        // Early DB settlement after recovery can finish drain with a retired
        // owner still alive. Do not leave that owner on a fresh grace timer.
        worker.stop(worker.state() === "stopping");
        // Unknown decisions survive as files/pending rows for reconciliation;
        // bookkeeping cannot keep the process alive past its shutdown budget.
        changed = () => {};
      })();
      return drainPromise;
    },
    generation: () => generation,
  };
}
