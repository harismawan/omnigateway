import { workerData } from "node:worker_threads";
import { createLogger, type Logger } from "@omni/ir";
import { deriveKey } from "@omni/store";
import { createPostgresExportReader, openSqliteExportReader } from "@omni/store/exportReader";
import { SQL } from "bun";
import { redisCoord } from "../coord/redis.ts";
import type { Timers } from "./deliver.ts";
import { createExportLoop, type Handles } from "./loop.ts";
import {
  MAIN_MESSAGE_TYPES,
  type MainMessage,
  type WorkerInit,
  type WorkerMessage,
} from "./protocol.ts";
import { createPostgresExportState } from "./state/postgres.ts";
import { exportDbPathFor, openSqliteExportState } from "./state/sqlite.ts";
import { httpTransport } from "./transport.ts";

/**
 * The export worker: a Bun `Worker` entry, started by the gateway's main
 * thread through `spawnExportWorker` (`spawn.ts`). Everything it does lives in
 * `loop.ts`; this file only opens the real handles and relays messages.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Asynchrony*).
 *
 * Handles, all opened together and closed together (on `pause`, `stop`):
 * - SQLite: the main file **read-only** (no migrations, no writes) and the
 *   worker's own `export.db` beside it;
 * - Postgres: one pool of 2 connections for both the reads and `export_state`,
 *   and in cluster mode a Redis coordinator of its own for the leases.
 *
 * Nothing here is reachable from the main thread's module graph
 * (`apps/gateway/test/export/boundary.test.ts`).
 */

declare const self: {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: MessageEvent<MainMessage>) => void) | null;
};

const PG_POOL_SIZE = 2;

const init = workerData as WorkerInit;

const logger: Logger = createLogger({
  level: init.logLevel,
  color: Boolean(process.stdout.isTTY),
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
});

const timers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function open(): Promise<Handles> {
  const key = await deriveKey(init.encryptionKey);
  if (init.databaseUrl !== null) {
    const sql = new SQL({ url: init.databaseUrl, max: PG_POOL_SIZE });
    const coord =
      init.redisUrl === null ? null : redisCoord({ url: init.redisUrl, logger, now: Date.now });
    return {
      reader: createPostgresExportReader(sql, key),
      state: createPostgresExportState(sql),
      lease: coord === null ? null : coord.lease,
      async close() {
        coord?.close();
        await sql.close();
      },
    };
  }
  if (init.databasePath === null) throw new Error("export worker started without a database");
  const reader = openSqliteExportReader(init.databasePath, key, Date.now);
  try {
    const state = openSqliteExportState(exportDbPathFor(init.databasePath));
    return {
      reader,
      state,
      lease: null,
      close() {
        reader.close();
        state.close();
      },
    };
  } catch (error) {
    reader.close();
    throw error;
  }
}

const loop = createExportLoop({
  open,
  transport: httpTransport,
  now: Date.now,
  timers,
  random: Math.random,
  post: (message) => self.postMessage(message),
  logger,
  nodeId: init.nodeId,
});

const KNOWN: ReadonlySet<string> = new Set(MAIN_MESSAGE_TYPES);

self.onmessage = (event) => {
  const message = event.data;
  // Only the main thread posts here; a shape it never sends is a bug, not input.
  if (typeof message !== "object" || message === null || !KNOWN.has(message.type)) {
    logger.warn("export worker ignored an unknown message", { reason: "unknown message" });
    return;
  }
  void loop.handle(message).then(
    () => {
      if (message.type === "stop") process.exit(0);
    },
    () => {
      logger.error("export worker message failed", { reason: "internal error" });
      if (message.type === "stop") process.exit(1);
    },
  );
};

loop.start().catch(() => {
  // A fixed line: an open error can name a path or a URL with credentials.
  logger.error("export worker could not open its handles", { reason: "open failed" });
  process.exit(1);
});
