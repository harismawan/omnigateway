#!/usr/bin/env bun
/**
 * Drives the TS store through a sequence of request-log events, the way the
 * gateway does, so the Rust batched writer's rows can be compared against it.
 *
 *   echo '{"db":"/tmp/x.db","nodeId":"n","dayOffsetMinutes":0,"events":[...]}' \
 *     | bun conformance/store/usage-writer.ts
 *
 * Each event is a Rust `LogEvent` serialized as JSON (`{"type":"begin",...}`,
 * `"route"`, `"finish"`), or `{"type":"health", ...CredentialHealth}`. They go
 * through the gateway's own `beginLog` / `routeLog` / `finishLog` and the
 * store's `updateHealth`, never through a restatement of what those do.
 */
import { beginLog, finishLog, newCompletedRequestLog, newPendingRequestLog, routeLog } from "../../apps/gateway/src/logging.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
import { createCredentialRepo } from "../../packages/store/src/sqlite/credentials.ts";
import { openDb } from "../../packages/store/src/sqlite/db.ts";
import { createUsageRepo } from "../../packages/store/src/sqlite/usage.ts";
import type { CredentialHealth, Store } from "../../packages/store/src/types.ts";

type Input = {
  db: string;
  nodeId: string;
  dayOffsetMinutes: number;
  events: Array<Record<string, unknown> & { type: string }>;
};

const input = JSON.parse(await Bun.stdin.text()) as Input;
const db = openDb(input.db, input.dayOffsetMinutes);
const usage = createUsageRepo(db, input.nodeId, input.dayOffsetMinutes);
const credentials = createCredentialRepo(db, await deriveKey("conformance"));
const store = { usage, credentials } as unknown as Store;

let healthFailures = 0;
for (const event of input.events) {
  const { type, ...fields } = event;
  switch (type) {
    case "begin": {
      const { apiKeyId, ...pending } = fields as { apiKeyId: string | null } & Parameters<
        typeof newPendingRequestLog
      >[0];
      await beginLog(store, newPendingRequestLog(pending), apiKeyId);
      break;
    }
    case "route": {
      const { id, target } = fields as {
        id: string;
        target: Parameters<typeof routeLog>[2];
      };
      await routeLog(store, id, target);
      break;
    }
    case "finish": {
      const { id, at, apiKeyId, ...rest } = fields as {
        id: string;
        at: number;
        apiKeyId: string | null;
      } & Parameters<typeof newCompletedRequestLog>[2];
      await finishLog(store, newCompletedRequestLog(id, at, rest), apiKeyId);
      break;
    }
    case "health": {
      const row = fields as unknown as CredentialHealth;
      try {
        await credentials.updateHealth(row.credentialId, row.model, () => row);
      } catch {
        healthFailures += 1;
      }
      break;
    }
    default:
      throw new Error(`unknown event type ${type}`);
  }
}
db.close();
console.log(JSON.stringify({ healthFailures }));
