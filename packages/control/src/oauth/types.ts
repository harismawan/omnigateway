import { type ErrorCode, GatewayError, type ProviderId } from "@omni/ir";
import {
  type ClientProfile,
  type HeaderPair,
  type HttpClient,
  mergeHeaders,
  orderHeaders,
} from "@omni/providers";
import type { CredentialSecrets, UsageSecrets, WindowType } from "@omni/store";

/**
 * Marks the one error a device flow raises that is not a failure.
 *
 * A poll that finds the operator has not approved yet has to be told apart
 * from a poll that failed, and the difference travels back through a rejected
 * promise. The marker is a property rather than a subclass because it has to
 * survive `GatewayError`'s own construction and be readable by a caller that
 * only imports this module.
 *
 * Lives here rather than in one provider's file because every device flow needs
 * it: kimi reads it off an OAuth `error` code, kilo off an HTTP status.
 */
const PENDING_MARKER = "__omni_authorization_pending";

type MarkedPendingError = GatewayError & { [PENDING_MARKER]?: boolean };

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

/** Injected so tests never touch the network or the clock. */
export type OAuthDeps = {
  /**
   * Order-preserving transport. Token endpoints see the same client identity
   * as inference does — a request that authenticates as claude-cli and then
   * infers as something else is a louder signal than either alone.
   */
  http: HttpClient;
  now: () => number;
};

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

type OAuthProviderBase = {
  readonly id: ProviderId;
  /** Whether the operator can paste a code by hand instead of using a redirect. */
  readonly supportsManualPaste: boolean;

  /**
   * Builds what the operator has to act on.
   *
   * Awaited and handed `deps` because an endpoint is not always a constant: xAI
   * publishes its authorize endpoint through OIDC discovery, so there is a
   * network read standing between "connect grok" and there being a URL to open.
   * Providers whose endpoints are compiled-in ignore `deps` and stay synchronous.
   */
  start(opts: { redirectUri: string }, deps: OAuthDeps): AuthorizeStart | Promise<AuthorizeStart>;

  /** PKCE: exchange an authorization code. Device: poll once for a token. */
  exchange(input: { code: string; pending: PendingFlow }, deps: OAuthDeps): Promise<FlowResult>;

  /**
   * `providerData` is the credential's stored state. Kimi needs it to reuse the
   * device identity it was created with; the others ignore it.
   */
  refresh(
    refreshToken: string,
    deps: OAuthDeps,
    providerData: Record<string, unknown>,
  ): Promise<FlowResult>;

  /**
   * Reads the account's subscription usage.
   *
   * Optional: a provider with no usage surface omits it, and its accounts read
   * as unknown rather than as unlimited. Returning `null` says the same thing
   * for a provider that has the endpoint but answered with nothing usable.
   *
   * A probe reports; it never judges the credential. In particular it must not
   * treat its own 401 as a repudiation — a usage endpoint that moved would then
   * disable working accounts. That verdict belongs to token refresh alone.
   */
  usage?(
    secrets: UsageSecrets,
    deps: OAuthDeps,
    providerData: Record<string, unknown>,
  ): Promise<UsageReport | null>;
};

/**
 * A redirect flow. `start` is the whole of the start: there is nothing to mint
 * before the operator is sent to the browser, and no device identity at all.
 */
export type PkceOAuthProvider = OAuthProviderBase & {
  readonly kind: "pkce";
};

/**
 * A device-code flow: `start` prepares whatever the provider needs, `begin`
 * asks for the code the operator will approve.
 */
export type DeviceOAuthProvider = OAuthProviderBase & {
  readonly kind: "device";

  /**
   * Whether `begin` cannot work without the device identity `start` minted.
   *
   * Declared rather than inferred because the two current device flows differ
   * and nothing in their shapes says which is which: Kimi ties a session to a
   * device fingerprint and sends it on every later call, while Kilo identifies
   * an editor and has no per-machine identity to mint. `deviceIdFrom` in
   * `connect.ts` reads this and refuses to call `begin` with a blank id when it
   * is `true` — a provider that needs one and silently receives `""` sends it
   * upstream, where it comes back as an opaque provider-side auth failure
   * rather than as the internal error it is.
   *
   * Required, and required on this variant alone: a new device provider cannot
   * compile without answering, and a PKCE provider is never asked.
   */
  readonly needsDeviceId: boolean;

  /**
   * Requests a device code before the operator is shown anything. Handed the
   * device id `start` minted, or `""` when `needsDeviceId` is false.
   */
  begin(opts: { deviceId: string }, deps: OAuthDeps): Promise<AuthorizeStart>;
};

