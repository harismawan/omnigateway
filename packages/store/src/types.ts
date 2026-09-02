import type { ProviderId } from "@omni/ir";
import type { PonytailMode } from "@omni/ponytail/catalog";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import type { RtkFilterId } from "@omni/rtk/catalog";

/**
 * Re-exported so the console can name the shape it renders and submits.
 *
 * The dashboard is permitted `@omni/store/types` and not runtime store code, and
 * this keeps that the one import it needs rather than a second permitted path.
 */
export type { PonytailMode } from "@omni/ponytail/catalog";
export type { Dimension, LimitConfig, Window } from "@omni/ratelimit/catalog";

export type BreakerState = "closed" | "open" | "halfOpen";
export type AuthType = "oauth" | "apiKey";
export type WindowType = "fiveHour" | "daily" | "weekly";

/**
 * Nominal length of each window.
 *
 * Lives here rather than with its first consumer because three of them now need
 * it — the router judges headroom against it, `@omni/control` infers a window
 * start from it, and the console renders against it — and a second copy would
 * be free to drift from this one.
 */
export const WINDOW_DURATION_MS: Record<WindowType, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * How long one window actually runs for.
 *
 * The three names are buckets, not durations: Codex reports a real duration and
 * it is stored under whichever of the three names it lands nearest. A provider
 * that stated its own duration is believed over the nominal one, because a
 * three-hour window read as five puts its inferred start two hours too early.
 *
 * A non-positive duration is not a window and is discarded rather than passed
 * on to divide by.
 */
export function durationFor(windowType: WindowType, windowMs: number | null): number {
  return windowMs !== null && windowMs > 0 ? windowMs : WINDOW_DURATION_MS[windowType];
}

/**
 * How far two reported reset times may sit apart and still be one window.
 *
 * Not every provider states an instant. Codex states a whole-second countdown,
 * which is read as `now + seconds * 1000` — so the absolute reset is rederived
 * on every probe from a clock that moved a poll interval, and lands a few
 * hundred milliseconds off its predecessor even when the window never rolled
 * over. Compared exactly, an idle account looks like a fresh window every time
 * it is read.
 *
 * A minute is picked because the two things it has to separate are three orders
 * of magnitude apart, not because it was tuned. Jitter is bounded by the
 * provider's own truncation plus the latency between its clock and ours —
 * seconds at the very worst. A genuine rollover moves the reset by a whole
 * window, and the shortest window this store names is five hours. Anything from
 * a few seconds to a few hours would do; a minute is comfortably inside both
 * margins and is a span an operator can reason about.
 *
 * The tolerance is applied when *comparing*, never when parsing: `resetsAt` is
 * shown to operators as a countdown and is what a window start is inferred back
 * from, so quantizing it at the parse site would corrupt a stored fact to fix a
 * comparison. Rounding into buckets would also still split whenever real jitter
 * straddles a bucket edge, which turns a constant bug into an intermittent one.
 */
export const SAME_WINDOW_TOLERANCE_MS = 60_000;

/**
 * Whether two reported reset times describe the same window.
 *
 * One definition, deliberately: `saveQuota` decides whether a reading is worth
 * retaining and the console decides where to break a chart line, and those are
 * the same question. Two answers would mean storage and chart disagreed about
 * what a window is, which is worse than either being wrong alone.
 *
 * Null is not near anything. A provider that started or stopped naming a reset
 * said something new, and that is a change worth recording.
 */
export function sameWindow(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS;
}

/**
 * Whether a stored reading describes a window that has already ended.
 *
 * One definition, for the reason `sameWindow` and `servesTarget` have one. A
 * `quota_windows` row is overwritten by the poller and by nothing else, so
 * between a rollover and the next probe — up to `quotaPollIntervalMs`, five
 * minutes by default — the newest reading on file counts a window that no
 * longer exists. Nothing about the reading itself says so: it was taken minutes
 * ago, so every staleness check reports it as current, and the only signal is
 * that its own stated reset is now behind us.
 *
 * The router has always dropped these, and for a while it was the only reader
 * that did: the console kept drawing the spent window's rate, its exhaustion
 * instant and its bar, under a legend counting down to a reset in the past.
 * Asking the question in one place is what keeps those two answers the same.
 *
 * Not the same verdict as staleness, and callers that phrase both should say
 * staleness first: a probe that has not got through for hours makes both true,
 * and only one of them is something the operator can act on.
 *
 * A window with no stated reset is never rolled over. Nothing was said about
 * when it ends, which is not the same as having ended — reading it as rolled
 * over would suppress every figure for a provider that simply does not report
 * one.
 */
export function quotaRolledOver(window: { resetsAt: number | null }, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now;
}

/**
 * The fields a burn estimate has to carry to be judged.
 *
 * Spelled structurally so this leaf stays clear of `@omni/control`, which owns
 * the estimate and whose `BurnEstimate` satisfies this shape. It lives here
 * because both surfaces that phrase an estimate — the CLI through
 * `@omni/control`, the console through `/api/*` — can reach this module and
 * neither can reach the other.
 */
export type QuotaBurnReading = {
  ratePerHour: number | null;
  exhaustsAt: number | null;
  survives: boolean | null;
  stale: boolean;
};

/**
 * What can honestly be said about one window, before it is phrased.
 *
 * `empty` carries no countdown: the instant it would count down from is
 * `exhaustsAt`, and each surface renders that against its own `now`.
 */
export type QuotaVerdict = "stale" | "unknown" | "ok" | "empty";

/**
 * Judged on the reading, never on `survives` alone.
 *
 * `survives` is true by construction whenever there is no `exhaustsAt`, and
 * having no ceiling and having no inferable rate are two of the ways to have
 * none. A reader that branched on it first would answer "this will last the
 * window" to a window it knows nothing about.
 *
 * The unavailable cases stay apart because "too old to use", "never read at
 * all", and "the provider never said" are three different things to go and fix.
 */
export function quotaVerdict(
  window: Pick<QuotaWindow, "observedAt" | "limit">,
  estimate: QuotaBurnReading | undefined,
): QuotaVerdict {
  if (estimate === undefined) return "unknown";
  // A row written before snapshots existed carries no reading to age, so it is
  // unknown rather than stale even though it is suppressed the same way.
  if (window.observedAt > 0 && estimate.stale) return "stale";
  // `limit <= 0`, not `=== null`. A ceiling of zero or below is a ceiling
  // nobody stated — nothing validates what a provider reports on its way into
  // `quota_windows` — and every other site of that rule already says so:
  // `usedRatioOf`, `rateRatioOf`, `burnFor`, the CLI's rate column and
  // `reportedWindows`. This was the sixth and the only one that disagreed, so
  // a non-positive ceiling reached the last line and answered **"ok"** — the
  // affirmative safety claim the note above says must never be made about a
  // window nothing is known about. `omni quota` printed it beside a used
  // column reading `10/0`.
  if (estimate.ratePerHour === null || window.limit === null || window.limit <= 0) {
    return "unknown";
  }
  if (estimate.survives === false && estimate.exhaustsAt !== null) return "empty";
  return estimate.survives === true ? "ok" : "unknown";
}

