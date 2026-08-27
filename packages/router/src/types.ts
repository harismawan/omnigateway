import type { ChatRequest } from "@omni/ir";
import type { ProviderDescriptors } from "@omni/providers/descriptors";
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
  /**
   * Whether the exclusion describes the target's provider or the account named
   * in `credentialId`.
   *
   * `"target"` means no account would have helped: the request names one
   * provider — it carries that provider's native block or its provider-defined
   * tool — and this target is not it. Dispatch omits `credentialId` from the
   * degradation it writes for those, because naming an account there blames one
   * that is fine. Dispatch used to discover that by string-matching `reason`,
   * which made a rename of the concept a silent change to a persisted string.
   *
   * The three portable capability checks (`tools`, `images`, `reasoning`) stay
   * `"account"`, which is what shipped — note that their `reason` still begins
   * `capability:`, so the discriminator deliberately does not follow the reason
   * string. It answers "is this a fact about the target or about the account",
   * which is the only question the redaction needs. They read `target.capabilities`,
   * which an operator sets per target, so the row that leads to the fix is the
   * pair rather than the provider. Widening the redaction to cover them is a
   * behaviour change with its own decision behind it, not a consequence of
   * this discriminator existing.
   */
  kind: "target" | "account";
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
  /**
   * Which providers this installation has, for the `provider:missing` guard.
   *
   * Injected, defaulting to the real registry, so that a test can describe an
   * installation without editing the process-global one. Three test files used
   * to mutate `PROVIDER_DESCRIPTORS` and restore it in a `finally`; that is a
   * shared mutable global under a test runner that interleaves files, and this
   * repository has already lost a day to one such collision — a doctor test
   * that failed one run in six because another suite registered an id it
   * asserted absent.
   *
   * Deliberately not on `Snapshot`. The snapshot is cached across requests and
   * built from the store; the registry is fixed at boot and comes from code, so
   * folding one into the other would put a value with a different lifetime and
   * a different source behind the same cache.
   */
  providers?: ProviderDescriptors;
};

export type RankResult = {
  /** Best first. Dispatch walks this list on retryable failure. */
  candidates: Candidate[];
  excluded: Excluded[];
};
