import { GatewayError, type ProviderId, type StreamEvent } from "@omni/ir";
import type { CodecFail, CodecHttpRequest, ProviderCodec } from "./codec.ts";
import { httpError } from "./http.ts";
import { isHttpMethod, isSendableUrl, withinOrigins } from "./origins.ts";
import type { AdapterRequest, AdapterResult, Capabilities, ProviderAdapter } from "./types.ts";

/**
 * The error a codec's own failure becomes.
 *
 * `UPSTREAM` rather than `INTERNAL`, and that choice is the whole point.
 * `RETRYABLE.INTERNAL` is false, so a codec that threw would end the request
 * after one attempt with a 500 — while a pool with three other candidates sat
 * unused. A plugin's bug is not a reason to refuse a request the installation
 * can still serve, and rule 15 is explicit that a plugin failure is skipped and
 * reported rather than fatal.
 *
 * The provider is named because that is what makes it actionable: the operator
 * needs to know which plugin, and `provider` is the field the redaction gate
 * reads. The codec's own message is deliberately *not* carried — it is authored
 * outside this repository and `LogFields` is a closed allowlist, the same reason
 * a throwing channel handler is reported without its error body.
 */
function codecFailure(id: ProviderId, hook: string, what: string): GatewayError {
  // `UPSTREAM` is in `RETRYABLE`, which is what makes the failover happen; no
  // option needs to say so, and one that did would be a second source of truth.
  // Built from an id this host validated and two literals this file owns, so it
  // carries nothing a client sent and nothing a plugin wrote. Naming the
  // provider is what makes it actionable, and before this flag existed that same
  // naming is what suppressed it.
  return new GatewayError("UPSTREAM", `${id} codec ${hook} ${what}`, {
    provider: id,
    gatewayAuthored: true,
  });
}

/**
 * What a codec may write into `request_logs.degradations`.
 *
 * Sixteen entries of sixty-four characters, which is above what any shipped
 * adapter produces (`anthropic:system-turn-cache-control-dropped`, 43, is the
 * longest) and far below what would matter in a row. Non-strings are dropped rather than
 * coerced: `String(someObject)` produces `[object Object]`, which is a value
 * that looks like data and explains nothing.
 */
function boundedDegradations(entries: readonly string[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, 16)
    .map((entry) => entry.slice(0, 64));
}

/**
 * A codec-authored `GatewayError`, with the two fields the host owns restated.
 *
 * Bounding `degradations` on the way *in* to `classifyError` was the first
 * version, and it guarded the wrong direction: the input is the host's own
 * array, already capped on the success path, while what actually reaches
 * `request_logs.degradations` is `error.degradations` — read by
 * `dispatch/index.ts`'s `noteDegradations` off whatever the codec returned. A
 * hostile codec attached forty entries of four hundred characters and every one
 * landed in the column. The comment describing that threat sat directly above
 * the check that did not address it.
 *
 * `provider` is restamped for the same reason it is stamped on the outbound
 * request: it is the host's id for this codec, it reaches `LogFields.provider`
 * and it gates `reasonField` in `apps/gateway/src/logging.ts`, so a codec naming
 * another provider chooses whether the operator's reason line prints at all.
 *
 * **`gatewayAuthored` is dropped unconditionally, and that now costs something
 * it did not use to.** For a plugin codec it is exactly right: its text is
 * authored outside this repository and is unknown in the way an upstream body
 * is. But every built-in routes through here too since the conversion, so no
 * in-repo codec can surface an operator-visible reason line either — `custom`'s
 * "credential has invalid endpoint metadata" waits for debug like any upstream
 * body. Nothing regressed: none of the six set the flag before the conversion.
 * What changed is that setting it is now *inert*, so a contributor who adds it
 * to a codec's error will watch it vanish with nothing saying why. Fixing that
 * means the host distinguishing a registered built-in from a plugin, which it
 * deliberately does not do anywhere else; this note is the cheaper half of the
 * trade and the place to start if the trade stops being worth it.
 *
 * `code` and `message` are deliberately *not* touched. Classifying its own
 * upstream's failure is the entire purpose of the hook — including `AUTH`, which
 * `dispatch` gates its credential refresh on, and which is bounded elsewhere: a
 * refresh acts on that one credential, which a provider plugin already holds
 * decrypted under rule 15's stated exception.
 */