/**
 * Why a credential is not routing.
 *
 * `tokenRejected` is the provider's verdict on a refresh: the credential cannot
 * be revived without reconnecting. `expiredNoRefresh` is ours, for an OAuth
 * credential that ran out with nothing to refresh from. `manual` is the
 * operator's own switch, and is the only one they can undo with a toggle.
 */
export type DisabledReason = "tokenRejected" | "expiredNoRefresh" | "manual";

export type Credential = {
  id: string;
  provider: ProviderId;
  label: string;
  authType: AuthType;
  enabled: boolean;
  tier: number;
  weight: number;
  /** Milliseconds since epoch, or null when the token does not expire. */
  expiresAt: number | null;
  accountEmail: string | null;
  /** Provider-specific durable state, e.g. Kimi device identity, Codex workspace id. */
  providerData: Record<string, unknown>;
  /** Why `enabled` is false. Null whenever the credential is enabled. */
  disabledReason: DisabledReason | null;
  disabledAt: number | null;
  /**
   * Derived at read time, never written. Lets the router decide whether an
   * expired credential can be revived without decrypting anything.
   */
  hasRefreshToken: boolean;
  /**
   * Moves on every `updateSecrets`. A caller that read the credential before
   * refreshing passes it back, and a write whose version has moved is refused.
   */
  tokenVersion: number;
  createdAt: number;
  updatedAt: number;
};

/** Secret material, resolved separately so ranking never decrypts. */
export type CredentialSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  idToken: string | null;
};

export type InferenceSecrets = Pick<CredentialSecrets, "accessToken" | "apiKey">;
export type RefreshSecrets = Pick<CredentialSecrets, "refreshToken">;
export type UsageSecrets = Pick<CredentialSecrets, "accessToken">;

/**
 * A credential plus purpose-specific lazy secret loaders. The router reads only
 * metadata; the selected operation decrypts only fields it needs.
 */
export type CredentialView = Credential & {
  secrets: () => Promise<CredentialSecrets>;
  openForInference: () => Promise<InferenceSecrets>;
  openForRefresh: () => Promise<RefreshSecrets>;
  openForUsage: () => Promise<UsageSecrets>;
};

export type CredentialHealth = {
  credentialId: string;
  model: string;
  breakerState: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  rateLimitedUntil: number | null;
  ewmaTtftMs: number | null;
  lastUsedAt: number | null;
};

/**
 * One provider-reported usage window for one credential.
 *
 * `used` and `limit` are in whatever unit the provider reported. A provider
 * that only gives a percentage is stored as `used: 87, limit: 100`, which keeps
 * every consumer on the same ratio arithmetic.
 */
export type QuotaWindow = {
  credentialId: string;
  windowType: WindowType;
  startsAt: number;
  used: number;
  /** Null means the provider reported usage without a ceiling to measure it against. */
  limit: number | null;
  /** When the provider says the window rolls over, or null when it did not say. */
  resetsAt: number | null;
  /**
   * When this reading was taken. Zero for a row written before snapshots
   * existed; readers treat that as never observed rather than as current.
   */
  observedAt: number;
  /**
   * How long the provider said this window runs for, or null when it did not
   * say. `durationFor` prefers it over the nominal length of `windowType`.
   */
  windowMs: number | null;
};

/**
 * One retained reading of one window.
 *
 * `quota_windows` holds only the newest reading, so it can say where an account
 * stands but never how it got there. A sample is that reading kept, written by
 * `saveQuota` in the same transaction as the snapshot it describes.
 *
 * Readings are stored only when something moved, so a gap in the series means
 * either "nothing changed" or "the probe did not run". `quota_windows.observedAt`
 * separates the two: liveness lives in the snapshot, shape lives here.
 */
export type QuotaSample = {
  credentialId: string;
  windowType: WindowType;
  observedAt: number;
  used: number;
  limit: number | null;
  resetsAt: number | null;
  windowMs: number | null;
};

/** Both bounds are inclusive epoch milliseconds, as `UsageQuery` uses them. */
export type QuotaSampleQuery = {
  since: number;
  until: number;
  /** Omitted means every credential. */
  credentialId?: string | undefined;
  /**
   * At most this many rows, newest first, still returned oldest-first.
   *
   * Omitted means every row in the span, which is what the operator's own
   * disclosure asks for: it is scoped to one credential and gated behind a
   * session. The unscoped reader — the client surface, reachable by every key
   * holder — passes one, because a span alone bounds how far back a scan
   * reaches and not how many rows come back from it.
   *
   * Newest first is what makes truncation honest here. Cutting the tail of the
   * default ordering would drop whole accounts by name; cutting old readings
   * shortens every account's history evenly, which is the direction a chart
   * already reads.
   */
  limit?: number | undefined;
};

/**
 * Dollars per million tokens, by token class.
 *
 * Everything but `input` and `output` is optional because a target saved
 * before that class was priced simply has no figure for it. Cache writes are
 * split by TTL: Anthropic bills a 5m write at 1.25x base input and a 1h write
 * at 2x, so one write price cannot cover both.
 */
export type TargetPricing = {
  input: number;
  output: number;
  // Spelled `| undefined` so a Zod-parsed body, whose optional keys infer that
  // way, assigns without a cast under `exactOptionalPropertyTypes`.
  cacheRead?: number | undefined;
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
};

/**
 * What a provider charges to read a cache entry, as a multiple of its base
 * input price, for a target that names no rate of its own.
 *
 * A tenth is what every provider the gateway speaks to charges, and a target
 * saved before cache pricing existed carries only `input` and `output`.
 */
const READ_OVER_INPUT = 0.1;

/**
 * The cache-read price for a target, falling back to a multiple of its input.
 *
 * Shared by billing and by routing on purpose. The two priced the same request
 * differently once — routing charged fresh input for tokens billing charged a
 * tenth of that — and a pool of targets whose cache rates differ is exactly
 * where that gap changes which target gets picked.
 */
export function cacheReadRate(prices: TargetPricing): number {
  return prices.cacheRead ?? prices.input * READ_OVER_INPUT;
}

