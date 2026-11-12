#!/usr/bin/env bun
/**
 * The Postgres twin of `usage-writer.ts`: drives the TS Postgres store
 * through a sequence of request-log events the way the gateway does, so the
 * Rust batched writer's Postgres rows can be compared against it.
 *
 *   echo '{"url":"postgres://…","nodeId":"n","dayOffsetMinutes":0,"events":[...]}' \
 *     | bun conformance/store/pg-usage-writer.ts
 *
 * Events are the same JSON as `usage-writer.ts` takes, and go through the
 * gateway's own `beginLog` / `routeLog` / `finishLog` and the store's
 * `updateHealth` with the router's `blankHealth`, one at a time. The database
 * must already be migrated.
 */
import { SQL } from "bun";
import {
  beginLog,
  finishLog,
  newCompletedRequestLog,
  newPendingRequestLog,
  routeLog,
} from "../../apps/gateway/src/logging.ts";
import { blankHealth } from "../../packages/router/src/breaker.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
import { createCredentialRepo } from "../../packages/store/src/postgres/credentials.ts";
import { createUsageRepo } from "../../packages/store/src/postgres/usage.ts";
import type { CredentialHealth, Store } from "../../packages/store/src/types.ts";

type Input = {
  url: string;
  nodeId: string;
  dayOffsetMinutes: number;
  events: Array<Record<string, unknown> & { type: string }>;
};

const input = JSON.parse(await Bun.stdin.text()) as Input;
const sql = new SQL({ url: input.url, max: 2 });
const usage = createUsageRepo(sql, input.nodeId, input.dayOffsetMinutes);
const credentials = createCredentialRepo(sql, await deriveKey("conformance"), () => {});
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
    case "breakerTransition": {
      const row = fields as unknown as CredentialHealth;
      try {
        await credentials.updateHealth(row.credentialId, row.model, () => row);
      } catch {
        healthFailures += 1;
      }
      break;
    }
    case "healthMeasurement": {
      const m = fields as unknown as Pick<
        CredentialHealth,
        "credentialId" | "model" | "consecutiveFailures" | "rateLimitedUntil"
      >;
      try {
        await credentials.updateHealth(m.credentialId, m.model, (current) => ({
          ...(current ?? blankHealth(m.credentialId, m.model)),
          consecutiveFailures: m.consecutiveFailures,
          rateLimitedUntil: m.rateLimitedUntil,
        }));
      } catch {
        healthFailures += 1;
      }
      break;
    }
    default:
      throw new Error(`unknown event type ${type}`);
  }
}
await sql.close();
console.log(JSON.stringify({ healthFailures }));