function rebound(id: ProviderId, error: GatewayError): GatewayError {
  return new GatewayError(error.code, error.message, {
    provider: id,
    // No `gatewayAuthored`: `error.message` came from the codec's own
    // `classifyError`, which is handed the upstream body and is authored outside
    // this repository. Both halves make it exactly what the gate is for, and the
    // default is what keeps it suppressed — the same reasoning that keeps
    // `codecFailure` from carrying a codec's message at all.
    ...(error.upstreamStatus === undefined ? {} : { status: error.upstreamStatus }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    degradations: boundedDegradations(error.degradations),
    cause: error,
  });
}

/**
 * Runs one codec hook, turning anything it throws into a failover-able error.
 *
 * A `GatewayError` passes through untouched, and that exception is the point.
 * `kiloCodec.buildRequest` throws `AUTH` when the credential carries no token —
 * a deliberate, correctly classified failure — and flattening it to `UPSTREAM`
 * silently disabled a self-healing path: `dispatch` gates its OAuth
 * credential-refresh retry on `code === "AUTH"`, so an expired token would fail
 * over instead of being refreshed, and on a single-candidate pool the request
 * would fail outright where it had succeeded. Only errors the contract has no
 * classification for are rewritten.
 */
/**
 * An error that says it is a `GatewayError` and is not this module's.
 *
 * What a bundler produces. A plugin is a self-contained tree with no
 * `node_modules`, so a codec importing `GatewayError` ships its own copy, and
 * `instanceof` against it is false however identical the shape.
 *
 * Detected only to **report** it. The classification is still refused —
 * accepting a duck-typed object's `code` is exactly what `instanceof` is there
 * to prevent, and a plain object could then claim `AUTH` and drive a credential
 * refresh. What changes is that the author is told which mistake they made,
 * instead of watching a deliberate `AUTH` become an `UPSTREAM` for reasons
 * nothing in the logs explains.
 */
function isForeignGatewayError(error: unknown): boolean {
  return error instanceof Error && error.name === "GatewayError";
}

function guard<T>(id: ProviderId, hook: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof GatewayError) && isForeignGatewayError(error)) {
      throw codecFailure(
        id,
        hook,
        "threw a GatewayError from its own bundled copy, whose classification the host " +
          "cannot trust; build the error with input.fail() instead",
      );
    }
    // Passed through, but not verbatim: the classification is the codec's and
    // the `provider` and `degradations` fields are the host's. `kiloCodec`
    // throwing `AUTH` for a credential with no token is the case this
    // passthrough exists for, and it attaches neither — so `rebound` costs it
    // nothing and closes the same column a returned error was closing.
    if (error instanceof GatewayError) throw rebound(id, error);
    throw codecFailure(id, hook, "threw");
  }
}

/**
 * Wraps the *iteration* of a codec's stream, not the call that creates it.
 *
 * `guard` cannot do this job. An `async function*` returns its generator without
 * running a line of the body, so guarding the call caught nothing for the shape
 * `ProviderCodec.decode` actually declares — a plugin's `TypeError` escaped as
 * itself, `classify` read it as `INTERNAL`, and `RETRYABLE.INTERNAL` is false,
 * so the request ended after one attempt with a 500 while the rest of the pool
 * sat unused. That is verbatim the failure the guard was added to remove, and
 * the test that was supposed to prove otherwise used a plain throwing function,
 * which passes whether or not any of this exists.
 *
 * Errors after the first event are dispatch's to handle — that is its commit
 * point — but the classification is still worth fixing here, because a plugin
 * bug mid-stream is no more `INTERNAL` than one before it.
 */
