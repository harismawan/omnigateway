import type { ChatRequest, GatewayError, StreamEvent } from "@omni/ir";
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
};

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
};

export type CodecErrorInput = {
  status: number;
  /** The response body as text, already read by the host. */
  body: string;
  headers: Headers;
};
