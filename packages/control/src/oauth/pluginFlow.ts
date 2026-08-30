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
  type DeviceOAuthProvider,
  type FlowResult,
  type OAuthDeps,
  type OAuthProvider,
  type PendingFlow,
  type PkceOAuthProvider,
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
   * Clamped to `MAX_STEP_TIMEOUT_MS`, and absent means that maximum. A plugin
   * can therefore shorten its own deadline but never extend it past what the
   * host is willing to hold a connect flow open for.
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
 * - `pkce` and `randomState` cover the randomness **OAuth itself** needs, and
 *   keep `start` testable. The implementation is 21 lines already shared by
 *   every built-in flow.
 *
 *   Not "a plugin needs no crypto", which is what this said until porting kimi
 *   disproved it: a device flow that binds a session to a machine fingerprint
 *   mints that itself — `mintKimiDevice` — and nothing here replaces it. A
 *   plugin doing the same would bundle its own. The narrow claim is the true
 *   one, and the wide one is the kind a contributor preserves while breaking
 *   the real thing.
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

/**
 * The flow a plugin declares beside its descriptor and codec.
 *
 * Mirrors `OAuthProvider`, which is what the host already consumes, so that
 * `oauthAdapter` below is the only thing that has to know the difference —
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
 * How many requests one step may ask for.
 *
 * `kilo.exchange` needs two, and no shipped flow needs more. The cap exists
 * because a generator can loop: without it a flow that never returns holds a
 * connect open indefinitely, and a device poll is already called in a loop by
 * the host, so the plugin has no reason to write one.
 */
const MAX_REQUESTS_PER_STEP = 4;

/**
 * The longest any one call may take, and what a step gets if it asks for nothing.
 *
 * Token calls are short and must not hang a connect flow forever. A step may
 * ask for **less** through `AuthRequest.timeoutMs` — a usage probe does — but
 * never more, because the ceiling is the host's to set.
 */
const MAX_STEP_TIMEOUT_MS = 30_000;

/**
 * The wall clock on a whole step, independent of how many requests it made.
 *
 * The request cap bounds **requests**, not time, and those are different
 * properties: a generator that never yields and never returns — one stray
 * `await` on a promise nobody settles — reaches the cap never, and the host
 * waits forever. Measured before this existed.
 *
 * Four permitted requests at the per-request ceiling is 120s, so this sits
 * above that: it catches the shape the cap cannot see rather than tightening
 * the one it can.
 */
const STEP_WALL_CLOCK_MS = 150_000;