type TargetBase = {
  model: string;
  tier: number;
  weight: number;
  costPerMTok: TargetPricing;
  /**
   * What the gateway tells clients this target can hold and emit, in tokens.
   *
   * Optional because a target saved before these were recorded names neither,
   * and because a model outside the catalog has no default to fall back to.
   * Nothing enforces them: they are advertised on `GET /v1/models` so a client
   * sizes its own context, and an over-long request still fails upstream.
   */
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilities: { tools: boolean; images: boolean; reasoning: boolean };
  /**
   * Serve this target from one named account only.
   *
   * Absent is the normal state and means any credential of the target's
   * provider. Set narrows the router's filter to that credential alone, and the
   * pin is hard: an account that is disabled, breakered, rate-limited or out of
   * quota fails the request rather than spilling to a sibling. An operator pins
   * for billing separation or a per-account agreement, and silent spillover is
   * the one outcome that defeats both.
   *
   * A pin naming a credential that no longer exists is left alone rather than
   * refused at write time, for the same reason `putModel` exempts a stored
   * target from the auth rule: removing an account must not make an unrelated
   * edit unsavable. It surfaces at routing as `pin:missing`.
   */
  credentialId?: string | undefined;
};

export type Target = TargetBase & {
  provider: ProviderId;
  /** Required for custom targets by the control schema; absent on built-in targets. */
  endpointId?: string | undefined;
};

/**
 * The credential facts that decide whether an account can serve a target.
 *
 * Structural rather than `CredentialView`, so the console — which may not
 * import runtime store code — and the CLI and control both satisfy it with what
 * they already hold.
 */
export type ServingAccount = {
  id: string;
  provider: ProviderId;
  providerData: Record<string, unknown>;
};

/**
 * The three fields of a target that decide which accounts can reach it.
 *
 * Narrower than `Target` so the console can ask the question about a half-built
 * draft — a picker needs to know which accounts a target *could* use, before
 * the model name or the prices exist — without inventing the rest of a target
 * to satisfy a signature. A `Target` satisfies it structurally.
 */
export type TargetAddress = {
  provider: ProviderId;
  endpointId?: string | undefined;
  credentialId?: string | undefined;
};

/**
 * Whether this account is one the target could be dispatched to.
 *
 * The single copy of a rule that was written five times and got three of them
 * wrong. Provider, custom endpoint and pin are one question, not three, and a
 * site that asks only part of it reaches a different answer than the router —
 * which is how a target pinned to another provider's account came to save
 * cleanly, hard-fail every request, and be reported as healthy by `doctor`.
 *
 * Deliberately says nothing about `enabled`, capabilities, breakers or quota.
 * Those are *states* an account passes through; this is whether the account is
 * addressable by the target at all. Callers that care about health add it: the
 * router drops a disabled account with its own reason, and `putModel` counts
 * one because a rejected token is still the operator's way in.
 */
export function servesTarget(target: TargetAddress, account: ServingAccount): boolean {
  if (account.provider !== target.provider) return false;
  // The endpoint an account is bound to and the endpoint a target names must be
  // the same, including when neither names one. Read from the account rather
  // than trusting a saved string: an endpoint is the credential's own property.
  //
  // Stated as an equality in both directions, which is the correction to a
  // first version that asked only "does the target name an endpoint the account
  // fails to match". That version failed **open** on the case it did not test: a
  // `custom` target whose `endpointId` was absent or `""` skipped the check
  // entirely and was then served by *every* custom account, at any endpoint. The
  // rule it replaced compared `"endpoint-a" !== undefined`, refused, and left the
  // target unroutable — the safe answer for a row that cannot say where it goes.
  //
  // Read paths reach that row even though write paths cannot mint it:
  // `sqlite/config.ts` parses stored targets with no validation, so a restore, a
  // hand edit or a foreign database supplies one. The consequence was not a
  // failed request but a request sent to an arbitrary endpoint's origin with
  // that endpoint's key, and an `omni doctor` that called the pin healthy —
  // which is the inverse of the bug this function was made the single copy for.
  //
  // `""` means naming none **on the target side only**, and the asymmetry is the
  // point. The console's `TargetDraft.endpointId` is a non-optional string
  // carrying `""` for every non-custom target, and the control schema refuses
  // `""` on the way in for the same reason: it is an id nothing matches, not a
  // third state. Treating it as a value there would make this function disagree
  // with the callers it exists to be the only copy for — the pin picker would
  // offer no account for any non-custom target.
  //
  // An account is the other way round. Nothing legitimate writes `""` there:
  // `customProviderData` in `packages/control/src/credentials.ts` reads it
  // through `requiredString`, which refuses empty, and a non-custom account
  // holds no `endpointId` key at all. So an account carrying `""` is a malformed
  // row exactly as one carrying `42` is, and mapping it to "names none" made it
  // serve every target that names none — the same fail-open direction the
  // paragraph below closes for the other non-string values, missed because the
  // empty string is a string.
  //
  // It is a **widening as well as a closure**, and both halves are worth
  // stating. A *non-custom* account carrying `endpointId: ""` previously served
  // ordinary targets of its provider and now serves nothing at all, and a pin to
  // it dangles in `omni doctor`. That is the right direction — the router
  // refuses the same row, and a credential whose stored endpoint is unreadable
  // should not quietly act as one with no endpoint — but an operator whose
  // database holds such a row sees an account stop working, and "it was only
  // ever a malformed row" is a poor answer to arrive at from the outside.
  //
  // No provider is named. A non-custom target that somehow carries an endpoint,
  // or an account that somehow holds one its target does not name, is refused
  // rather than ignored: unreachable through the schema, and failing closed is
  // the right direction for a constraint a row states and cannot honour.
  // `providerData` is `Record<string, unknown>` and `sqlite/credentials.ts` reads
  // it back with a bare `JSON.parse`, so `endpointId` can be any JSON value at
  // all. A first version mapped every non-string to `undefined`, which made a
  // corrupt id read as *no* id — so a custom target naming no endpoint was
  // served by any account whose `endpointId` was a number, `null`, `false` or an
  // object. That is the same fail-open this rule was written to close, one layer
  // down, and it was looser than the rule it replaced: comparing raw values,
  // `42 !== undefined` refused.
  //
  // Present-but-unusable therefore becomes a value that matches nothing, rather
  // than a synonym for absent.
  //
  // On the **account** side alone, and that is sufficient rather than lazy:
  // `UNUSABLE` is a symbol, and no target-side value is one, so an account whose
  // id is unusable matches nothing whatever the target holds — including a
  // target read back from `sqlite/config.ts`'s unvalidated `JSON.parse` carrying
  // the same corrupt value. A version that symbolised both sides was written and
  // deleted: every mutant of the target half survived, because the account half
  // already decided every case it could have.
  //
  // For the same reason `UNUSABLE` is one shared symbol rather than a fresh one
  // per call. An earlier revision minted one each time, on the stated grounds
  // that two identically corrupt ids must not match each other — but the compare
  // is always target-against-account, never account-against-account, so no input
  // can distinguish the two. That claim also had a test asserting it, which
  // passed under a hoisted sentinel and was therefore proving nothing. Keeping a
  // refinement no input can observe is how a reader comes to believe something
  // is being defended that is not.
  const UNUSABLE = Symbol("unusable-endpoint");
  const namedByTarget = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value;
  // The one asymmetry, and the whole fix: `""` is "names none" for a target and
  // a malformed row for an account.
  const namedByAccount = (value: unknown): string | symbol | undefined => {
    if (value === undefined) return undefined;
    return typeof value === "string" && value !== "" ? value : UNUSABLE;
  };
  if (namedByTarget(target.endpointId) !== namedByAccount(account.providerData.endpointId)) {
    return false;
  }
  return target.credentialId === undefined || account.id === target.credentialId;
}

