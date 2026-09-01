import type { ProviderId } from "@omni/ir";
import type {
  AuthorizeStart,
  FlowResult,
  HttpClient,
  PendingFlow,
  UsageReport,
} from "@omni/providers";
import type { UsageSecrets } from "@omni/store";

/**
 * The host's side of an OAuth provider.
 *
 * The flow contract itself — `PluginOAuthFlow`, `AuthRequest`, `FlowResult`,
 * `UsageReport` and the token-error helpers — lives in `@omni/providers`,
 * beside the five built-in flows that are written against it. What stays here
 * is what a *host* needs: the adapted shape every consumer already takes as a
 * parameter, and the transport and clock it is performed with. Re-exported
 * rather than restated, because two spellings of one contract is how they come
 * to disagree.
 */
export {
  type AuthorizeStart,
  type FlowResult,
  isAuthorizationPending,
  type PendingFlow,
  pendingError,
  tokenErrorCode,
  tokenErrorMessage,
  type UsageReport,
  type UsageWindowReport,
} from "@omni/providers";

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
