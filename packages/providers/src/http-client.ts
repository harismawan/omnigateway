import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { type Logger, noopLogger } from "@omni/ir";
import type { HttpClient, HttpRequest, HttpResponse } from "./types.ts";

/**
 * How long one address family gets before Happy Eyeballs abandons it.
 *
 * `autoSelectFamily` is on by default, and node's own default budget is shorter
 * than a single TCP retransmit. Linux's initial RTO is one second, so a dropped
 * SYN — routine on any lossy path — is retransmitted at ~1000ms and the
 * connection succeeds. A 500ms budget gives up first and reports the attempt as
 * `ETIMEDOUT`, and when the other family cannot serve (an AAAA record with no
 * IPv6 route, say) both attempts are then exhausted: node raises an
 * `AggregateError`, whose message is empty, at ~505ms.
 *
 * That is not a slow network; it is a deadline set inside TCP's own recovery.
 * Measured against `api.anthropic.com` from such a host: 3 failures in 99
 * attempts at 500ms, 0 in 212 once raised, with the previously-failing connects
 * completing at 1007–1061ms. The value must stay above one RTO; the rest of the
 * margin covers a retransmit that is itself late.
 *
 * Raising it costs latency only where a family is unreachable *and* silent —
 * a refused connection still errors immediately and falls through as before.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 3000;

export type HttpClientOptions = {
  logger?: Logger;
  now?: () => number;
};

/**
 * An HttpClient built on node:http.
 *
 * Bun's fetch sorts request headers alphabetically. node:http writes them in
 * insertion order with the casing given, which is what the CLI fingerprint
 * needs. Nothing else on the upstream path may call fetch.
 *
 * Logging is debug-only, and records the host, the path, the status, and how
 * long the response head took. Never a header and never a body: the query
 * string is stripped because it can carry a key, and `LogFields` has no member
 * a body could be assigned to in the first place.
 */
export function nodeHttpClient(options: HttpClientOptions = {}): HttpClient {
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => Date.now());

  return (req: HttpRequest): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
      const url = new URL(req.url);
      const startedAt = now();
      let traced = false;
      const trace = (status: number | undefined, failed = false): void => {
        if (traced || !logger.enabled("debug")) return;
        traced = true;
        logger.debug("upstream http", {
          provider: req.provider,
          status,
          host: url.host,
          path: url.pathname,
          durationMs: now() - startedAt,
          reason: failed ? "transport error" : undefined,
        });
      };
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const bodyBytes = Buffer.from(req.body, "utf8");
      // A plain object preserves insertion order for string keys, and node
      // writes it in that order without re-casing. Content-Length is set
      // explicitly so node does not chunk and does not append its own headers
      // in the middle of the ordered set.
      const headers: Record<string, string | number> = {};
      for (const [name, value] of req.headers) headers[name] = value;
      if (req.body.length > 0 && !hasHeader(req, "content-length")) {
        headers["Content-Length"] = bodyBytes.byteLength;
      }
      // node forwards this to `net.connect`, which is where it is declared and
      // honoured, but `ClientRequestArgs` does not re-declare it. Naming the
      // type here rather than passing a fresh literal is what keeps the excess
      // property from sending the call to a different overload.
      const requestOptions: RequestOptions & { autoSelectFamilyAttemptTimeout: number } = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        // node adds its own Host and Connection otherwise; setting them
        // through `headers` above is how a profile pins their position.
        setHost: !hasHeader(req, "host"),
        autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
      };
      const outgoing = send(requestOptions, (incoming) => {
        const chunks: Buffer[] = [];
        let buffered: Promise<string> | null = null;
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(incoming.headers)) {
          if (Array.isArray(v)) for (const one of v) responseHeaders.append(k, one);
          else if (typeof v === "string") responseHeaders.set(k, v);
        }
        trace(incoming.statusCode);
        resolve({
          status: incoming.statusCode ?? 0,
          headers: responseHeaders,
          // Readable.toWeb keeps chunks incremental, which SSE depends on.
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          text: () => {
            buffered ??= new Promise<string>((res, rej) => {
              incoming.on("data", (c: Buffer) => chunks.push(c));
              incoming.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
              incoming.on("error", rej);
            });
            return buffered;
          },
        });
      });
      const onAbort = () => outgoing.destroy(new Error("aborted"));
      outgoing.on("error", (err) => {
        req.signal.removeEventListener("abort", onAbort);
        trace(undefined, true);
        reject(err);
      });
      outgoing.on("close", () => req.signal.removeEventListener("abort", onAbort));
      if (req.signal.aborted) {
        outgoing.destroy(new Error("aborted"));
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
      if (bodyBytes.byteLength > 0) outgoing.write(bodyBytes);
      outgoing.end();
    });
}

function hasHeader(req: HttpRequest, lowerName: string): boolean {
  return req.headers.some(([name]) => name.toLowerCase() === lowerName);
}