/**
 * The account a pinned target names, or undefined when the pin resolves to none.
 *
 * Undefined covers every way a pin fails — deleted, another provider, another
 * custom endpoint — because the router reports them identically as
 * `pin:missing` and no caller has ever needed to tell them apart. An unpinned
 * target also returns undefined: it names no account, which is a different fact
 * with the same consequence for every caller here.
 */
export function resolvePin<T extends ServingAccount>(
  target: TargetAddress,
  accounts: readonly T[],
): T | undefined {
  if (target.credentialId === undefined) return undefined;
  return accounts.find((account) => servesTarget(target, account));
}

export type Strategy = "score" | "priority" | "roundRobin" | "weighted";

export type VirtualModel = {
  id: string;
  targets: Target[];
  strategy: Strategy;
  /** True when this row was generated from an alias for a concrete model name. */
  isAlias: boolean;
};

export type ApiKey = {
  id: string;
  label: string;
  /** First 12 chars of the key, for display. Never the full key. */
  prefix: string;
  hash: string;
  modelAllowlist: string[] | null;
  /**
   * The sparse `(dimension, window)` matrix bounding what this key can do, or
   * `null` when the stored column could not be parsed.
   *
   * `{}` is unlimited, and so is an explicit `null` at any pair inside the
   * matrix. The outer `null` is a different fact and must never collapse into
   * `{}`: "no limits configured" and "the configured limits are unreadable"
   * differ by whether a ceiling the operator set is being honoured, and reading
   * the second as the first fails open on exactly that ceiling.
   *
   * It is a read-side state only — `KeyRepo.create` refuses to write a shape no
   * reader can parse — so a row is unreadable because the column was edited by
   * hand or written by a build that knew a name this one does not.
   */
  limits: LimitConfig | null;
  /**
   * Suppresses body capture for this key whatever the settings say.
   *
   * A shared installation can serve a client whose payloads must not be
   * retained, and that client cannot be asked to trust an installation-wide
   * switch it does not control. Checked before any capture work begins.
   */
  bodyLoggingOptOut: boolean;
  createdAt: number;
  revokedAt: number | null;
};

/**
 * `pending` is a request still in flight. Its `status`, `attempts`, tokens and
 * cost are placeholder zeros, never measurements: read `state` to tell the two
 * apart, never `status`.
 */
export type RequestState = "pending" | "done";

export type RequestLog = {
  id: string;
  state: RequestState;
  at: number;
  apiKeyId: string | null;
  requestedModel: string;
  resolvedProvider: ProviderId | null;
  resolvedModel: string | null;
  credentialId: string | null;
  attempts: number;
  status: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number | null;
  durationMs: number;
  costUsd: number;
  /** Capability degradations applied, e.g. ["droppedThinking"]. */
  degradations: string[];
  rtkApplied: boolean;
  rtkFilterHits: number;
  rtkOriginalCodeUnits: number;
  rtkCompressedCodeUnits: number;
  rtkEstimatedTokensSaved: number;
  rtkFilters: RtkFilterId[];
};

export type ScoringWeights = {
  tier: number;
  health: number;
  quota: number;
  cost: number;
  latency: number;
  /** Requests in flight right now, which is what separates a simultaneous burst. */
  load: number;
};

export type Settings = {
  weights: ScoringWeights;
  maxAttempts: number;
  requestDeadlineMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  logRetentionDays: number;
  /** How often provider quota is polled. Zero disables polling entirely. */
  quotaPollIntervalMs: number;
  rtkEnabled: boolean;
  /**
   * Whether the gateway adds a cache breakpoint to Anthropic requests that
   * arrive without one.
   *
   * Prompt caching is opt-in at Anthropic: a request carrying no
   * `cache_control` is billed as fresh input every time, however stable its
   * prefix. A client that never marks a breakpoint therefore pays full price
   * for a prompt it resends verbatim, which is what this repairs.
   *
   * **Defaults on**, unlike the other request-modifying flags here. It only
   * ever touches requests that carry no breakpoint at all, so it cannot
   * overwrite a placement a client chose, and cannot push one past Anthropic's
   * four-breakpoint ceiling. A malformed stored value still reads as off, like
   * every other flag that rewrites a request.
   *
   * It is still a billing change: a cache write costs more than plain input,
   * and a prefix never re-read inside the TTL is a small net loss. That is why
   * the injection is also gated on the prompt being large enough to be
   * cacheable at all.
   */
  autoCacheEnabled: boolean;
  /**
   * Which ponytail ruleset, if any, the gateway appends to system prompts.
   *
   * The third request-rewriting flag, and the only one that is not a boolean:
   * upstream ships three intensities, so the union is what an operator picks
   * between. `off` is the default and injects nothing at all.
   *
   * A malformed stored value reads as `off`, like every neighbour here. This
   * deliberately does not follow the fail-closed-by-throwing rule that
   * `DIMENSIONS` and `WINDOWS` follow: those decide whether a request is
   * *refused*, so a value nobody typed must not be guessed at, while this only
   * decides whether the gateway rewrites a prompt — and returning the
   * installation to its pre-feature behaviour costs an operator nothing they
   * did not already have.
   */
  ponytailMode: PonytailMode;
  /**
   * Whether request and response bodies are captured at all.
   *
   * One of two independent keys: the gateway also requires
   * `OMNI_BODY_LOGGING_ALLOWED` in the environment, read at boot. Two keys mean
   * a compromised admin session cannot by itself start recording prompts, while
   * an operator whose environment already permits it can still flip capture on
   * and off mid-incident without a restart.
   */
  bodyLoggingEnabled: boolean;
  /**
   * Additionally retains raw SSE frames per attempt.
   *
   * Gated separately rather than implied by capture: it is the only way to debug
   * stream framing itself, and it is the most expensive thing this feature can
   * store.
   */
  bodyLoggingCaptureStreamChunks: boolean;
  /**
   * How many database snapshots survive regardless of age.
   *
   * Bounded rather than optional. A snapshot is a whole copy of the database, so
   * an unbounded directory of them is a disk-full incident waiting for a busy
   * week; the reference implementation this feature follows added retention only
   * after 48,999 files against a 5 MB database.
   */
  snapshotKeepLatest: number;
  /** How long a snapshot outside the keep-latest window is kept. */
  snapshotMaxAgeDays: number;
};

