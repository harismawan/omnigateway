import type { ChatRequest } from "@omni/ir";
import type {
  CredentialHealth,
  CredentialView,
  QuotaWindow,
  Settings,
  Target,
  VirtualModel,
} from "@omni/store";

/**
 * Everything the router needs, gathered once per request.
 *
 * Held immutable for the life of a request so that two candidates ranked in the
 * same request see identical health and quota, and so ranking is reproducible
 * from its inputs alone.
 */
export type Snapshot = {
  credentials: CredentialView[];
  /** Keyed by `healthKey(credentialId, model)`. */
  health: ReadonlyMap<string, CredentialHealth>;
  /** Keyed by credential id. */
  quota: ReadonlyMap<string, QuotaWindow[]>;
  models: ReadonlyMap<string, VirtualModel>;
  settings: Settings;
  builtAt: number;
};

export type Candidate = {
  credential: CredentialView;
  target: Target;
  score: number;
  /** Per-term contributions, surfaced in the request log for debugging. */
  reasons: Record<string, number>;
};

export type Excluded = {
  credentialId: string;
  model: string;
  reason: string;
};

export type RankInput = {
  request: ChatRequest;
  model: VirtualModel;
  snapshot: Snapshot;
  now: number;
  /** Injected so weighted selection stays a pure function. Range [0, 1). */
  rand: number;
  /**
   * In-flight request count per `healthKey(credentialId, model)`.
   *
   * Read-only, and deliberately not part of `Snapshot`: the snapshot is cached
   * across requests, while this changes many times a second. A missing key
   * means zero.
   */
  load: ReadonlyMap<string, number>;
};

export type RankResult = {
  /** Best first. Dispatch walks this list on retryable failure. */
  candidates: Candidate[];
  excluded: Excluded[];
};
