import type { Coord } from "@omni/coord";

export type LeaseDeps = { coord: Coord; nodeId: string };

/**
 * Runs `fn` only if this process holds the lease named `name`.
 *
 * The background loops — token refresh, quota polling, pruning — run on every
 * process, and in a fleet must not: N pollers hit a provider's usage endpoint
 * N times, and N refresh sweeps are the race the refresher's lock exists for.
 * Each tick asks for the lease first; the in-memory coordinator always grants
 * it, so on one node this is the loop it was.
 *
 * A lease that cannot be confirmed is one this process does not hold, and the
 * tick is skipped rather than run: the failure that matters is two holders,
 * not zero, and zero corrects itself next tick. Returns whether it ran.
 */
export async function underLease(
  lease: LeaseDeps | undefined,
  name: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (lease !== undefined && !(await lease.coord.lease.acquire(name, lease.nodeId, ttlMs))) {
    return false;
  }
  await fn();
  return true;
}