export interface CredentialRepo {
  list(): Promise<CredentialView[]>;
  /** Routing metadata only; secret ciphertext is loaded lazily by credential id. */
  listRouting(): Promise<CredentialView[]>;
  get(id: string): Promise<CredentialView | null>;
  create(
    input: Omit<Credential, "createdAt" | "updatedAt" | "hasRefreshToken" | "tokenVersion"> &
      CredentialSecrets,
  ): Promise<Credential>;
  update(id: string, patch: Partial<Credential>): Promise<void>;
  /**
   * Writes token material, and reports whether it was written.
   *
   * With `expectedVersion`, the write lands only if `tokenVersion` still
   * equals it — the compare-and-swap that keeps two processes from each
   * rotating a refresh token the provider will honour only once. Without it,
   * the write is unconditional, which is what the connect flow wants.
   */
  updateSecrets(
    id: string,
    secrets: Partial<CredentialSecrets>,
    expiresAt: number | null,
    expectedVersion?: number,
  ): Promise<boolean>;
  remove(id: string): Promise<void>;
  listHealth(): Promise<CredentialHealth[]>;
  /**
   * Writes whole rows, last writer wins.
   *
   * Correct for seeding and for an operator editing a row outright. Not for a
   * transition: a caller that derives its row from an earlier read loses any
   * write that landed in between. Use `updateHealth` for those.
   */
  saveHealth(rows: CredentialHealth[]): Promise<void>;
  /**
   * Applies a health transition atomically, and returns the row it persisted.
   *
   * `apply` runs inside the write transaction against the row as it is on disk
   * rather than a caller's snapshot, so two transitions on one credential cannot
   * lose each other's increment. It receives `null` when no row exists yet.
   *
   * `apply` must be synchronous. `bun:sqlite` is synchronous, and that is the
   * only reason the read and the write cannot be interleaved; an `await` inside
   * `apply` would reopen the race this exists to close.
   */
  updateHealth(
    credentialId: string,
    model: string,
    apply: (current: CredentialHealth | null) => CredentialHealth,
  ): Promise<CredentialHealth>;
  listQuota(): Promise<QuotaWindow[]>;
  /** Also appends a sample per window whose reading moved. See `QuotaSample`. */
  saveQuota(rows: QuotaWindow[]): Promise<void>;
  listQuotaSamples(q: QuotaSampleQuery): Promise<QuotaSample[]>;
  /** Prunes retained samples. Returns how many rows went. */
  pruneQuotaSamples(olderThan: number): Promise<number>;
}

