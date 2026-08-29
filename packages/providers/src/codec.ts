import type { ChatRequest, ErrorCode, GatewayError, StreamEvent } from "@omni/ir";
import type { AdapterCredentials, HeaderPair } from "./types.ts";

/**
 * What a provider supplies, with every side effect left to the host.
 *
 * `ProviderAdapter` hands a provider the `HttpClient` and lets it run its own
 * request. That is fine for the six that ship in this repository and impossible
 * for one that arrives from `<root>/plugins/`: boundary rule 15 says a plugin
 * never receives the client, and a provider whose whole job is talking upstream
 * cannot be given nothing.
 *
 * So the split moves. The plugin describes a request and reads a stream; the
 * host performs the request, checks the status, applies the deadline, and owns
 * every retry and failover decision. There is no seam where a plugin could hold
 * a client, which is why this file contains no rule saying it must not.
 *
 * **This is not a reduced adapter.** Measured before the shape was chosen: all
 * six shipped adapters make exactly one `http()` call, none retries, none makes
 * a second request. `send()` today already is "build a body, build headers, pick
 * a URL, call `http` once, check the status, decode the stream" — the two
 * functions below with the middle four steps inlined. The intent is that this
 * becomes the shape of every adapter rather than a second one beside
 * `ProviderAdapter`; a rule that holds for plugins and not built-ins is the
 * drift this effort has spent three review rounds paying for.
 *
 * Nothing here is `async` and nothing returns a promise the host awaits before
 * the request. A codec that wants to await something has nowhere to put it,
 * which is the point: the absence of I/O is a property of the shape rather than
 * a rule someone has to enforce.
 *
 * Lives in `@omni/providers` rather than `@omnigateway/plugin-api` because that
 * package is published with no `@omni/*` imports and these types are written in
 * terms of `@omni/ir`, which is not published until sub-project 7. The
 * consequence is that an in-repo provider can be typed against this today and a
 * third-party one cannot yet. Design:
 * `docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`.
 */
export type ProviderCodec = {
  /**
   * The canonical request, plus the credential, to one HTTP request.
   *
   * Pure. Given the same input twice it must describe the same request, because
   * the host may build it once and send it on more than one attempt — a retry
   * against a second credential rebuilds with that credential, but nothing else
   * about the request may drift between attempts.
   *
   * **Never mutate `input.request`.** It is the same `ChatRequest` object
   * dispatch reuses for every failover candidate, so a change made here follows
   * the request into the *next provider* — the exact trap the Anthropic
   * auto-cache rule is written against ("IR shared across attempt, so marker
   * there follow failover into other provider"). It is not frozen: deep-freezing
   * a request carrying a whole conversation on the hot path costs more than the
   * bug does, and a codec is a guardrail case rather than a sandbox one. Copy
   * what you need.
   */
  buildRequest(input: CodecInput): CodecRequest;

  /**
   * The response body to canonical events.
   *
   * Receives whatever `buildRequest` put in `decodeState`, verbatim. The host
   * never inspects that value.
   */
  decode(input: CodecDecodeInput): AsyncGenerator<StreamEvent, void, undefined>;

  /**
   * A better error than the host's default, for a response the host already
   * knows failed.
   *
   * Optional, and it exists because Anthropic needs it rather than for
   * symmetry: that adapter reads its own 400 body to recognise a fingerprint
   * refusal, which is a real upstream behaviour no status code expresses.
   * Returning `undefined` keeps the host's default classification, so a codec
   * that only wants to special-case one status says so by returning nothing for
   * every other.
   *
   * Receives `degradations` — what `buildRequest` already reported for this
   * request — because the error is where they matter most. Anthropic's
   * fingerprint refusal is thrown *carrying* them, and `dispatch` writes
   * `error.degradations` into `request_logs`: a failure whose whole diagnosis is
   * "the request was reduced in these ways and then refused" loses its diagnosis
   * if the hook cannot see them. A first version of this contract omitted them
   * and the conversion measurably dropped
   * `["anthropic:oauth-system-prefix", "anthropic:context-1m-dropped"]` on the
   * floor.
   */
  classifyError?(input: CodecErrorInput): GatewayError | undefined;
};

/** What a codec is given to build a request. */
export type CodecInput = {
  request: ChatRequest;
  /** Concrete upstream model id, already resolved from the virtual model. */
  model: string;
  credentials: AdapterCredentials;
  /**
   * The gateway's own request id, when there is one.
   *
   * For an upstream that expects a correlation id: reusing this means stdout,
   * `request_logs` and the provider all join on one value rather than three.
   */
  requestId?: string | undefined;
  /**
   * Whether the codec may add a cache breakpoint the client did not send.
   *
   * An operator policy rather than a property of the request, so it arrives
   * beside it. Writing it onto the `ChatRequest` would put a gateway decision
   * into the object RTK, routing and the token estimate all read as the
   * caller's own.
   */
  autoCacheEnabled?: boolean | undefined;
  /**
   * Builds a classified error, using the **host's** `GatewayError`.
   *
   * A codec must reach for this rather than `new GatewayError(…)`, and the
   * reason is not style. A plugin is installed as a self-contained tree —
   * `packages/control/src/plugins.ts` resolves no dependencies and creates no
   * `node_modules`, by construction — so a plugin's entry carries its own
   * bundled copy of every class it imports. `codecAdapter` decides whether a
   * codec meant its classification by asking `instanceof GatewayError`, and
   * against a bundled copy that is false: an `AUTH` raised for a credential with
   * no token becomes `UPSTREAM`, and dispatch gates its credential-refresh retry
   * on `code === "AUTH"`, so the refresh silently stops happening.
   *
   * `degradations` is bounded here, as on the other two paths a codec can reach
   * `request_logs.degradations` through.
   *
   * `gatewayAuthored` is deliberately **not** settable. A codec's text is
   * authored outside this repository and is unknown in exactly the way an
   * upstream body is — the same reason `rebound` drops the flag.
   */
  fail: CodecFail;
};

