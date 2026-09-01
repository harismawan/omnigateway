/**
 * The host that performs a provider's OAuth flow.
 *
 * The auth half of the `provider` capability. A plugin already describes an
 * inference request and lets the host send it — `ProviderCodec` — and this is
 * the same inversion applied to authorization: **each step is an async
 * generator that yields described requests and receives responses.** The plugin
 * never holds an `HttpClient`, so boundary rule 15 keeps its "never
 * `HttpClient`" without gaining a footnote, and a plugin author who has written
 * a codec already knows the shape.
 *
 * The contract those flows are written against — `AuthRequest`, `AuthResponse`,
 * `AuthHelpers`, `PluginOAuthFlow` — lives in `@omni/providers`, beside the
 * five built-in flows and beside the codec contract it mirrors. It is
 * re-exported below so a consumer of this module needs one import, not two;
 * this file owns the *performing*, which is the part that holds the transport.
 */

import { GatewayError, type ProviderId } from "@omni/ir";
import {
  type AuthHelpers,
  type AuthRequest,
  type AuthResponse,
  type AuthStep,
  type DevicePluginFlow,
  type HttpResponse,
  isHttpMethod,
  isSendableUrl,
  type PkcePluginFlow,
  type PluginOAuthFlow,
  withinOrigins,
} from "@omni/providers";
import type { UsageSecrets } from "@omni/store";
import { createPkce, randomState } from "./pkce.ts";
import {
  type DeviceOAuthProvider,
  type OAuthDeps,
  type OAuthProvider,
  type PendingFlow,
  type PkceOAuthProvider,
  pendingError,
} from "./types.ts";

export type {
  AuthHelpers,
  AuthRequest,
  AuthResponse,
  AuthStep,
  DevicePluginFlow,
  PkcePluginFlow,
  PluginOAuthFlow,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drive(id, step, gen, deps, origins),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(flowFailure(id, step, `did not finish within ${STEP_WALL_CLOCK_MS}ms`));
        }, STEP_WALL_CLOCK_MS);
        // Unref'd so a step that finishes normally does not hold the process
        // open for the rest of the deadline. The CLI exits when its command is
        // done, and a live timer would delay every connect by the slack it did
        // not use. Cleared below as well: `unref` stops it holding the process
        // open but still retains the closure for the full 150s.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A step **suspended at a `yield`** — over the cap, outside its origins, or
    // yielding something unusable — never runs its own `finally`. Returning into
    // it lets that cleanup happen. Its own failure is swallowed: the host is
    // already throwing the reason that matters, and a plugin's cleanup error
    // must not replace it.
    //
    // **It does not reach a generator stuck inside its own `await`**, which is
    // the shape `STEP_WALL_CLOCK_MS` exists for: `gen.return()` queues behind
    // the pending `next()` and never runs. Measured — the plugin's `finally`
    // does not fire and the generator survives. So the wall clock bounds *the
    // host's wait*, not the plugin's execution, and nothing in JavaScript can
    // bound the latter. Under rule 15 that is a guardrail reaching its limit
    // rather than a hole; it is written down because the alternative is a
    // reader believing the cleanup is unconditional.
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
    // **Copied first, then only the copy is read — validation included.**
    //
    // Every field is otherwise read twice: once by `isAuthRequest` and again by
    // the origin check or the transport. A property answering differently each
    // time — a getter is enough — passes validation and sends something else.
    // Measured with `origins` unset: `isSendableUrl` approved an
    // `https://api.acme.test` URL and the transport received `file:///etc/passwd`.
    //
    // A first version copied *below* the check, closing the origin-to-transport
    // gap and leaving check-to-transport open, under a comment claiming both.
    // Rule 15 is a guardrail rather than a sandbox, so this is not containment;
    // what it protects is the guardrail's stated value, that the manifest is an
    // honest audit surface, and a silent bypass is the direction that goes wrong.
    //
    // **Shallow**: the header array is copied, the pairs inside it are shared.
    // Nothing reads a header's contents twice today — Node refuses the CRLF
    // itself — so it costs nothing, and writing "copied once" without this note
    // would state the wide form of a rule that only holds in its narrow one.
    const yielded = next.value as Partial<AuthRequest>;
    const described: AuthRequest = {
      url: yielded.url as string,
      method: yielded.method as string,
      headers: Array.isArray(yielded.headers) ? [...yielded.headers] : [],
      ...(yielded.body === undefined ? {} : { body: yielded.body }),
      ...(yielded.timeoutMs === undefined ? {} : { timeoutMs: yielded.timeoutMs }),
    };
    if (!isAuthRequest(described) || !Array.isArray(yielded.headers)) {
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
