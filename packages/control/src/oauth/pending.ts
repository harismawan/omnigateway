import { type Coord, memoryCoord } from "@omni/coord";
import type { ProviderId } from "@omni/ir";
import type { PendingFlow } from "./types.ts";

export type StoredFlow = {
  provider: ProviderId;
  label: string;
  pending: PendingFlow;
  userCode?: string;
};

export type PendingFlows = {
  put(flow: StoredFlow): Promise<string>;
  take(id: string): Promise<StoredFlow | null>;
  peek(id: string): Promise<StoredFlow | null>;
};

export type PendingFlowsOptions = { now: () => number; ttlMs: number; coord?: Coord };

/** Where a flow lives: `oauth:pending:<id>`. */
const PREFIX = "oauth:pending:";

/**
 * Behind `coord.kv`, with a TTL.
 *
 * A pending flow holds a live PKCE verifier. In memory that is a map a restart
 * empties — an interrupted authorization is abandoned rather than resumed, and
 * nothing half-authorized is ever written to disk. In a fleet it is whatever
 * the coordinator holds for the length of the TTL, so the browser callback may
 * land on a process other than the one that started the flow.
 */
export function createPendingFlows(opts: PendingFlowsOptions): PendingFlows {
  const coord = opts.coord ?? memoryCoord({ now: opts.now });

  return {
    async put(flow) {
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      await coord.kv.set(PREFIX + id, JSON.stringify(flow), opts.ttlMs);
      return id;
    },

    async take(id) {
      const raw = await coord.kv.get(PREFIX + id);
      if (raw === null) return null;
      await coord.kv.del(PREFIX + id);
      return JSON.parse(raw) as StoredFlow;
    },

    async peek(id) {
      const raw = await coord.kv.get(PREFIX + id);
      return raw === null ? null : (JSON.parse(raw) as StoredFlow);
    },
  };
}
