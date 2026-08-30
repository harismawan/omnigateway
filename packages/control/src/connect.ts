import { GatewayError, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import {
  PROVIDER_DESCRIPTORS,
  type ProviderDescriptors,
  PROVIDER_IDS as REGISTRY_PROVIDER_IDS,
} from "@omni/providers/descriptors";
import type { Store } from "@omni/store";
import { createPendingFlows, type StoredFlow } from "./oauth/pending.ts";
import type { AuthorizeStart, DeviceOAuthProvider, OAuthProvider } from "./oauth/types.ts";
import { isAuthorizationPending } from "./oauth/types.ts";

/**
 * Every provider the installation knows about.
 *
 * Derived from the provider registry rather than restated. Two hand-written
 * copies of this list had already drifted once — see the note above
 * `OAUTH_PROVIDER_IDS` in `oauth/index.ts` — and this was a third.
 */
export const PROVIDER_IDS: readonly ProviderId[] = REGISTRY_PROVIDER_IDS;
const FLOW_TTL_MS = 600_000;

/**
 * Where a redirect flow sends the operator's browser, per provider.
 *
 * Nothing here binds a port. The gateway is as often as not on a different
 * machine than the browser, so the redirect is *expected* to fail to connect:
 * the operator copies the resulting URL out of the address bar and pastes it
 * back, and `normalizeAuthorizationCode` unpicks it. The value therefore only
 * has to be a redirect the provider itself accepts.
 *
 * xAI binds an ephemeral loopback port in its own client, which nothing here
 * can reproduce, so the port is the fixed one its local-dev path uses. The
 * `/callback` path is not a guess and must not be "tidied" to match OpenAI's
 * `/auth/callback` above: xAI's own client redirects to
 * `http://127.0.0.1:PORT/callback` (`auth/oidc/login.rs`), and redirect URIs are
 * matched exactly, so the wrong path fails at the authorize step rather than at
 * the exchange. A provider whose descriptor names no callback redirects nowhere
 * and hands the operator a code directly.
 *
 * A function rather than the `Object.fromEntries` table this replaced, which was
 * wrong twice over. It was a module-scope snapshot — built at import, before
 * `loadPlugins()` — so a provider registered at boot would have redirected
 * nowhere with nothing to explain it. And being an ordinary object it answered
 * for `constructor` and `toString`, the same defect `PROVIDER_DESCRIPTORS` drops
 * its prototype to avoid. Reading the descriptor at call time has neither
 * problem and needs no second table to keep in step with the first.
 */
function callbackOf(
  provider: ProviderId,
  descriptors: ProviderDescriptors,
): { uri: string; label: string } | undefined {
  return descriptors[provider]?.callback;
}

export type ConnectDeps = {
  store: Store;
  providers: Readonly<Partial<Record<ProviderId, OAuthProvider>>>;
  http: HttpClient;
  now: () => number;
  logger?: Logger;
  /**
   * The provider registry this installation actually has.
   *
   * **Injected, and defaulting to the module global is only right for the
   * gateway.** `start` asks two questions of it — does this provider exist, and
   * what redirect does it use — and both were asked of `PROVIDER_DESCRIPTORS`
   * directly. The gateway populates that global at boot through
   * `registerProvider`; **the CLI never does and must not**, because
   * `loadPlugins` runs migrations, opens channels and registers routes, none of
   * which a diagnostic should do.
   *
   * So `omni connect <plugin-provider>` admitted the id at its own gate and was
   * then refused here, by a message that named the provider it had just
   * refused — `unconnectable()` builds its list from the *injected* map while
   * the guard above it read the *global* one. Two registries, one call,
   * opposite answers: the trap CLAUDE.md calls this repository's most repeated
   * bug, and `credentials.ts` had already paid for it once with
   * `ProviderExists`.
   *
   * The registry rather than a predicate, because the callback lookup has the
   * same hole and a predicate would have closed one of the two — a plugin's
   * PKCE flow would have received `redirectUri: ""` and failed at the
   * authorization server instead.
   */
  descriptors?: ProviderDescriptors;
};

/** What the operator needs in order to authorize, however they are shown it. */
export type ConnectStart = {
  flowId: string;
  authorizeUrl: string;
  userCode: string | null;
  kind: OAuthProvider["kind"];
  supportsManualPaste: boolean;
  pollIntervalMs: number;
};

/** A poll either produced a credential or is still waiting on the operator. */
export type ConnectPoll = { status: "complete"; id: string } | { status: "pending" };

/**
 * Whether this names a provider this installation has — not whether it can be
 * connected.
 *
 * `custom` is a `ProviderId` and has no authorization to start, so this is the
 * wrong question for the connect path and the right one for `add-key`. Callers
 * that mean "can I begin an OAuth flow for this" ask the provider table.
 *
 * Reads the registry at call time. It used to read `PROVIDER_IDS`, which is
 * `Object.keys(...)` evaluated at import and therefore a snapshot taken before
 * `loadPlugins()` ever runs — so a provider registered at boot would have been
 * reported as not existing.
 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(PROVIDER_DESCRIPTORS, value);
}

/**
 * The device identity `start` minted, checked against what the provider said it
 * needs.
 *
 * Not every device flow has one: Kimi ties a session to a device fingerprint it
 * has to mint before asking for a code, while Kilo identifies an editor and has
 * no per-machine identity at all. The difference is `needsDeviceId`, declared on
 * the provider, so a new device flow has to answer the question at the point of
 * writing rather than discovering the answer from upstream.
 *
 * `INTERNAL` because a provider that needs an identity and did not get one is a
 * gateway bug, not something the operator did. Sending `""` upstream instead
 * would come back as a provider-side auth failure, which reads as anything but
 * a routing bug.
 */
function deviceIdFrom(provider: DeviceOAuthProvider, start: AuthorizeStart): string {
  const deviceId = start.pending.extra?.deviceId;
  // Whitespace is not an identity: a blank string reaches the provider looking
  // like a value and is refused as one.
  if (typeof deviceId === "string" && deviceId.trim().length > 0) return deviceId;
  if (provider.needsDeviceId) {
    throw new GatewayError("INTERNAL", "device authorization did not provide a device id");
  }
  return "";
}

/**
 * The authorization flows in progress, and the operations that move them along.
 *
 * Flows live in memory: an interrupted authorization is abandoned rather than
 * resumed, and nothing half-authorized is ever written down. Each front end
 * (the control API, the CLI) owns its own instance, which is why a flow started
 * in the console cannot be finished from the terminal.
 */
export function createConnectFlows(deps: ConnectDeps) {
  const logger = deps.logger ?? noopLogger;
  const flows = createPendingFlows({ now: deps.now, ttlMs: FLOW_TTL_MS });
  const pollsInFlight = new Map<string, Promise<{ id: string }>>();
  const descriptors = deps.descriptors ?? PROVIDER_DESCRIPTORS;
  const callbackUri = (provider: ProviderId) => callbackOf(provider, descriptors)?.uri ?? "";
  /** Existence against the installation, never against the compiled-in six. */
  const exists = (value: unknown): value is ProviderId =>
    typeof value === "string" && Object.hasOwn(descriptors, value);
  /**
   * Read at call time from the map this instance was handed.
   *
   * One function with two readers — the exported method and `start`'s own
   * refusal message — because they answer the same question and a second
   * `Object.keys(deps.providers)` inline is how the two come to disagree.
   */
  const connectableIds = (): readonly string[] => Object.keys(deps.providers);

  /**
   * Accepts what the operator actually has in hand.
   *
   * A loopback flow ends at a URL the operator copies out of the browser, so
   * the whole URL is accepted and unpicked here rather than asking them to
   * extract the code themselves. Anything that is not a URL — the `code#state`
   * an Anthropic-style flow shows — passes through untouched.
   */
  function normalizeAuthorizationCode(flow: StoredFlow, input: string): string {
    const callback = callbackOf(flow.provider, descriptors);
    if (callback === undefined) return input;
    const expected = new URL(callback.uri);

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return input;
    }

    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new GatewayError("BAD_REQUEST", `invalid ${callback.label} callback URL`);
    }

    const code = url.searchParams.get("code")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? "";
    if (code.length === 0 || state.length === 0) {
      throw new GatewayError(
        "BAD_REQUEST",
        `${callback.label} callback URL must contain code and state`,
      );
    }
    if (state !== flow.pending.state) {
      throw new GatewayError("AUTH", "authorization state mismatch");
    }
    return `${code}#${state}`;
  }

  /** Runs the exchange and persists the resulting credential. */
  async function complete(flow: StoredFlow, code: string): Promise<{ id: string }> {
    const provider = deps.providers[flow.provider];
    if (provider === undefined)
      throw new GatewayError("BAD_REQUEST", "provider does not support OAuth");
    const result = await provider.exchange(
      { code, pending: flow.pending },
      { http: deps.http, now: deps.now },
    );

    const id = crypto.randomUUID();
    await deps.store.credentials.create({
      id,
      provider: flow.provider,
      label: flow.label,
      authType: "oauth",
      enabled: true,
      tier: 1,
      weight: 1,
      expiresAt: result.expiresAt,
      accountEmail: result.accountEmail,
      providerData: result.providerData,
      disabledReason: null,
      disabledAt: null,
      ...result.secrets,
    });
    logger.info("oauth connect completed", {
      provider: flow.provider,
      credentialId: id,
    });
    return { id };
  }

  async function pollOutcome(flowId: string, poll: Promise<{ id: string }>): Promise<ConnectPoll> {
    try {
      const created = await poll;
      flows.take(flowId);
      return { status: "complete", ...created };
    } catch (error) {
      if (isAuthorizationPending(error)) return { status: "pending" };
      flows.take(flowId);
      throw error;
    }
  }

  return {
    /**
     * The providers this installation can start an authorization for.
     *
     * Read from `deps.providers` at call time, which is the whole point: the
     * map is assembled per caller — the gateway merges what plugins registered
     * at boot, the CLI merges what `readPluginProviders` read — so a
     * module-scope snapshot of the built-in table answers for neither.
     * `OAUTH_PROVIDER_IDS` was exactly that snapshot and it gated
     * `omni connect`, so a plugin's provider would have been refused by a list
     * compiled before it could exist.
     *
     * That is the sixth site in this repository to read a registry at import
     * time and be wrong the same way; CLAUDE.md names the other five.
     */
    connectableIds,

    /** Begins an authorization and returns what the operator must act on. */
    async start(providerInput: unknown, labelInput?: unknown): Promise<ConnectStart> {
      flows.sweep();

      // One answer, not two. A name this gateway has never heard of and a
      // provider with no authorization to start are the same thing to the
      // caller — there is nothing here to begin — and the useful half of the
      // reply is which providers there *is* something to begin for. That list
      // is read off the injected table, so it cannot drift from what `start`
      // would actually accept the way a hand-written one did.
      const unconnectable = () =>
        new GatewayError("BAD_REQUEST", `provider must be one of ${connectableIds().join(", ")}`);

      if (!exists(providerInput)) throw unconnectable();
      const provider = deps.providers[providerInput];
      if (provider === undefined) throw unconnectable();

      const label =
        typeof labelInput === "string" && labelInput.trim().length > 0
          ? labelInput.trim()
          : providerInput;

      const redirectUri = callbackUri(providerInput);
      const oauthDeps = { http: deps.http, now: deps.now };
      const initial = await provider.start({ redirectUri }, oauthDeps);
      const start =
        provider.kind === "device"
          ? await provider.begin({ deviceId: deviceIdFrom(provider, initial) }, oauthDeps)
          : initial;

      const flowId = flows.put({
        provider: providerInput,
        label,
        pending: start.pending,
        ...(start.userCode === undefined ? {} : { userCode: start.userCode }),
      });

      return {
        flowId,
        authorizeUrl: start.authorizeUrl,
        userCode: start.userCode ?? null,
        kind: provider.kind,
        supportsManualPaste: provider.supportsManualPaste,
        pollIntervalMs: (start.pending.interval ?? 5) * 1000,
      };
    },

    /** Completes a redirect flow from the code or callback URL the operator pasted. */
    async finish(flowIdInput: unknown, codeInput: unknown): Promise<{ id: string }> {
      if (typeof flowIdInput !== "string" || typeof codeInput !== "string") {
        throw new GatewayError("BAD_REQUEST", "flowId and code are required");
      }

      const flow = flows.take(flowIdInput);
      if (flow === null) throw new GatewayError("BAD_REQUEST", "unknown or expired authorization");

      return complete(flow, normalizeAuthorizationCode(flow, codeInput));
    },

    /**
     * Asks a device-code provider whether the operator has approved yet.
     *
     * Concurrent polls share one in-flight exchange: two callers asking at once
     * must not each redeem the device code, because the second redemption is
     * the one the provider refuses.
     */
    async poll(flowIdInput: unknown): Promise<ConnectPoll> {
      if (typeof flowIdInput !== "string") {
        throw new GatewayError("BAD_REQUEST", "flowId is required");
      }

      const existing = pollsInFlight.get(flowIdInput);
      if (existing !== undefined) return pollOutcome(flowIdInput, existing);

      const flow = flows.peek(flowIdInput);
      if (flow === null) throw new GatewayError("BAD_REQUEST", "unknown or expired authorization");

      const poll = complete(flow, "").finally(() => {
        pollsInFlight.delete(flowIdInput);
      });
      pollsInFlight.set(flowIdInput, poll);
      return pollOutcome(flowIdInput, poll);
    },
  };
}

export type ConnectFlows = ReturnType<typeof createConnectFlows>;
