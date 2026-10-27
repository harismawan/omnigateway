import { Database } from "bun:sqlite";
import { bodyParts, previewBody } from "@omni/control";
import type { SQL } from "bun";
import { bodiesDirFor } from "../../../../packages/store/src/bodies/artifact.ts";
import { createBodyRepo as pgBodies } from "../../../../packages/store/src/postgres/bodies.ts";
import { createUsageRepo as pgUsage } from "../../../../packages/store/src/postgres/usage.ts";
import { createBodyRepo } from "../../../../packages/store/src/sqlite/bodies.ts";
import { createUsageRepo } from "../../../../packages/store/src/sqlite/usage.ts";
import { BODY_SLICE_BYTES, type MainMessage, type WorkerMessage } from "./protocol.ts";

// One whole decode at a time, including legacy 2N hex envelopes and their
// intermediate strings/buffers. Never admit a queue of 64 MiB decodes.
export function createBodyReader(deps: {
  path: string | null;
  key: CryptoKey;
  sql(): SQL;
  post(message: WorkerMessage): void;
}) {
  let db: Database | null = null;
  let active: Promise<void> | null = null;
  let activeRef: number | null = null;
  let raw: { ref: number; text: string; offset: number } | null = null;
  let epoch = 0;
  let paused = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    raw = null;
    clearTimeout(expiry);
  };
  const expire = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      if (raw) deps.post({ type: "read-error", ref: raw.ref });
      clear();
    }, 30_000);
  };
  return {
    resume() {
      paused = false;
    },
    async close() {
      paused = true;
      ++epoch;
      clear();
      await active;
      db?.close();
      db = null;
    },
    handle(message: MainMessage): void {
      if (message.type === "read-cancel") {
        if (raw?.ref === message.ref) clear();
        if (activeRef === message.ref) ++epoch;
        return;
      }
      if (message.type === "read-pull") {
        if (raw?.ref !== message.ref) return;
        let end = Math.min(raw.text.length, raw.offset + BODY_SLICE_BYTES / 4);
        if (end < raw.text.length && /[\uD800-\uDBFF]/.test(raw.text[end - 1] ?? "")) end--;
        const bytes = new TextEncoder().encode(raw.text.slice(raw.offset, end)).buffer;
        raw.offset = end;
        const last = end === raw.text.length;
        if (last) clear();
        else expire();
        deps.post({ type: "raw-chunk", ref: message.ref, bytes, last });
        return;
      }
      if (message.type !== "read" && message.type !== "readRaw") return;
      if (paused || active || raw) {
        deps.post({ type: "read-error", ref: message.ref });
        return;
      }
      const admitted = epoch;
      activeRef = message.ref;
      active = (async () => {
        try {
          if (deps.path !== null && db === null) {
            db = new Database(deps.path, { readonly: true });
            db.run("PRAGMA query_only = ON");
            db.run("PRAGMA busy_timeout = 5000");
          }
          const bodies = db
            ? createBodyRepo(db, deps.key, bodiesDirFor(deps.path ?? ""), { readonly: true })
            : pgBodies(deps.sql(), deps.key);
          const usage = db
            ? createUsageRepo(db, "body-reader")
            : pgUsage(deps.sql(), "body-reader", 0);
          const [read, log] = await Promise.all([
            bodies.get(message.requestId),
            usage.get(message.requestId),
          ]);
          if (admitted !== epoch) {
            active = null;
            activeRef = null;
            return;
          }
          if (message.type === "read") {
            const preview = previewBody(message.requestId, log?.bodyState ?? null, read);
            raw = { ref: message.ref, text: JSON.stringify(preview), offset: 0 };
            expire();
            active = null;
            activeRef = null;
            deps.post({ type: "preview-ready", ref: message.ref });
          } else {
            const pair = read?.artifact
              ? [...bodyParts(read.artifact)].find(([part]) => part === message.part)
              : undefined;
            if (pair) {
              raw = { ref: message.ref, text: JSON.stringify(pair[1] ?? null), offset: 0 };
              expire();
            }
            active = null;
            activeRef = null;
            deps.post({ type: "raw-ready", ref: message.ref, found: pair !== undefined });
          }
        } catch {
          active = null;
          activeRef = null;
          if (admitted === epoch) deps.post({ type: "read-error", ref: message.ref });
        }
      })();
    },
  };
}
