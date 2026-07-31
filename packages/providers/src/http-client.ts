import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { HttpClient, HttpRequest, HttpResponse } from "./types.ts";

/**
 * An HttpClient built on node:http.
 *
 * Bun's fetch sorts request headers alphabetically. node:http writes them in
 * insertion order with the casing given, which is what the CLI fingerprint
 * needs. Nothing else on the upstream path may call fetch.
 */
export function nodeHttpClient(): HttpClient {
  return (req: HttpRequest): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
      const url = new URL(req.url);
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
      const outgoing = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: req.method,
          headers,
          // node adds its own Host and Connection otherwise; setting them
          // through `headers` above is how a profile pins their position.
          setHost: !hasHeader(req, "host"),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let buffered: Promise<string> | null = null;
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(incoming.headers)) {
            if (Array.isArray(v)) for (const one of v) responseHeaders.append(k, one);
            else if (typeof v === "string") responseHeaders.set(k, v);
          }
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
        },
      );
      const onAbort = () => outgoing.destroy(new Error("aborted"));
      if (req.signal.aborted) {
        outgoing.destroy(new Error("aborted"));
        reject(new Error("aborted"));
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
      outgoing.on("error", (err) => {
        req.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      outgoing.on("close", () => req.signal.removeEventListener("abort", onAbort));
      if (bodyBytes.byteLength > 0) outgoing.write(bodyBytes);
      outgoing.end();
    });
}

function hasHeader(req: HttpRequest, lowerName: string): boolean {
  return req.headers.some(([name]) => name.toLowerCase() === lowerName);
}