export type OAuthProvider = PkceOAuthProvider | DeviceOAuthProvider;

/** Sent by every token call. Arguments are ordered by the provider's profile. */
export async function postJson(
  deps: OAuthDeps,
  provider: ProviderId,
  url: string,
  profile: ClientProfile,
  opts: {
    contentType: string;
    body: string;
    extraHeaders?: readonly HeaderPair[];
  },
): Promise<{ status: number; parsed: unknown }> {
  const headers = orderHeaders(
    mergeHeaders(profile.headers, [
      ["Content-Type", opts.contentType],
      ["Accept", "application/json"],
      ...(opts.extraHeaders ?? []),
    ]),
    profile.order,
  );

  const res = await deps.http({
    provider,
    url,
    method: "POST",
    headers,
    body: opts.body,
    // Token calls are short and must not hang a connect flow forever.
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON error bodies are real; the caller falls back to the status.
  }
  return { status: res.status, parsed };
}

/**
 * The GET both readers share. `authHeaders` is the whole difference between
 * them, so neither can drift from the other's timeout or parsing.
 */
async function sendGet(
  deps: OAuthDeps,
  provider: ProviderId,
  url: string,
  profile: ClientProfile,
  authHeaders: readonly HeaderPair[],
  extraHeaders: readonly HeaderPair[],
): Promise<{ status: number; parsed: unknown }> {
  const headers = orderHeaders(
    mergeHeaders(profile.headers, [
      ...authHeaders,
      ["Accept", "application/json"],
      ...extraHeaders,
    ]),
    profile.order,
  );

  const res = await deps.http({
    provider,
    url,
    method: "GET",
    headers,
    body: "",
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page is a real answer; the caller falls back to the status.
  }
  return { status: res.status, parsed };
}

/**
 * Reads an account-level JSON endpoint with a bearer token.
 *
 * Same client identity as inference and the token endpoints: a process that
 * authenticates as one client and then reads its account as another is a
 * louder signal than either alone. The timeout is short because nothing on the
 * request path waits for this — a slow probe should be abandoned, not retried.
 *
 * `accessToken` is `string`, not `string | null`, and that is the point. Every
 * `usage()` probe reads a `UsageSecrets` whose token is nullable, so the
 * compiler makes each one say what it does about a credential with no token
 * before it can call this. Widen it and a probe that lost its guard would go
 * out unauthenticated, read the 401 as "no usage data", and leave the account's
 * quota reading unknown forever with nothing logged. Use
 * `getJsonUnauthenticated` where sending nothing is the intent.
 */
export function getJson(
  deps: OAuthDeps,
  provider: ProviderId,
  url: string,
  profile: ClientProfile,
  opts: { accessToken: string; extraHeaders?: readonly HeaderPair[] },
): Promise<{ status: number; parsed: unknown }> {
  return sendGet(
    deps,
    provider,
    url,
    profile,
    [["Authorization", `Bearer ${opts.accessToken}`]],
    opts.extraHeaders ?? [],
  );
}

/**
 * Reads a JSON endpoint with no credential, deliberately.
 *
 * Named rather than expressed as a null token so the absence is a word at the
 * call site and a greppable one. Kilo's device-code poll is the case: the token
 * is what the call returns, so there is nothing yet to authenticate it with,
 * and an empty bearer would be a credential claim rather than the absence of
 * one. Never use this for a call that has a token available.
 */
export function getJsonUnauthenticated(
  deps: OAuthDeps,
  provider: ProviderId,
  url: string,
  profile: ClientProfile,
  opts?: { extraHeaders?: readonly HeaderPair[] },
): Promise<{ status: number; parsed: unknown }> {
  return sendGet(deps, provider, url, profile, [], opts?.extraHeaders ?? []);
}

/**
 * Classifies a failed token-endpoint status.
 *
 * Only a repudiation should be `AUTH`, because `createRefresher` disables the
 * credential on exactly that code. A 5xx or a 429 means the provider had a bad
 * minute, not that the refresh token is dead — classifying those as `AUTH`
 * would permanently disable healthy credentials during an outage and force the
 * operator to reconnect every account by hand.
 *
 * Codes match `codeForStatus` in `@omni/providers` so token failures and
 * inference failures speak the same vocabulary.
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
  const code =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `http_${status}`;
  return `token endpoint rejected the request: ${code}`;
}
