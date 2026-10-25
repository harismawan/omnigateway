import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { ConnectTimeoutError, type Transport, type TransportResponse } from "./deliver.ts";

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
 * read only up to {@link MAX_RESPONSE_BYTES}; past that it is cut, and the
 * reader treats what it has as unreadable rather than waiting for the rest.
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
        hostname: target.hostname,
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
  let text: Promise<string> | null = null;
  return {
    status: incoming.statusCode ?? 0,
    headers,
    text() {
      text ??= new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (): void => resolve(Buffer.concat(chunks).toString("utf8"));
        incoming.on("data", (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          const room = MAX_RESPONSE_BYTES - size;
          const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          chunks.push(kept);
          size += kept.byteLength;
          if (size >= MAX_RESPONSE_BYTES) {
            incoming.destroy();
            done();
          }
        });
        incoming.on("end", done);
        incoming.on("error", done);
        incoming.on("close", done);
      });
      return text;
    },
  };
}
