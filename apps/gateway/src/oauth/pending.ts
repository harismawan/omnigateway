import type { ProviderId } from "@omni/ir";
import type { PendingFlow } from "./types.ts";

export type StoredFlow = {
  provider: ProviderId;
  label: string;
  pending: PendingFlow;
  userCode?: string;
};

export type PendingFlows = {
  put(flow: StoredFlow): string;
  take(id: string): StoredFlow | null;
  /** Read without consuming — used by the browser callback to find its flow. */
  byState(state: string): (StoredFlow & { id: string }) | null;
  peek(id: string): StoredFlow | null;
  sweep(): void;
  size(): number;
};

export type PendingFlowsOptions = { now: () => number; ttlMs: number };

/**
 * In-memory only, with a TTL.
 *
 * A pending flow holds a live PKCE verifier. Persisting it would write a secret
 * to disk to protect against a restart mid-authorization — a case where the
 * right answer is for the operator to start over anyway.
 */
export function createPendingFlows(opts: PendingFlowsOptions): PendingFlows {
  const flows = new Map<string, { flow: StoredFlow; expiresAt: number }>();

  const expired = (entry: { expiresAt: number }): boolean => entry.expiresAt <= opts.now();

  return {
    put(flow) {
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      flows.set(id, { flow, expiresAt: opts.now() + opts.ttlMs });
      return id;
    },

    take(id) {
      const entry = flows.get(id);
      if (entry === undefined) return null;
      flows.delete(id);
      return expired(entry) ? null : entry.flow;
    },

    peek(id) {
      const entry = flows.get(id);
      if (entry === undefined || expired(entry)) return null;
      return entry.flow;
    },

    byState(state) {
      if (state.trim().length === 0) return null;
      for (const [id, entry] of flows) {
        if (entry.flow.pending.state === state) {
          return expired(entry) ? null : { ...entry.flow, id };
        }
      }
      return null;
    },

    sweep() {
      for (const [id, entry] of flows) {
        if (expired(entry)) flows.delete(id);
      }
    },

    size() {
      return flows.size;
    },
  };
}