export interface ConfigRepo {
  listModels(): Promise<VirtualModel[]>;
  putModel(model: VirtualModel): Promise<void>;
  removeModel(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  getAdminPasswordHash(): Promise<string | null>;
  /** Writes only if no admin hash exists; reports whether this call won. */
  setAdminPasswordHashIfAbsent(hash: string): Promise<boolean>;
  /** Replaces an existing password hash for the authenticated password-change path. */
  setAdminPasswordHash(hash: string): Promise<void>;
  /**
   * The read-only administrator's password hash, or null where the operator has
   * not set one. Absent is the default: a fresh install has no viewer.
   */
  getViewerPasswordHash(): Promise<string | null>;
  /** Sets the read-only password, or removes it entirely with `null`. */
  setViewerPasswordHash(hash: string | null): Promise<void>;
}

/**
 * Where an artifact's bodies actually are, from the row's point of view.
 *
 * `none` is a row with no artifact behind it. `ready` is one that was written
 * and has not since been contradicted. `missing` and `corrupt` are what the
 * reader observed and wrote back: a file tree and a table that are not written
 * transactionally together will drift, and the reader is where that has to be
 * survivable rather than fatal.
 */
export type BodyDetailState = "none" | "ready" | "missing" | "corrupt";

/**
 * One request/response pair as it crossed a boundary.
 *
 * Both halves are `unknown` because a body is whatever the client or the
 * provider sent: usually a parsed JSON object, sometimes a bare string, and
 * absent entirely on the half that never happened.
 */
export type BodyPair = {
  request: unknown;
  response: unknown;
  /** True when structural bounding altered either half. */
  truncated: boolean;
};

/** One provider attempt's wire pair, in dispatch order. */
export type BodyAttempt = BodyPair & {
  /** 1-based, matching how `request_logs.attempts` counts. */
  attempt: number;
  provider: ProviderId;
  /**
   * Raw SSE frames, only when `bodyLoggingCaptureStreamChunks` is on. Null
   * otherwise, in which case a streaming response appears as the reassembled
   * final response instead.
   */
  streamChunks: string[] | null;
};

/**
 * One request's whole story: what arrived at `/v1/*`, and what went to and came
 * back from every provider tried.
 *
 * `client.request` is the pre-RTK conversation and every `attempts[].request` is
 * the post-filter one, because `transformRequest` runs in dispatch before
 * routing. That difference is the point — `request_logs` records which filters
 * ran but not what they removed — so a reader must label which side is which
 * and must never present the two as interchangeable.
 *
 * `schemaVersion` is present from the first release rather than added once the
 * shape changes; OmniRoute is on its fifth revision of this structure.
 */
export type BodyArtifact = {
  schemaVersion: number;
  requestId: string;
  at: number;
  client: BodyPair;
  attempts: BodyAttempt[];
  /** Whatever the request failed with, or null. Masked and bounded like a body. */
  error: unknown;
};

/** The database row: a pointer and its integrity metadata, never a body. */
export type BodyArtifactRow = {
  requestId: string;
  at: number;
  /** Relative to the bodies directory, so moving an installation keeps rows valid. */
  relPath: string | null;
  /** Size of the stored bytes, which are ciphertext. */
  sizeBytes: number;
  /** Over the stored bytes, so corruption is detectable without the key. */
  sha256: string | null;
  detailState: BodyDetailState;
  truncated: boolean;
};

/**
 * What a read of one request's bodies can say.
 *
 * `artifact` is null whenever `row.detailState` is not `ready`, and the row is
 * still returned so a caller can report *why* rather than an error.
 */
export type BodyRead = {
  row: BodyArtifactRow;
  artifact: BodyArtifact | null;
};

export interface BodyRepo {
  /**
   * The only write path, and the reason there is no raw one.
   *
   * Masking and structural bounding happen inside, before encryption, so no
   * caller can write an unmasked or unbounded body even by mistake. Throws on a
   * request id that could escape its shard directory, and propagates a failed
   * disk write: capture is the caller's to degrade, and it degrades to no
   * artifact rather than to a failed request.
   */
  put(artifact: BodyArtifact): Promise<BodyArtifactRow>;
  /**
   * Null when no row exists. Never throws on a bad artifact: a file that has
   * gone reads as `missing` and one that fails decryption or its digest reads as
   * `corrupt`, and either way the observed state is written back to the row.
   */
  get(requestId: string): Promise<BodyRead | null>;
  /** Deletes rows older than the cutoff and their files. Returns how many went. */
  prune(olderThan: number): Promise<number>;
  /**
   * Trims oldest-first to a row cap. The time window is what an operator
   * reasons about; this is what actually bounds disk, because a window over
   * sustained traffic bounds nothing.
   */
  pruneToCap(cap?: number): Promise<number>;
  /** Removes artifact files with no row, which a crash between the two writes leaves. */
  sweepOrphans(): Promise<number>;
}

/**
 * A key as it is minted.
 *
 * `limits` is non-nullable here where `ApiKey` allows null: the unreadable state
 * is something a reader discovers, never something a writer may ask for.
 */
export type ApiKeyInput = Omit<ApiKey, "createdAt" | "revokedAt" | "limits"> & {
  limits: LimitConfig;
};

export interface KeyRepo {
  /**
   * Every key, including any whose `limits` could not be parsed — those carry
   * `limits: null`. One meddled row must not cost an operator the listing that
   * is how they would find it.
   */
  list(): Promise<ApiKey[]>;
  findByHash(hash: string): Promise<ApiKey | null>;
  /**
   * One key by id, or null where there is none.
   *
   * Exists because a client dashboard session re-checks its own key's
   * revocation on every request, and doing that through `list()` reads and
   * parses every key in the installation to look at one of them — on a
   * synchronous database, on a path a browser polls.
   */
  get(id: string): Promise<ApiKey | null>;
  /** Throws on a `limits` shape no reader could parse, rather than storing it. */
  create(input: ApiKeyInput): Promise<ApiKey>;
  /**
   * Replaces one key's limit matrix, whole.
   *
   * One of two fields editable after minting — the allowlist via
   * `setModelAllowlist` is the other — and deliberately so:
   * `bodyLoggingOptOut` is a promise to whoever holds the key, while a limit is
   * the operator's own ceiling on their own installation. A weekly spend cap
   * that cannot be adjusted without minting a new key and redeploying every
   * client is a cap that gets set to unlimited instead.
   *
   * Replaces rather than merges, for the same reason `create` validates: the
   * stored value is one JSON document and a partial write would have to be
   * read, merged, and re-validated somewhere, which is a caller's decision
   * rather than a repo's. Throws on a shape no reader could parse.
   */
  setLimits(id: string, limits: LimitConfig): Promise<void>;
  /**
   * Replaces one key's model allowlist, whole.
   *
   * The other field editable after minting, for the same reason as the matrix:
   * an allowlist that cannot be adjusted without minting a new key and
   * redeploying every client is one that gets set to unrestricted instead.
   * Unlike `limits` there is no write-side parser guard — any array of names
   * round-trips through its JSON column, and a junk entry simply never matches
   * a request, which fails closed per request rather than failing open once.
   */
  setModelAllowlist(id: string, modelAllowlist: string[] | null): Promise<void>;
  revoke(id: string): Promise<void>;
}

/**
 * A dimension usage can be sliced by. `hour` only exists in raw logs and `day`
 * only in the rollup; the rest are available at both grains.
 */
export type UsageDimension =
  | "credential"
  | "model"
  | "requestedModel"
  | "apiKey"
  | "provider"
  | "hour"
  | "day";

/**
 * `raw` reads `request_logs`, which is bounded by the retention window but can
 * resolve down to the hour. `daily` reads the `usage_daily` rollup, which keeps
 * a year but only ever answers per day.
 */
export type UsageGrain = "raw" | "daily";

export type UsageQuery = {
  since: number;
  until?: number;
  /** Defaults to `raw`. */
  grain?: UsageGrain;
  groupBy: UsageDimension;
  /**
   * A second dimension, giving one bucket per (groupBy, splitBy) pair. This is
   * what turns a time series into a stacked one — group by `day`, split by
   * `provider` — without asking the caller to issue a query per series.
   */
  splitBy?: UsageDimension;
  /**
   * Restricts every bucket to one API key.
   *
   * A filter, not a dimension: it constrains the rows before grouping, so it
   * applies whatever `groupBy` and `splitBy` are — including `apiKey` itself,
   * where an unscoped query would otherwise report that other keys exist.
   *
   * Served without a scan at either grain. `usage_daily` has `api_key_id` in
   * its primary key, and `request_logs` has `idx_request_logs_key_at`.
   */
  apiKeyId?: string;
};

export type UsageBucket = {
  key: string;
  /** Present only when the query set `splitBy`. */
  split?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rtkSavedTokens: number;
  rtkAppliedRequests: number;
  costUsd: number;
  errors: number;
  /** Summed request durations; divide by `requests` for the window's mean. */
  durationMsSum: number;
};

/**
 * One key's consumption inside a window.
 *
 * `tokens` is `input + output + cacheRead + cacheWrite`. `Usage.inputTokens` is
 * uncached input, so the four columns are disjoint classes and summing them
 * double-counts nothing.
 */
export type UsageSums = { requests: number; tokens: number; costUsd: number };

/** What comparing the hourly rollup against the rows it summarizes found. */
export type RollupAudit = {
  /** Buckets `request_logs` says should exist. Zero on an install with no traffic. */
  buckets: number;
  /** Buckets missing, extra, or disagreeing on a counter. */
  mismatched: number;
  ok: boolean;
};

export interface UsageRepo {
  /**
   * Records a request that has started. Writes no rollup: a request that has
   * not finished has no tokens and no cost to accumulate.
   */
  begin(log: RequestLog): Promise<void>;
  /** Updates routing fields on a pending row without completing or rolling it up. */
  route(
    id: string,
    target: { provider: ProviderId; model: string; credentialId: string },
  ): Promise<void>;
  /**
   * Completes a request, writing the `usage_daily` rollup in the same
   * transaction. Upserts, so it serves both a request that began and one that
   * failed before dispatch, but must run at most once per id: a second call
   * would count the same request into the rollup twice.
   */
  append(log: RequestLog): Promise<void>;
  /**
   * Completes every pending row whose owner is gone, as `interrupted`.
   *
   * Own rows — this process's `nodeId` — are always swept, because at boot
   * there are none and anything under that id is a fresh id's leftovers;
   * another process's rows are swept only once its heartbeat is older than
   * `NODE_GRACE_MS`, or it never wrote one. On one node this is every pending
   * row at startup, which is what it was before. Returns how many were swept.
   */
  sweepPending(now: number): Promise<number>;
  /**
   * The newest rows, newest first, optionally restricted to one API key.
   *
   * The limit applies after the filter, so a key whose rows are all older than
   * another's still fills a page rather than being paged out by traffic it
   * cannot see. Anonymous rows carry a NULL `api_key_id` and match no scope.
   */
  recent(limit: number, apiKeyId?: string): Promise<RequestLog[]>;
  aggregate(q: UsageQuery): Promise<UsageBucket[]>;
  /**
   * What one API key has consumed since an instant, for the sliding windows a
   * rate limiter cannot hold in memory.
   *
   * Separate from `aggregate`, which groups by reporting dimension and is the
   * wrong shape and the wrong cost for a check on the request hot path.
   *
   * Exactly sliding, and bounded: read from `usage_rollup` for the hours wholly
   * inside the window and from `request_logs` for the partial hour the instant
   * lands in. `bun:sqlite` is synchronous, so a query here blocks the whole
   * event loop for its duration — the scan this replaced grew with everything
   * the install had ever served, and took ten seconds at eight million rows.
   *
   * Pending rows are excluded. Their tokens and cost are placeholder zeros, not
   * measurements, and including them adds one placeholder per in-flight request
   * to every long-window count — invisibly, and increasingly under load, which
   * is exactly when the limit matters.
   */
  sumSince(apiKeyId: string, sinceMs: number): Promise<UsageSums>;
  /**
   * The same sums, one row per `grainMs`-wide bucket since `sinceMs`, keyed by
   * bucket start. What seeds the limiter's shared counters after a restart.
   *
   * At the hour grain this reads `usage_rollup` and is flat in window length;
   * at any finer grain it groups `request_logs`, which is one key's rows over
   * the window — a seed-time cost, paid once per key per process, never on
   * the request path.
   */
  sumBuckets(
    apiKeyId: string,
    sinceMs: number,
    grainMs: number,
  ): Promise<Array<[bucketStart: number, sums: UsageSums]>>;
  /**
   * Recomputes the hourly rollup from `request_logs`, whole.
   *
   * The rollup is derived, never authoritative: the log is the source of truth
   * and every bucket is reproducible from it. That is what makes a disagreement
   * a repairable cache rather than two records neither of which can be
   * believed. Run after a database restore and by the `010` migration, and
   * never on the request path — it is a full grouped scan.
   */
  rebuildRollup(): Promise<void>;
  /**
   * Compares every rollup bucket against the rows it summarizes.
   *
   * A diagnostic, with the same full-scan cost `sumSince` exists to avoid, so
   * it is run by `omni doctor` and by nothing that serves a request.
   */
  auditRollup(): Promise<RollupAudit>;
  /**
   * The `at` of the oldest completed row this key still has inside a window, or
   * null where it has none.
   *
   * The instant a sliding window actually frees a slot: that row plus the
   * window's length. Every other count in this repo answers how much has been
   * used; this one answers when some of it stops counting, which is the only
   * honest figure to put in a `Retry-After`.
   *
   * Read only when a request is being refused. A window's far end is
   * `now + windowMs`, which is the safe over-statement to report on the path
   * where nothing acts on it, and this is a second query on a hot path.
   *
   * Served by `idx_request_logs_key_at`, and pending rows are excluded for the
   * same reason `sumSince` excludes them: a request admitted a moment ago is
   * not a measurement, and letting one answer here would report that the window
   * frees nothing for a whole window.
   */
  oldestSince(apiKeyId: string, sinceMs: number): Promise<number | null>;
  /**
   * Drops rows older than an instant, and the hourly buckets that summarized
   * them: a counter that outlives its rows reports history the log no longer
   * holds, to a limiter and to `auditRollup` alike.
   */
  prune(olderThan: number): Promise<number>;
  /** Prunes the daily rollup, which is kept far longer than the raw logs. */
  pruneDaily(olderThan: number): Promise<number>;
}

/**
 * The database's own account of its size and schema.
 *
 * Page geometry rather than bytes: `pageSize * pageCount` is the logical size
 * SQLite believes in, which is what `freelistCount` is a fraction of. The bytes
 * actually on disk are a filesystem question and belong to whoever can `stat`.
 */
export type DatabaseStats = {
  pageSize: number;
  pageCount: number;
  /** Pages already reclaimed by deletion and reusable without growing the file. */
  freelistCount: number;
  /** Highest applied migration id. Zero for a file with no migrations table. */
  schemaVersion: number;
};

/** What `inspect` observed about a database file. */
export type DatabaseInspection = {
  /** True only when the file passed integrity *and* looks like one of ours. */
  ok: boolean;
  /**
   * What `PRAGMA quick_check` said, or `unreadable` when the file could not be
   * opened as a database at all.
   *
   * The SQLite error is deliberately not forwarded: this string is shown to
   * operators and reaches logs, and the messages carry the path.
   */
  quickCheck: string;
  /** Every user table found, sorted, so a foreign database reports what it is. */
  tables: string[];
  /** Row counts for the required tables, empty when the file is not one of ours. */
  counts: Record<string, number>;
};

/**
 * Whole-database operations, as opposed to reads and writes of rows.
 *
 * `vacuum` and `snapshotTo` both hold a write lock for their duration and are
 * therefore the caller's to serialise; this repo does not guard against a
 * second concurrent call.
 */
/** How long a process may go without a heartbeat before its rows are retirable. */
export const NODE_GRACE_MS = 60_000;

export interface MaintenanceRepo {
  stats(): Promise<DatabaseStats>;
  /** Records this process as alive at `now`; forgets nodes unseen for a day. */
  heartbeat(now: number): Promise<void>;
  /** Every process heard from within `NODE_GRACE_MS` of `now`, most recent first. */
  nodes(now: number): Promise<Array<{ id: string; seenAt: number }>>;
  /** Rewrites the file, reclaiming freelist pages. Blocking. */
  vacuum(): Promise<void>;
  /**
   * Writes a self-contained copy to `path` with `VACUUM INTO`, folding in the
   * write-ahead log. Throws if the file already exists, as SQLite does.
   */
  snapshotTo(path: string): Promise<void>;
  /**
   * Judges a database file without touching the live one. Opened read-only, so
   * looking at a file cannot migrate it, recover its write-ahead log, or create
   * anything beside it.
   */
  inspect(path: string): Promise<DatabaseInspection>;
}

/**
 * One numbered migration as a plugin ships it.
 *
 * `sql` is written against `{{name}}` placeholders rather than real table names;
 * see `PluginRepo` for why the plugin never spells a table name itself.
 */
export type PluginMigration = {
  version: number;
  sql: string;
};

/**
 * What one `migrate` call did, reported rather than thrown.
 *
 * A failing migration must not take the gateway down with it — the spec makes a
 * plugin "skipped and reported, never fatal" — so the failure is a value the
 * host logs and `omni doctor` surfaces, not an exception the boot path has to
 * remember to catch. `applied` lists only the versions this call committed, so
 * a second call on an unchanged plugin returns an empty array rather than
 * repeating history.
 *
 * `failed` is absent, not `null`, when every unapplied migration committed:
 * `exactOptionalPropertyTypes` is on, so the absence is checkable and cannot be
 * confused with a present-but-empty failure.
 */
export type PluginMigrateResult = {
  applied: number[];
  failed?: { version: number; reason: string };
};

/**
 * A plugin's own slice of the gateway database.
 *
 * Plugin tables live in the gateway's SQLite file rather than a sidecar of their
 * own, so plugin data rides snapshots, restores, and `vacuum()` with everything
 * else and an operator has one file to back up. The cost of that decision is
 * that a plugin writes SQL into the same namespace core does, which is what the
 * rest of this interface is about.
 *
 * Every method takes `pluginId` first. It is not decoration and it is not an
 * audit field: it is the namespace. Plugin SQL never names a table. It writes
 * `{{caught}}` and this repo expands that to `plugin_<pluginId>_caught`, so a
 * plugin cannot name a table belonging to another plugin without the host
 * handing it the other plugin's id, which nothing does.
 *
 * The guard on top of that expansion — a denylist of core table names — is a
 * **guardrail, not a sandbox**, in exactly the sense the spec uses the phrase. A
 * plugin runs `import`ed into the gateway process; it can import `@omni/store`
 * directly and read whatever it likes. What this catches is the accident: a
 * migration copy-pasted from a query against `request_logs`, a `DELETE` whose
 * `FROM` was never edited. It does not and cannot stop code that means harm, and
 * nothing built on top of it should be described as if it did.
 */
export interface PluginRepo {
  /**
   * Applies every unapplied migration in ascending version order, **each in its
   * own transaction**, recording each as it commits.
   *
   * One transaction around the whole batch would be tidier and is wrong. A
   * plugin whose migration 5 fails would have 1 through 4 rolled back with it,
   * and since nothing was recorded, the next boot would apply 1 through 4 again
   * and fail on 5 again — turning one bad migration into data loss repeated on
   * every restart. Committing each one separately means a failure stops the
   * plugin at a known, durable schema version that its author can write a
   * migration 6 against.
   *
   * Already-applied versions are skipped. A failure stops the walk: later
   * versions are not attempted, because a migration ordering exists precisely
   * so that later ones may assume earlier ones ran.
   */
  migrate(pluginId: string, migrations: readonly PluginMigration[]): Promise<PluginMigrateResult>;
  /** Executes a statement. `sql` is placeholder-expanded and guarded first. */
  run(pluginId: string, sql: string, params?: unknown[]): Promise<void>;
  /** Every matching row. Rows are shaped by the plugin's own query, not by us. */
  all<T>(pluginId: string, sql: string, params?: unknown[]): Promise<T[]>;
  /** The first matching row, or `null` when there is none. */
  get<T>(pluginId: string, sql: string, params?: unknown[]): Promise<T | null>;
  /**
   * Runs `fn` inside a transaction.
   *
   * Async, so a Postgres store can serve it on a connection of its own. On
   * SQLite there is one connection and it is synchronous, so the transaction
   * is real only for as long as `fn` awaits nothing but storage calls: those
   * settle in the microtask queue, ahead of any I/O, so no other write can
   * land inside it. An `fn` that awaits a fetch or a timer opens the
   * transaction to every write the gateway makes meanwhile, and a rollback
   * takes them with it. Plugin work belongs off the request path either way.
   */
  transaction<T>(pluginId: string, fn: () => Promise<T>): Promise<T>;
  /** This plugin's tables, by their real names, sorted. */
  listTables(pluginId: string): Promise<string[]>;
  /**
   * Drops every table this plugin owns and forgets its migration history.
   * Returns how many tables went.
   *
   * For `omni plugin remove --purge` and nothing else. Plain `remove` leaves the
   * tables, because a plugin being uninstalled is not evidence its data is
   * unwanted, and this operation has no undo.
   */
  dropAll(pluginId: string): Promise<number>;
  /**
   * `plugin_*` tables belonging to no installed plugin, sorted.
   *
   * Restoring a snapshot taken on an install that had a plugin, onto one that
   * does not, leaves these behind. They stay. This method **reports and never
   * drops**: a restore is exactly when a plugin is most likely to be missing —
   * installed a minute later by the same operator — and auto-dropping would
   * destroy the data the restore was performed to recover. `omni doctor` prints
   * what this returns and leaves the decision to a human.
   */
  orphanTables(installedIds: readonly string[]): Promise<string[]>;
}

export type RoutingChange =
  | { type: "healthSaved"; rows: CredentialHealth[] }
  | { type: "quotaSaved"; rows: QuotaWindow[] }
  | { type: "credentialsChanged" }
  | { type: "modelsChanged" }
  | { type: "settingsChanged" };

export interface RoutingChangeSource {
  /** SQLite connection-local view of commits made by other connections. */
  version(): number;
  subscribe(listener: (change: RoutingChange) => void): () => void;
}

export type Store = {
  /**
   * Where this store's database file is, as it was opened.
   *
   * Exposed because callers that need to locate a sibling directory or stat the
   * file already depend on it implicitly — `bodiesDirFor` derives the artifact
   * tree from exactly this value — and rediscovering it from configuration is
   * how the two end up pointing at different installations.
   */
  databasePath: string;
  credentials: CredentialRepo;
  config: ConfigRepo;
  keys: KeyRepo;
  usage: UsageRepo;
  bodies: BodyRepo;
  maintenance: MaintenanceRepo;
  plugins: PluginRepo;
  routing: RoutingChangeSource;
  /**
   * Closes the current database handle and opens a new one at `databasePath`.
   *
   * Every repo above is a stable object forwarding to whichever handle is
   * current, so a caller holding one from before the call keeps working and
   * reads whatever is at the path now. Routing subscriptions survive too.
   *
   * Idempotent with `close`: a restore closes the handle, moves the file into
   * place, then reopens.
   */
  reopen(): Promise<void>;
  close(): void;
};

export const DEFAULT_SETTINGS: Settings = {
  weights: { tier: 10, health: 3, quota: 2, load: 2, cost: 1, latency: 1 },
  maxAttempts: 3,
  requestDeadlineMs: 120_000,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
  logRetentionDays: 30,
  quotaPollIntervalMs: 300_000,
  rtkEnabled: false,
  autoCacheEnabled: true,
  ponytailMode: "off",
  bodyLoggingEnabled: false,
  bodyLoggingCaptureStreamChunks: false,
  snapshotKeepLatest: 5,
  snapshotMaxAgeDays: 30,
};
