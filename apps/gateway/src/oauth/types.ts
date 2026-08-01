import type { ProviderId } from "@omni/ir";
import {
  type ClientProfile,
  type HeaderPair,
  type HttpClient,
  mergeHeaders,
  orderHeaders,
} from "@omni/providers";
import type { CredentialSecrets } from "@omni/store";

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

export type OAuthProvider = {
  readonly id: ProviderId;
  readonly kind: "pkce" | "device";
  /** Whether the operator can paste a code by hand instead of using a redirect. */
  readonly supportsManualPaste: boolean;

  start(opts: { redirectUri: string }): AuthorizeStart;

  /**
   * Device flows only: requests a device code before the operator is shown
   * anything. PKCE providers leave this undefined and use `start` alone.
   */
  begin?(opts: { deviceId: string }, deps: OAuthDeps): Promise<AuthorizeStart>;

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
};

/** Sent by every token call. Arguments are ordered by the provider's profile. */
export async function postJson(
  deps: OAuthDeps,
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
