import { type ErrorCode, GatewayError } from "@omni/ir";
import type { CredentialSecrets, UsageSecrets, WindowType } from "@omni/store/types";
import type { HeaderPair } from "./types.ts";

/**
 * The OAuth flow contract, and the vocabulary a provider's flow is written in.
 *
 * Here rather than in `@omni/control` because what lives beside it now does:
 * each built-in provider's flow is `<provider>/oauth.ts` in this package, where
 * boundary rule 2 puts provider wire detail. A vendor's authorize endpoint,
 * scopes and client id are as much its wire surface as its SSE framing, and
 * core compiling five vendors' worth of them in was rule 16's last enumerated
 * violation.
 *
 * What stayed in control is the **mechanism**: `oauthAdapter` performs the
 * requests a flow yields, `pending.ts` holds an authorization open,
 * `refresh.ts` decides what a failure means for a credential. This file is the
 * contract between the two, so it names no vendor and no transport — a flow
 * describes requests and the host sends them, exactly as `ProviderCodec` does
 * for inference.
 *
 * Only `import type` reaches `@omni/store`. The three names taken from it are
 * the shapes a credential is written back as, and a type-only edge adds no
 * runtime dependency — the leaf-subpath rule this package lives under is
 * measured on the import graph a bundler walks, which type imports never enter.
 */

/**
 * One request a flow asks the host to perform.
 *
 * A generator rather than a build/parse pair, because a pair cannot express what
 * the shipped flows do. Measured across the five built-ins: most steps are one
 * request, `grok.start` is a discovery call followed by local work, and
 * `kilo.exchange` is **two** — it polls for a token and then reads the account's
 * organization id *with* that token, so the second request's existence and
 * content depend on the first response's body.
 */
export type AuthRequest = {
  url: string;
  method: string;
  headers: readonly HeaderPair[];
  body?: string;
  /**
   * How long this one call may take, bounded by the host.
   *
   * Here because the built-in flows deliberately use **two** deadlines, and a
   * single host constant could not say so: a token call gets 30s because an
   * operator is waiting on it, and a usage probe gets 15s because nothing on
   * the request path waits for one and a slow probe should be abandoned rather
   * than retried. Porting the five found this — the fixture that stood in for
   * them had one kind of call and so could not.
   *
   * Clamped by the host, and absent means the host's maximum. A flow can
   * therefore shorten its own deadline but never extend it past what the host is
   * willing to hold a connect flow open for.
   */
  timeoutMs?: number;
};

/**
 * What the host hands back for a yielded request.
 *
 * `body` is text the host has already read, for the same reason
 * `CodecErrorInput.body` is: a flow that received the response could re-read the
 * stream or reach the socket, and it needs neither.
 *
 * `status` is here because these flows read it as meaning, not merely as
 * success: `kilo.exchange` treats 202 as "keep polling", 403 as denied and 410
 * as expired, and collapsing those into an error would lose the difference
 * between "not yet" and "no".
 */
export type AuthResponse = {
  status: number;
  headers: Headers;
  body: string;
};

/**
 * What every step is given besides its own arguments.
 *
 * Each exists because the flow cannot or should not do it itself:
 *
 * - `fail` builds the **host's** `GatewayError`. A plugin ships as a
 *   self-contained tree with no `node_modules`, so a class it imports is a
 *   bundled copy and `instanceof` against it is false — the defect that made a
 *   codec's deliberate `AUTH` read as an unclassified failure.
 * - `keepPolling` is the device-poll "not approved yet" signal. It carries a
 *   private marker a plugin has no way to set, so without this a device flow
 *   cannot say "not yet" at all — it could only fail, and the host would stop.
 *   Named for what it asks the host to do rather than `pending`, because
 *   `exchange` is already handed `pending: PendingFlow` — the stored state of
 *   the authorization — and one name for two things in one argument object is
 *   how an author reaches for the wrong one.
 * - `pkce` and `randomState` cover the randomness **OAuth itself** needs, and
 *   keep `start` testable.
 *
 *   Not "a plugin needs no crypto", which is what this said until porting kimi
 *   disproved it: a device flow that binds a session to a machine fingerprint
 *   mints that itself — `mintKimiDevice` — and nothing here replaces it. The
 *   narrow claim is the true one, and the wide one is the kind a contributor
 *   preserves while breaking the real thing.
 * - `now` because a flow that read the clock directly could not be tested
 *   against an expiry, which `kilo.exchange` checks before it polls.
 */