/** The host's error constructor, handed to a codec so identity never crosses a bundle. */
export type CodecFail = (
  code: ErrorCode,
  message: string,
  opts?: {
    status?: number;
    retryAfterMs?: number;
    degradations?: readonly string[];
  },
) => GatewayError;

/**
 * A request the host will perform, and anything `decode` needs to read it back.
 *
 * `decodeState` is what makes Anthropic's OAuth tool cloak expressible. Client
 * tool names are renamed on the way out and restored on the way back, and the
 * restore needs the alias map the build step created. A contract where build and
 * decode could not communicate would make that impossible — and it is
 * load-bearing, because RTK normalises by case and separator, so an egress-side
 * restore silently degrades every shell classification.
 *
 * Typed `unknown` to the host on purpose. It never leaves the codec, and the
 * host must not come to depend on its contents; it is also not a channel for
 * smuggling a client or a store handle into `decode`, and a reviewer should
 * treat anything callable in there as a finding.
 */
export type CodecRequest = {
  request: CodecHttpRequest;
  decodeState?: unknown;
  /**
   * What the request could not express, in the vocabulary `request_logs`
   * already stores. The host records these; it does not interpret them.
   */
  degradations?: readonly string[];
  /**
   * How many client tool names the build step renamed on the outbound leg.
   *
   * A count and never the names. A tool name is client free text and the host
   * puts this straight into `LogFields`, which is the redaction boundary — so
   * the contract can carry the number and has no way to carry the strings.
   * Absent for every codec but Anthropic's, and within it for every request on
   * an API key.
   */
  cloakedTools?: number;
};

/**
 * What a codec may say about the request, which is everything except who is
 * sending it and when to give up.
 *
 * Deliberately narrower than `HttpRequest`. That type also carries `provider`
 * and `signal`: the first is the host's own id for the codec, which it must not
 * take the codec's word for, and the second is the request deadline, which the
 * host owns outright — a codec that could supply its own `AbortSignal` could
 * outlive the deadline dispatch set. The host fills both in.
 */
export type CodecHttpRequest = {
  url: string;
  method: string;
  headers: readonly HeaderPair[];
  body: string;
};

export type CodecDecodeInput = {
  /** The response body. Non-null: the host refuses an empty one first. */
  body: ReadableStream<Uint8Array>;
  /** Exactly what `buildRequest` returned, unread by the host. */
  decodeState: unknown;
  /** For a provider that reports usage or rate limits in response headers. */
  headers: Headers;
  /**
   * The host's error constructor. See `CodecInput.fail`.
   *
   * Here as well as on `buildRequest` because a decoder reaches states its
   * builder cannot rule out — `custom` cannot tell which dialect it is reading
   * without the state it stashed — and an error raised there crosses the same
   * bundle boundary.
   */
  fail: CodecFail;
};

export type CodecErrorInput = {
  status: number;
  /**
   * The response body as text, already read by the host.
   *
   * A string rather than the response, so the hook cannot re-read the stream or
   * reach the socket — and so the host can read it once and hand the same text
   * to both this and its own `httpError`.
   */
  body: string;
  headers: Headers;
  /**
   * What `buildRequest` reported for this request.
   *
   * Passed through so a codec can attach them to the error it returns.
   * `dispatch` writes `error.degradations` into `request_logs`, and for a
   * refusal caused by what the request had to give up, those two facts belong
   * in one row.
   */
  degradations: readonly string[];
  /** Exactly what `buildRequest` returned, unread by the host. */
  decodeState: unknown;
  /**
   * The error the host will throw if this hook returns `undefined`.
   *
   * **Added when Anthropic was converted, and the gap it closes is the reason
   * this hook exists at all.** The docblock above says the hook is here because
   * Anthropic reads its own 400 body to recognise a fingerprint refusal — and
   * the first version of this type could not express that. What that adapter
   * reclassifies is not the body but `httpError`'s *parsed message*: the
   * `error.message` field, or `detail`, truncated at 500 characters. A codec
   * given only `body` has to re-implement all three rules to produce the same
   * message the host would have, which is six copies of twenty lines — the exact
   * duplication this contract exists to remove — and a codec that got the
   * truncation subtly wrong would answer differently from the host for the same
   * response, silently.
   *
   * Discloses nothing new: it is derived from `status`, `headers` and `body`,
   * all of which are already here. A codec that wants the host's classification
   * for everything but one case returns `undefined` and never touches it; one
   * that wants to relabel a case rebuilds from this and keeps the message.
   */
  fallback: GatewayError;
  /** The host's error constructor. See `CodecInput.fail` for why a codec needs one. */
  fail: CodecFail;
};
