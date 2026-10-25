import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import {
  ConnectTimeoutError,
  IncompleteResponseError,
  ResponseTooLargeError,
  type Transport,
  type TransportResponse,
} from "./deliver.ts";

/**
 * The export worker's HTTP transport. Not `HttpClient` — destinations are not
 * providers — and not `fetch`, which has no connect timeout of its own
 * (measured on Bun 1.4.4: its `timeout` option is an idle timer that does not
 * run during the connect, so an unroutable receiver hangs until the request
 * deadline). `node:http` exposes the socket, so the connect — TCP and, on
 * https, the TLS handshake — gets its own bound.
 *
 * Redirects are never followed: node does not follow them, and the 3xx comes
 * back to `deliver`, which treats it as a hard failure. A response body is
 * read whole or not at all: a body the receiver cut short rejects
 * ({@link IncompleteResponseError}), and one past {@link MAX_RESPONSE_BYTES}
 * rejects as {@link ResponseTooLargeError} — partial text is never handed
 * back as though it were the reply.
 *
 * IPv6 literals: `URL.hostname` keeps the brackets (`[::1]`), which a socket
 * cannot resolve, so they are stripped for the connect; node's own `Host`
 * header puts them back.
 */

/** What a bulk or OTLP reply needs; a 500-item `_bulk` answer is well under it. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const httpTransport: Transport = (url, init) =>
  new Promise<TransportResponse>((resolve, reject) => {
    if (init.signal.aborted) {
      reject(init.signal.reason);
      return;
    }
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const body = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const outgoing = send(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: { ...init.headers, "content-length": String(body.byteLength) },
        // A fresh connection per request: a batch goes out every few seconds at
        // most, and a pooled TLS socket would never emit the `secureConnect`
        // the connect timeout waits for.
        agent: false,
      },
      (incoming) => {
        settled = true;
        resolve(response(incoming));
      },
    );

    const fail = (error: unknown): void => {
      clearTimeout(connectTimer);
      init.signal.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const onAbort = (): void => {
      outgoing.destroy();
      fail(init.signal.reason);
    };
    init.signal.addEventListener("abort", onAbort, { once: true });
    outgoing.on("error", fail);
    outgoing.on("close", () => {
      clearTimeout(connectTimer);
      init.signal.removeEventListener("abort", onAbort);
    });
    outgoing.on("socket", (socket: Socket) => {
      const ready = target.protocol === "https:" ? "secureConnect" : "connect";
      connectTimer = setTimeout(() => {
        outgoing.destroy();
        fail(new ConnectTimeoutError());
      }, init.connectTimeoutMs);
      socket.once(ready, () => clearTimeout(connectTimer));
    });
    outgoing.end(body);
  });

function response(incoming: IncomingMessage): TransportResponse {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (typeof value === "string") headers.set(name, value);
  }
  let body: Promise<string> | null = null;
  /**
   * The body, whole. `complete` is node's own word that the message ended as
   * framed (content-length reached, last chunk seen); a `close` or `error`
   * before it is a cut connection. `keep: false` drains without holding
   * bytes, so an over-limit body is dropped rather than refused.
   */
  const read = (keep: boolean): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      let done = false;
      const finish = (outcome: () => void): void => {
        if (done) return;
        done = true;
        outcome();
      };
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (!keep || over) return;
        if (size > MAX_RESPONSE_BYTES) {
          over = true;
          chunks.length = 0;
          finish(() => reject(new ResponseTooLargeError()));
          incoming.destroy();
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        finish(() =>
          incoming.complete
            ? resolve(Buffer.concat(chunks).toString("utf8"))
            : reject(new IncompleteResponseError()),
        );
      });
      incoming.on("error", () => finish(() => reject(new IncompleteResponseError())));
      incoming.on("close", () => {
        finish(() =>
          incoming.complete
            ? resolve(Buffer.concat(chunks).toString("utf8"))
            : reject(new IncompleteResponseError()),
        );
      });
    });
  return {
    status: incoming.statusCode ?? 0,
    headers,
    text() {
      body ??= read(true);
      return body;
    },
    async discard() {
      body ??= read(false);
      await body;
    },
  };
}
