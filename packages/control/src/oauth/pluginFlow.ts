import { type ErrorCode, GatewayError, type ProviderId } from "@omni/ir";
import {
  type HeaderPair,
  type HttpResponse,
  isHttpMethod,
  isSendableUrl,
  withinOrigins,
} from "@omni/providers";
import type { UsageSecrets } from "@omni/store";
import { createPkce, randomState } from "./pkce.ts";
import {
  type AuthorizeStart,
  type FlowResult,
  type OAuthDeps,
  type OAuthProvider,
  type PendingFlow,
  pendingError,
  type UsageReport,
} from "./types.ts";

/**
 * A plugin's OAuth flow, and the host that performs it.
 *
 * The auth half of the `provider` capability. A plugin already describes an
 * inference request and lets the host send it — `ProviderCodec` — and this is the
 * same inversion applied to authorization: **each step is an async generator
 * that yields described requests and receives responses.** The plugin never
 * holds an `HttpClient`, so boundary rule 15 keeps its "never `HttpClient`"
 * without gaining a footnote, and a plugin author who has written a codec
 * already knows the shape.
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
 * Each exists because the plugin cannot or should not do it itself:
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
 * - `pkce` and `randomState` mean a plugin needs no crypto, and its `start`
 *   stays testable. The implementation is 21 lines already shared by every
 *   built-in flow.
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

/** A step: yields requests for the host to perform, returns when it has its answer. */
export type AuthStep<T> = AsyncGenerator<AuthRequest, T, AuthResponse>;

/**
 * The flow a plugin declares beside its descriptor and codec.
 *
 * Mirrors `OAuthProvider`, which is what the host already consumes, so that
 * `oauthAdapter` below is the only thing that has to know the difference —
 * exactly as `codecAdapter` is for the inference path.
 */
export type PluginOAuthFlow = {
  readonly kind: "pkce" | "device";
  readonly supportsManualPaste: boolean;
  /** Device flows only; see `DeviceOAuthProvider.needsDeviceId`. */
  readonly needsDeviceId?: boolean;

  start(input: { redirectUri: string } & AuthHelpers): AuthStep<AuthorizeStart>;
  /** Device flows only. */
  begin?(input: { deviceId: string } & AuthHelpers): AuthStep<AuthorizeStart>;
  exchange(input: { code: string; pending: PendingFlow } & AuthHelpers): AuthStep<FlowResult>;
  refresh(
    input: { refreshToken: string; providerData: Record<string, unknown> } & AuthHelpers,
  ): AuthStep<FlowResult>;
  usage?(
    input: { secrets: UsageSecrets; providerData: Record<string, unknown> } & AuthHelpers,
  ): AuthStep<UsageReport | null>;
};

/**
 * How many requests one step may ask for.
 *
 * `kilo.exchange` needs two, and no shipped flow needs more. The cap exists
 * because a generator can loop: without it a flow that never returns holds a
 * connect open indefinitely, and a device poll is already called in a loop by
 * the host, so the plugin has no reason to write one.
 */
const MAX_REQUESTS_PER_STEP = 4;

/** Token calls are short and must not hang a connect flow forever. */
const STEP_TIMEOUT_MS = 30_000;

function flowFailure(id: ProviderId, step: string, what: string): GatewayError {
  // `AUTH` rather than `UPSTREAM`: reaching here means this credential cannot be
  // established, and a retry against the same flow will do the same thing.
  // Built from an id the host validated and two literals this file owns, so it
  // carries nothing the plugin wrote — which is what lets it say
  // `gatewayAuthored`.
  return new GatewayError("AUTH", `${id} oauth ${step} ${what}`, {
    provider: id,
    gatewayAuthored: true,
  });
}

/** A yielded value that is actually a request the transport can be handed. */
function isAuthRequest(value: unknown): value is AuthRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthRequest>;
  return (
    // The shared predicates, not `typeof === "string"`. `nodeHttpClient` throws
    // `Invalid URL` and `ERR_INVALID_HTTP_TOKEN` synchronously inside its
    // Promise executor, so a bad url or verb from a plugin becomes a raw
    // rejection carrying plugin-authored text — measured on the inference path,
    // which is why these live in one place now.
    isSendableUrl(candidate.url) &&
    isHttpMethod(candidate.method) &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    ) &&
    (candidate.body === undefined || typeof candidate.body === "string")
  );
}