function flowFailure(id: ProviderId, step: string, what: string): GatewayError {
  // **`UPSTREAM`, never `AUTH`**, and the difference is a credential's life.
  //
  // `createRefresher` reads `code === "AUTH"` as *the provider repudiated this
  // refresh token* and disables the account with `disabledReason:
  // "tokenRejected"`. Every failure built here means something else — the flow
  // is broken, the transport failed, a plugin misbehaved — and none of them is
  // the upstream rejecting the credential.
  //
  // It said `AUTH` for one commit, and the cost was measured rather than
  // imagined: a rejection from `deps.http` reaches `rethrow`, which builds this
  // error, and no built-in flow catches its own token call. So a DNS blip, a
  // connection reset or this host's own 30s timeout during a refresh disabled
  // the account. The scheduler refreshes ahead of expiry and the quota poller
  // refreshes before probing, across every enabled OAuth credential — so a few
  // minutes of upstream trouble could disable every account a provider has,
  // each needing a manual reconnect. `refresh.ts` states that "anything else
  // (network, timeout) is transient"; that sentence was false for exactly as
  // long as this said `AUTH`.
  //
  // `codecFailure` chose `UPSTREAM` for this same reason on the inference path.
  // A flow that means `AUTH` says so itself through the `fail` it was handed.
  //
  // Built from an id the host validated and two literals this file owns, so it
  // carries nothing the plugin wrote — which is what lets it say
  // `gatewayAuthored`.
  return new GatewayError("UPSTREAM", `${id} oauth ${step} ${what}`, {
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
    (candidate.body === undefined || typeof candidate.body === "string") &&
    // A non-positive or non-finite deadline would make `AbortSignal.timeout`
    // fire immediately or throw, either of which reads as an upstream failure.
    (candidate.timeoutMs === undefined ||
      (typeof candidate.timeoutMs === "number" &&
        Number.isFinite(candidate.timeoutMs) &&
        candidate.timeoutMs > 0))
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
    return await Promise.race([
      drive(id, step, gen, deps, origins),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(flowFailure(id, step, `did not finish within ${STEP_WALL_CLOCK_MS}ms`));
        }, STEP_WALL_CLOCK_MS);
        // Unref'd so a step that finishes normally does not hold the process
        // open for the rest of the deadline. The CLI exits when its command is
        // done, and a live timer would delay every connect by the slack it did
        // not use.
        timer.unref?.();
      }),
    ]);
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
    if (!isAuthRequest(next.value)) {
      throw flowFailure(id, step, "yielded something that is not a request");
    }
    // **Copied once, then only the copy is read.** The checks below and the
    // transport otherwise read `url` three times, and a property that answers
    // differently each time — a getter is enough — passes the origin check and
    // puts a different host on the wire. Rule 15 is a guardrail rather than a
    // sandbox, so this is not containment; what it protects is the guardrail's
    // stated value, that the manifest is an honest audit surface, and a silent
    // bypass is the direction that goes wrong.
    const described: AuthRequest = {
      url: next.value.url,
      method: next.value.method,
      headers: [...next.value.headers],
      ...(next.value.body === undefined ? {} : { body: next.value.body }),
      ...(next.value.timeoutMs === undefined ? {} : { timeoutMs: next.value.timeoutMs }),
    };
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
        signal: AbortSignal.timeout(
          Math.min(described.timeoutMs ?? MAX_STEP_TIMEOUT_MS, MAX_STEP_TIMEOUT_MS),
        ),
      });
    } catch (error) {
      // Raised *into* the step rather than past it, because a flow can have a
      // request whose failure is not the flow's failure. `kilo.exchange` reads
      // the billing organization with a token it has already earned, and an
      // operator who watched their browser say "approved" must not be told the
      // connect failed because a secondary read was reset. Thrown past the
      // generator that tolerance is unwritable at all: a suspended generator's
      // own `try` never sees a rejection raised outside it, so the step is
      // simply abandoned. A step that does not catch is unchanged — `gen.throw`
      // rejects with the same error and `rethrow` relabels it exactly as this
      // line did when it threw.
      try {
        next = await gen.throw(rethrow(id, step, error));
      } catch (thrown) {
        throw rethrow(id, step, thrown);
      }
      continue;
    }
    // **Raised, not swallowed into `""`.** A body this host could not read is a
    // transport failure, not a provider verdict — but every flow reads an empty
    // 2xx as "token endpoint returned no access_token" and raises `AUTH`, which
    // `createRefresher` acts on by disabling the account. So a socket reset
    // partway through a token response disabled a healthy credential, where
    // the deleted `postJson` had surfaced it as the transient error it is,
    // through an unguarded `res.text()`. Raised into the step, like the request failure above, so a
    // flow that tolerates one can still say so.
    let body: string;
    try {
      body = await res.text();
    } catch (error) {
      try {
        next = await gen.throw(rethrow(id, step, error));
      } catch (thrown) {
        throw rethrow(id, step, thrown);
      }
      continue;
    }

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
export type AdapterOptions = {
  /** The origins this provider's manifest declared; absent means unrestricted. */
  origins?: readonly string[];
  /**
   * Whether this flow's own error text was written in this repository.
   *
   * Set for the five built-ins and never for a plugin. It is what lets their
   * messages reach an operator's log: `reasonField` withholds a message when
   * the error names a provider and is not gateway-authored, so without this a
   * refresh failure prints a bare code and nothing else.
   */
  trusted?: boolean;
};

export function oauthAdapter(
  id: ProviderId,
  flow: DevicePluginFlow,
  opts?: AdapterOptions,
): DeviceOAuthProvider;
export function oauthAdapter(
  id: ProviderId,
  flow: PkcePluginFlow,
  opts?: AdapterOptions,
): PkceOAuthProvider;
export function oauthAdapter(
  id: ProviderId,
  flow: PluginOAuthFlow,
  opts?: AdapterOptions,
): OAuthProvider;
export function oauthAdapter(
  id: ProviderId,
  flow: PluginOAuthFlow,
  opts: AdapterOptions = {},
): OAuthProvider {
  const { origins, trusted = false } = opts;
  const helpers = (deps: OAuthDeps): AuthHelpers => ({
    fail: (code, message, failOpts) =>
      new GatewayError(code, message, {
        provider: id,
        ...(failOpts?.status === undefined ? {} : { status: failOpts.status }),
        // `gatewayAuthored` only for a flow this repository wrote. For a plugin
        // it stays false: the text is the plugin's and is unknown in exactly
        // the way an upstream body is.
        //
        // It was unconditionally false for one commit, and that silenced the
        // operator's log. `reasonField` prints a message when
        // `provider === undefined || gatewayAuthored`, and before the ports a
        // built-in flow's errors carried no provider — so the reason printed.
        // Routing them through this `fail` stamped `provider` and left the flag
        // off, turning both arms false: `token endpoint rejected the request:
        // invalid_grant`, `discovery document … is not an x.ai https url` and
        // `kilo tokens cannot be refreshed` all became a bare `code=UPSTREAM`.
        // Those three are the examples `dispatch/index.ts` names as the reason
        // that line exists. This is the "naming the provider silenced the
        // sentence naming it" defect, which this repository had already paid
        // for once.
        //
        // Safe for the five, because their messages are built from literals and
        // from `tokenErrorMessage`, which reads an error identifier out of a
        // token response *without* the body — which is why they printed before.
        ...(trusted ? { gatewayAuthored: true } : {}),
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