export type AuthHelpers = {
  fail(code: ErrorCode, message: string, opts?: { status?: number }): GatewayError;
  keepPolling(reason: string): GatewayError;
  pkce(): { verifier: string; challenge: string };
  randomState(): string;
  now(): number;
};

/**
 * A step: yields requests for the host to perform, returns when it has its answer.
 *
 * A request that fails at the transport is raised **at the yield**, so a step
 * that tolerates one — `kilo.exchange`'s organization read — catches it there
 * like any other call.
 */
export type AuthStep<T> = AsyncGenerator<AuthRequest, T, AuthResponse>;

/** The gateway-side half of an in-flight authorization, held until it completes. */
export type PendingFlow = {
  verifier: string;
  challenge: string;
  state: string;
  redirectUri: string;
  /** Device-code flows carry their poll handle here instead of a redirect. */
  deviceCode?: string;
  interval?: number;
  /** Anything a provider needs to remember between start and finish. */
  extra?: Record<string, unknown>;
};

export type AuthorizeStart = {
  /** Open in a browser (PKCE) or show to the operator (device code). */
  authorizeUrl: string;
  /** Shown alongside the URL by device-code providers. */
  userCode?: string;
  pending: PendingFlow;
};

export type FlowResult = {
  secrets: CredentialSecrets;
  expiresAt: number | null;
  accountEmail: string | null;
  /** Merged into `credential.providerData` — account ids, device ids, endpoints. */
  providerData: Record<string, unknown>;
};

/**
 * One usage window as the provider described it.
 *
 * `used` and `limit` carry the provider's own unit. Providers that report a
 * percentage are normalized to `used: 87, limit: 100` by their probe, so the
 * router and the console never have to know which is which.
 */
export type UsageWindowReport = {
  windowType: WindowType;
  used: number;
  limit: number | null;
  resetsAt: number | null;
  /**
   * How long the window runs for, when the provider said so.
   *
   * `windowType` is one of three names, so a provider that reports a real
   * duration has it rounded to the nearest of them. Codex states
   * `limit_window_seconds`, and a three-hour window filed under `fiveHour`
   * would have its start inferred two hours too early. Null is the normal
   * answer: Anthropic and Kimi state no duration at all.
   */
  windowMs: number | null;
};

export type UsageReport = { windows: UsageWindowReport[] };

/**
 * The flow a provider declares beside its descriptor and codec.
 *
 * Mirrors `OAuthProvider` in `@omni/control`, which is what the host consumes,
 * so that `oauthAdapter` is the only thing that has to know the difference —
 * exactly as `codecAdapter` is for the inference path.
 */
type PluginFlowBase = {
  readonly supportsManualPaste: boolean;
  start(input: { redirectUri: string } & AuthHelpers): AuthStep<AuthorizeStart>;
  exchange(input: { code: string; pending: PendingFlow } & AuthHelpers): AuthStep<FlowResult>;
  refresh(
    input: { refreshToken: string; providerData: Record<string, unknown> } & AuthHelpers,
  ): AuthStep<FlowResult>;
  usage?(
    input: { secrets: UsageSecrets; providerData: Record<string, unknown> } & AuthHelpers,
  ): AuthStep<UsageReport | null>;
};

/** A redirect flow. Mirrors `PkceOAuthProvider`. */
export type PkcePluginFlow = PluginFlowBase & { readonly kind: "pkce" };