/**
 * Runs one step to completion, performing every request it asks for.
 *
 * The whole host side of this contract. Everything a flow would otherwise do
 * itself — build the call, apply a timeout, read the body, count the round
 * trips — happens here, once, rather than in each plugin.
 */
async function runStep<T>(
  id: ProviderId,
  step: string,
  gen: AuthStep<T>,
  deps: OAuthDeps,
  origins: readonly string[] | undefined,
): Promise<T> {
  try {
    return await drive(id, step, gen, deps, origins);
  } finally {
    // A step abandoned mid-flight — over the cap, outside its origins, or
    // yielding something unusable — is left suspended, so a `finally` inside the
    // plugin never runs. Returning into it lets that cleanup happen. Its own
    // failure is swallowed: the host is already throwing the reason that
    // matters, and a plugin's cleanup error must not replace it.
    void gen.return(undefined as unknown as T).catch(() => {});
  }
}

async function drive<T>(
  id: ProviderId,
  step: string,
  gen: AuthStep<T>,
  deps: OAuthDeps,
  origins: readonly string[] | undefined,
): Promise<T> {
  let sent = 0;
  let next: IteratorResult<AuthRequest, T>;
  try {
    next = await gen.next();
  } catch (error) {
    throw rethrow(id, step, error);
  }

  while (!next.done) {
    if (++sent > MAX_REQUESTS_PER_STEP) {
      throw flowFailure(id, step, `asked for more than ${MAX_REQUESTS_PER_STEP} requests`);
    }
    const described = next.value;
    if (!isAuthRequest(described)) {
      throw flowFailure(id, step, "yielded something that is not a request");
    }
    if (origins !== undefined && !withinOrigins(described.url, origins)) {
      throw flowFailure(id, step, "described a request to an origin its manifest does not declare");
    }

    // `provider` and the deadline are the host's, exactly as they are on the
    // inference path: a flow naming another provider would put that name into
    // the error an operator reads, and one supplying its own signal could
    // outlive the timeout.
    // Guarded, because the transport can throw synchronously for reasons the
    // shape checks above cannot fully exclude, and an unguarded rejection here
    // escapes classification carrying whatever text it was built from.
    let res: HttpResponse;
    try {
      res = await deps.http({
        provider: id,
        url: described.url,
        method: described.method,
        headers: described.headers,
        body: described.body ?? "",
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
    } catch (error) {
      throw rethrow(id, step, error);
    }
    const body = await res.text().catch(() => "");

    try {
      next = await gen.next({ status: res.status, headers: res.headers, body });
    } catch (error) {
      throw rethrow(id, step, error);
    }
  }
  const shape = RETURN_SHAPE[step];
  if (shape !== undefined && !shape(next.value)) {
    throw flowFailure(id, step, "returned something the host cannot use");
  }
  return next.value;
}

/**
 * A `GatewayError` the flow raised passes through; anything else is relabelled.
 *
 * The same rule `codecAdapter`'s `guard` follows, and for the same reason: the
 * classification is the flow's to make — `pending` in particular *is* control
 * flow — while an arbitrary throw is a plugin bug that must not reach
 * `classify` as `INTERNAL`.
 */
function rethrow(id: ProviderId, step: string, error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof Error && error.name === "GatewayError") {
    return flowFailure(
      id,
      step,
      "threw a GatewayError from its own bundled copy, whose classification the host " +
        "cannot trust; build the error with the fail() it was handed",
    );
  }
  return flowFailure(id, step, "threw");
}

/**
 * Turns a plugin's declared flow into the `OAuthProvider` the host consumes.
 *
 * The parallel of `codecAdapter`, and it exists for the same reason: every
 * consumer — `createConnectFlows`, `createRefresher`, the usage poller, the CLI
 * — already takes its providers as a parameter, so a plugin's flow becomes
 * indistinguishable from a built-in's at the point of use.
 */
export function oauthAdapter(
  id: ProviderId,
  flow: PluginOAuthFlow,
  origins?: readonly string[],
): OAuthProvider {
  const helpers = (deps: OAuthDeps): AuthHelpers => ({
    fail: (code, message, opts) =>
      new GatewayError(code, message, {
        provider: id,
        ...(opts?.status === undefined ? {} : { status: opts.status }),
        // Never `gatewayAuthored`: the text is the plugin's, and is unknown in
        // exactly the way an upstream body is.
      }),
    keepPolling: (reason) => pendingError(reason),
    pkce: () => createPkce(),
    randomState: () => randomState(),
    now: deps.now,
  });

  const base = {
    id,
    supportsManualPaste: flow.supportsManualPaste,
    start: (opts: { redirectUri: string }, deps: OAuthDeps) =>
      runStep(id, "start", flow.start({ ...opts, ...helpers(deps) }), deps, origins),
    exchange: (input: { code: string; pending: PendingFlow }, deps: OAuthDeps) =>
      runStep(id, "exchange", flow.exchange({ ...input, ...helpers(deps) }), deps, origins),
    refresh: (refreshToken: string, deps: OAuthDeps, providerData: Record<string, unknown>) =>
      runStep(
        id,
        "refresh",
        flow.refresh({ refreshToken, providerData, ...helpers(deps) }),
        deps,
        origins,
      ),
    ...(flow.usage === undefined
      ? {}
      : {
          usage: (
            secrets: UsageSecrets,
            deps: OAuthDeps,
            providerData: Record<string, unknown>,
          ) => {
            const step = flow.usage?.({ secrets, providerData, ...helpers(deps) });
            if (step === undefined) return Promise.resolve(null);
            return runStep(id, "usage", step, deps, origins);
          },
        }),
  };

  if (flow.kind === "pkce") return { ...base, kind: "pkce" };

  const begin = flow.begin;
  if (begin === undefined) {
    // Refused at registration rather than at connect: a device flow with no
    // `begin` has nothing to show an operator, and discovering that when they
    // click connect is discovering it in the worst place.
    throw new Error(`plugin ${id} declares a device oauth flow without a begin step`);
  }
  return {
    ...base,
    kind: "device",
    needsDeviceId: flow.needsDeviceId === true,
    begin: (opts: { deviceId: string }, deps: OAuthDeps) =>
      runStep(id, "begin", begin({ ...opts, ...helpers(deps) }), deps, origins),
  };
}

/**
 * Whether a step returned the shape its caller is about to dereference.
 *
 * **Yields were validated and returns were not**, which left the same hole the
 * inference path spent thirty lines closing: `connect.ts` reads
 * `result.expiresAt` and spreads `...result.secrets`, so a step that returned
 * `undefined` — a bare `return;` — produced a raw `TypeError` thrown outside
 * every guard here. `classify` reads that as `INTERNAL`, and `RETRYABLE.INTERNAL`
 * is false, so on the refresh path a plugin bug ends a request the pool could
 * have served.
 *
 * Checked to exactly what a consumer dereferences and no further, which is the
 * rule `checkDescriptor` follows for the same reason.
 */
function isFlowResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { secrets?: unknown; providerData?: unknown };
  if (typeof candidate.secrets !== "object" || candidate.secrets === null) return false;
  const secrets = candidate.secrets as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken", "apiKey", "idToken"] as const) {
    const held = secrets[field];
    if (held !== null && typeof held !== "string") return false;
  }
  return typeof candidate.providerData === "object" && candidate.providerData !== null;
}

/** `start` and `begin` return this; `connect.ts` reads both fields immediately. */
function isAuthorizeStart(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { authorizeUrl?: unknown; pending?: unknown };
  return (
    typeof candidate.authorizeUrl === "string" &&
    typeof candidate.pending === "object" &&
    candidate.pending !== null
  );
}

/** What each step must have returned, by name. */
const RETURN_SHAPE: Readonly<Record<string, (value: unknown) => boolean>> = {
  start: isAuthorizeStart,
  begin: isAuthorizeStart,
  exchange: isFlowResult,
  refresh: isFlowResult,
  // `usage` may legitimately answer `null` — "the endpoint exists and said
  // nothing usable" — which is why it is not in this table at all rather than
  // having a predicate that accepts everything.
};
