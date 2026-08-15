import { GatewayError, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { Store } from "@omni/store";
import { isAuthorizationPending } from "./oauth/kimi.ts";
import { createPendingFlows, type StoredFlow } from "./oauth/pending.ts";
import type { AuthorizeStart, OAuthProvider } from "./oauth/types.ts";

const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "kimi", "grok", "custom"];
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
 * the exchange. A provider absent from this table redirects nowhere and hands
 * the operator a code directly.
 */
const CALLBACKS: Readonly<Partial<Record<ProviderId, { uri: string; label: string }>>> = {
  openai: { uri: "http://localhost:1455/auth/callback", label: "OpenAI" },
  grok: { uri: "http://127.0.0.1:56121/callback", label: "Grok" },
};

export type ConnectDeps = {
  store: Store;
  providers: Readonly<Partial<Record<ProviderId, OAuthProvider>>>;
  http: HttpClient;
  now: () => number;
  logger?: Logger;
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

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}

function deviceIdFrom(start: AuthorizeStart): string {
  const deviceId = start.pending.extra?.deviceId;
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw new GatewayError("INTERNAL", "device authorization did not provide a device id");
  }
  return deviceId;
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
  const callbackUri = (provider: ProviderId) => CALLBACKS[provider]?.uri ?? "";

  /**
   * Accepts what the operator actually has in hand.
   *
   * A loopback flow ends at a URL the operator copies out of the browser, so
   * the whole URL is accepted and unpicked here rather than asking them to
   * extract the code themselves. Anything that is not a URL — the `code#state`
   * an Anthropic-style flow shows — passes through untouched.
   */
  function normalizeAuthorizationCode(flow: StoredFlow, input: string): string {
    const callback = CALLBACKS[flow.provider];
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
    /** Begins an authorization and returns what the operator must act on. */
    async start(providerInput: unknown, labelInput?: unknown): Promise<ConnectStart> {
      flows.sweep();

      if (!isProviderId(providerInput)) {
        throw new GatewayError(
          "BAD_REQUEST",
          "provider must be one of anthropic, openai, kimi, grok",
        );
      }
      const label =
        typeof labelInput === "string" && labelInput.trim().length > 0
          ? labelInput.trim()
          : providerInput;

      const provider = deps.providers[providerInput];
      if (provider === undefined) {
        throw new GatewayError("BAD_REQUEST", "provider does not support OAuth");
      }
      const redirectUri = callbackUri(providerInput);
      const oauthDeps = { http: deps.http, now: deps.now };
      const start =
        provider.begin === undefined
          ? await provider.start({ redirectUri }, oauthDeps)
          : await (async () => {
              const initial = await provider.start({ redirectUri }, oauthDeps);
              return provider.begin?.({ deviceId: deviceIdFrom(initial) }, oauthDeps);
            })();
      if (start === undefined) {
        throw new GatewayError("INTERNAL", "device authorization could not start");
      }

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