/**
 * A device-code flow. Mirrors `DeviceOAuthProvider`, `begin` and all.
 *
 * **A union rather than one shape with two optional fields**, because the flat
 * version could not say that a device flow must have `begin` — it checked at
 * construction instead, which is late for an in-repo flow the compiler could
 * have caught. It also flattened the adapter's return type: `oauthAdapter`
 * answered `OAuthProvider`, so `kiloOAuth` stopped being a
 * `DeviceOAuthProvider` and every consumer reading `.begin` or
 * `.needsDeviceId` lost it. Porting the two device flows is what surfaced that;
 * the fixture had only ever been read back through the union.
 */
export type DevicePluginFlow = PluginFlowBase & {
  readonly kind: "device";
  readonly needsDeviceId: boolean;
  begin(input: { deviceId: string } & AuthHelpers): AuthStep<AuthorizeStart>;
};

export type PluginOAuthFlow = PkcePluginFlow | DevicePluginFlow;

/**
 * Classifies a failed token-endpoint status.
 *
 * Only a repudiation should be `AUTH`, because `createRefresher` disables the
 * credential on exactly that code. A 5xx or a 429 means the provider had a bad
 * minute, not that the refresh token is dead — classifying those as `AUTH`
 * would permanently disable healthy credentials during an outage and force the
 * operator to reconnect every account by hand.
 *
 * Codes match `codeForStatus` in this package so token failures and inference
 * failures speak the same vocabulary.
 */
export function tokenErrorCode(status: number): ErrorCode {
  // 429 is 4xx but is the clearest "try again later" there is.
  if (status === 429) return "RATE_LIMIT";
  // The provider looked at the request and refused it.
  if (status >= 400 && status < 500) return "AUTH";
  return "UPSTREAM";
}

/** Reads an error identifier out of a token response without leaking the body. */
export function tokenErrorMessage(status: number, body: unknown): string {
  const raw =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "";
  // **Shape-checked, not merely read.** `oauthAdapter`'s `trusted` marks the
  // five built-in flows' messages `gatewayAuthored`, which is what lets an
  // operator see *why* a refresh failed — and that flag claims the text is
  // built from values this repository owns. That was only nearly true: `error`
  // is upstream-supplied, and nothing checked it was the identifier RFC 6749
  // §5.2 intends. Measured at 3037 characters on stdout.
  //
  // A token endpoint never receives a prompt — the body is `grant_type`, a code
  // and a client id — so the leak this flag guards against is unreachable here.
  // But a server that echoes the offending parameter could put part of an
  // authorization code in `error`, and a claim the code does not enforce is one
  // the next contributor extends to `error_description`, which *is* free text.
  //
  // The character class admits every code the five flows act on —
  // `invalid_grant`, `invalid_client`, `expired_token`, `authorization_pending`,
  // `slow_down`, `access_denied` — and a bare `slice` would bound the length
  // while still admitting arbitrary content.
  const code = /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : `http_${status}`;
  return `token endpoint rejected the request: ${code}`;
}

/** Marks the one error a device flow raises that is not a failure. */
const PENDING_MARKER = "__omni_authorization_pending";

type MarkedPendingError = GatewayError & { [PENDING_MARKER]?: boolean };

/**
 * Whether a rejection is a device poll's "not approved yet".
 *
 * A poll that finds the operator has not approved yet has to be told apart from
 * a poll that failed, and the difference travels back through a rejected
 * promise. The marker is a property rather than a subclass because it has to
 * survive `GatewayError`'s own construction and be readable by a caller that
 * only imports this module.
 *
 * Here rather than in one provider's file because every device flow needs it:
 * kimi reads it off an OAuth `error` code, kilo off an HTTP status.
 */
export function isAuthorizationPending(error: unknown): boolean {
  return error instanceof GatewayError && (error as MarkedPendingError)[PENDING_MARKER] === true;
}

/** A "keep polling" rejection. `reason` is an identifier, never a body. */
export function pendingError(reason: string): GatewayError {
  const error = new GatewayError(
    "AUTH",
    `authorization not yet complete: ${reason}`,
  ) as MarkedPendingError;
  error[PENDING_MARKER] = true;
  return error;
}