async function* guardStream(
  id: ProviderId,
  stream: AsyncGenerator<StreamEvent, void, undefined>,
): AsyncGenerator<StreamEvent, void, undefined> {
  try {
    yield* stream;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw codecFailure(id, "decode", "threw");
  }
}

/**
 * Runs the request a codec describes, so a codec can be used wherever an
 * adapter is expected.
 *
 * This is the whole host side of the codec contract, and its length is the
 * argument for the contract: everything an adapter does beyond building a
 * request and reading a stream is here, once, rather than repeated in each
 * provider. Six copies of these twenty lines are what `send()` currently is.
 *
 * Dispatch keeps every decision it already owned — which credential, which
 * deadline, whether to retry, whether to fail over. Nothing in this file
 * decides anything; it performs.
 */
export function codecAdapter(
  id: ProviderId,
  capabilities: Capabilities,
  codec: ProviderCodec,
  /**
   * The origins this provider's manifest declared, for a plugin-supplied codec.
   *
   * Absent for the six built-ins, and absent means unrestricted — they are not
   * plugins, have no manifest, and their URLs are in this repository where a
   * reader can see them. A plugin's are not, which is the whole asymmetry this
   * closes.
   */
  origins?: readonly string[],
): ProviderAdapter {
  return {
    id,
    capabilities,
    async send(req: AdapterRequest): Promise<AdapterResult> {
      // One factory per request rather than per adapter: it closes over `id`, so
      // a codec cannot name another provider in the error it raises any more
      // than it can in the request it describes.
      const fail: CodecFail = (code, message, opts) =>
        new GatewayError(code, message, {
          provider: id,
          ...(opts?.status === undefined ? {} : { status: opts.status }),
          ...(opts?.retryAfterMs === undefined ? {} : { retryAfterMs: opts.retryAfterMs }),
          degradations: boundedDegradations(opts?.degradations),
          // Never `gatewayAuthored`. See `CodecInput.fail`.
        });

      const built = guard(id, "buildRequest", () =>
        codec.buildRequest({
          request: req.request,
          model: req.model,
          credentials: req.credentials,
          fail,
          ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
          ...(req.autoCache === undefined ? {} : { autoCacheEnabled: req.autoCache }),
        }),
      );
      // **Copied first, then only the copy is read — checks included.**
      //
      // Every field is otherwise read twice: once by the shape check below and
      // again by the transport. A property that answers differently each time —
      // a getter is enough — passes the check and sends something else.
      // Measured: a getter on `method` returning `"GET"` then `"GET junk"` put a
      // raw `ERR_INVALID_HTTP_TOKEN` out of `send()`, which `classify` reads as
      // `INTERNAL`, and `RETRYABLE.INTERNAL` is false — so the request died
      // where the honest value fails over cleanly.
      //
      // A first version of this copy sat *below* the shape check, which closed
      // the origin-check-to-transport gap and left check-to-transport open, on
      // a comment claiming it had closed both. That is the same shape as the
      // note further down about checking one member of a class and describing
      // it as the class.
      const described = (built?.request ?? {}) as Partial<{
        url: string;
        method: string;
        headers: readonly (readonly [string, string])[];
        body: string;
      }>;
      const request = {
        url: described.url,
        method: described.method,
        headers: Array.isArray(described.headers) ? [...described.headers] : described.headers,
        body: described.body,
      };
      if (
        typeof request.body !== "string" ||
        !isSendableUrl(request.url) ||
        !isHttpMethod(request.method) ||
        !Array.isArray(request.headers) ||
        // The elements, not just the array. `Array.isArray` alone let a
        // malformed pair through to `nodeHttpClient`, which threw a raw
        // `TypeError` — `ERR_INVALID_CHAR`, `ERR_INVALID_HTTP_TOKEN`, or
        // `name.toLowerCase is not a function` — from outside every guard in
        // this file. Node refuses the CRLF itself, so this was never request
        // splitting.
        //
        // A first version checked this pair and left `url` and `method` as bare
        // `typeof === "string"` one line above — and its comment claimed the
        // header pair was "the one class" of codec mistake reaching `classify`
        // as `INTERNAL`. Measurably three: `"not a url"`, `""` and a `file:`
        // scheme all throw `TypeError: Invalid URL`, and `"GET junk"` throws
        // `Method must be a valid HTTP token`, each from `await req.http(…)`,
        // which sits outside every guard here. The last one also echoed a
        // codec-authored string into a client-visible message. Checking one
        // member of a class and describing it as the class is how the other two
        // survived a review that was looking straight at them.
        !request.headers.every(
          (pair) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string",
        )
      ) {
        throw codecFailure(id, "buildRequest", "did not return a usable request");
      }
      // Narrowed off the copy the checks above just validated, so the transport
      // and the checks cannot see different values.
      const sendable: CodecHttpRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      };

      // Checked on the copy, before the transport. A plugin's manifest is the
      // only place an operator can read where their prompts go, so a codec that
      // names somewhere else is refused rather than reported afterwards.
      if (origins !== undefined && !withinOrigins(request.url, origins)) {
        throw codecFailure(
          id,
          "buildRequest",
          "described a request to an origin its manifest does not declare",
        );
      }

      // `provider` and `signal` are stamped here rather than taken from the
      // codec. The first is the host's own id for it — a codec naming a
      // different provider would put that name into `LogFields.provider` and
      // into the error a client sees. The second is dispatch's deadline; a
      // codec that supplied its own could outlive it.
      const res = await req.http({
        provider: id,
        ...sendable,
        signal: req.signal,
      });

      if (res.status < 200 || res.status >= 300) {
        // Read once. `httpError` also consumes the body, so a codec that wants
        // to inspect it has to be given the text rather than the response —
        // which is also why `classifyError` takes a string and cannot re-read
        // the stream or reach the socket.
        const text = await res.text().catch(() => "");
        // Built before the hook rather than after it, because the hook is handed
        // it. Anthropic's refusal is a *relabelling* of this error — same
        // message, same status, different code — and a codec that had to
        // reconstruct the message from `text` would be re-implementing
        // `httpError`'s three extraction rules to arrive back here.
        //
        // Built field by field, never `{ ...res }`. On a captured request the
        // response is `bodyCapture`'s wrapper, whose `body` is a *getter* that
        // tees the upstream stream and starts a capture drain — and object
        // spread reads getters. Spreading here invoked it on a response nothing
        // was going to read: the error body was recorded twice, `asBody()` could
        // no longer parse it as JSON, and an abandoned tee branch buffered the
        // whole body with `settle()` waiting on a drain that existed for no
        // reason. `httpError` never reads `body`, so `null` is the honest value.
        const fallback = await httpError(
          { status: res.status, headers: res.headers, body: null, text: async () => text },
          id,
        );
        // **Frozen before the codec sees it, and this is load-bearing rather
        // than defensive.** `readonly` on `GatewayError`'s fields is a
        // compile-time claim and nothing else; a codec that mutates this object
        // and then returns `undefined` has the host throw *its* object verbatim,
        // below, without passing through `rebound`. Measured on the unfrozen
        // version: `message` replaced with codec-authored text, `gatewayAuthored`
        // flipped to `true` — so `reasonField` prints that text at default
        // level, which is the exact leak that flag exists to prevent — and a
        // 407-character entry into `request_logs.degradations`, the column
        // `boundedDegradations` and `rebound` were written to cap against this
        // same untrusted source. Two paths were bounded and the third was not.
        //
        // Freezing rather than cloning, because a mutation should be *loud*: an
        // assignment to a frozen property throws in strict mode, `guard` turns
        // that into `codecFailure`, and the request fails over. A clone would
        // make a codec that attaches its own notes here silently lose them,
        // which is the buggy case rather than the hostile one and the more
        // likely of the two.
        //
        // `Object.freeze` is shallow, so this holds only while every field a
        // codec can reach is a primitive or itself frozen. Today that is true:
        // `degradations` is the one object field and it is frozen beside its
        // owner. **A future field of object type needs freezing here too**, and
        // it is a decision rather than a detail — rule 15 is a guardrail, not a
        // sandbox, but the redaction bounds are enforced against plugin content
        // regardless, which is the whole reason `rebound` exists.
        Object.freeze(fallback.degradations);
        Object.freeze(fallback);
        const classified = guard(id, "classifyError", () =>
          codec.classifyError?.({
            status: res.status,
            body: text,
            headers: res.headers,
            fallback,
            fail,
            // What the request gave up, so a refusal caused by exactly that can
            // say so. `dispatch` writes `error.degradations` into `request_logs`.
            // Bounded here as on the success path. Unbounded, a codec could
            // attach forty long strings to the error it returns and put all of
            // them into `request_logs.degradations` — the same column the
            // success path caps, from the same untrusted source.
            degradations: boundedDegradations(built.degradations),
            decodeState: built.decodeState,
          }),
        );
        // The *return*, not just the call. `guard` checks `instanceof
        // GatewayError` on the throw path and had no equivalent here, so a
        // codec returning `null` — the natural sibling of the documented
        // `undefined` — produced `throw null`, and a string or plain object
        // threw itself. Each reached `classify` as `INTERNAL`, which is not
        // retryable, ending a request the rest of the pool could have served.
        if (classified !== undefined) {
          if (!(classified instanceof GatewayError)) {
            throw codecFailure(id, "classifyError", "returned something that is not an error");
          }
          throw rebound(id, classified);
        }
        throw fallback;
      }

      const body = res.body;
      if (body === null) {
        throw new GatewayError("UPSTREAM", "empty response body", {
          provider: id,
          gatewayAuthored: true,
        });
      }

      const cloaked = built.cloakedTools;
      return {
        events: guardStream(
          id,
          // The call itself is still guarded: `decode` may be an ordinary
          // function that throws before returning anything iterable.
          guard(id, "decode", () =>
            codec.decode({
              body,
              decodeState: built.decodeState,
              headers: res.headers,
              fail,
            }),
          ),
        ),
        // Bounded, because a codec is third-party code and these strings land
        // in `request_logs.degradations`. The field beside this one is a
        // *count* precisely because tool names are client free text and
        // `LogFields` is the redaction boundary — handing the same untrusted
        // source an unbounded string array into a stored column would be the
        // same mistake with a different shape. Caps rather than refusal: a
        // chatty codec loses detail, it does not lose its request.
        degradations: boundedDegradations(built.degradations),
        // A count, which is what the contract says this is: "the contract can
        // carry the number and has no way to carry the strings". It had a way —
        // the value was forwarded unvalidated into `logger.debug("tool names
        // cloaked", …)`, i.e. into `LogFields`, the redaction boundary. A codec
        // returning `"SessionSearch,ReadFile"` put client tool names in a log
        // line. Anything that is not a non-negative integer is dropped rather
        // than coerced: `Number("names")` is `NaN`, which renders as `NaN`.
        //
        // Two clauses, not three. `Number.isInteger` is false for every
        // non-number and for `NaN` and the infinities, so the `typeof` test that
        // preceded it was fully implied — it read as an independent check and
        // deleting it changed nothing, which is how a reader comes to believe a
        // guard is broader than it is. `>= 0` is the one that carries its own
        // weight: zero is a count a codec may legitimately state.
        // Read **once**, into a local, and the local is what is tested and
        // emitted. It was read three times — twice by the guard, once by the
        // field — so a getter answering an integer twice and then
        // `"SessionSearch,ReadFile"` put client tool names into
        // `LogFields.cloakedTools` through `dispatch`'s debug line. Measured.
        // That is the leak the count-not-names contract exists to prevent, and
        // the guard three lines above says it was already closed.
        ...(Number.isInteger(cloaked) && (cloaked ?? 0) >= 0 ? { cloakedTools: cloaked } : {}),
      };
    },
  };
}
