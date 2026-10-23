import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { buildDashboard, dashboardRoot } from "./build.ts";
import { createRebuilder, watchDashboard } from "./watch.ts";

type Options = {
  root?: string;
  mode: "dev" | "preview";
  hostname?: string;
  port?: number;
  upstream?: string;
  watch?: boolean;
  build?: (root: string, output: string) => Promise<void>;
  onError?: (error: unknown) => void;
};

const RELOAD = "/__omni_reload";
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function endToEnd(headers: Headers) {
  const copy = new Headers(headers);
  const connection =
    copy
      .get("connection")
      ?.split(",")
      .map((name) => name.trim()) ?? [];
  for (const name of [...connection, ...HOP_HEADERS]) copy.delete(name);
  return copy;
}

export async function startDashboardServer(options: Options) {
  const root = await realpath(resolve(options.root ?? dashboardRoot));
  const dev = options.mode === "dev";
  const output = join(root, "dist");
  const onError = options.onError ?? console.error;
  const build = options.build ?? buildDashboard;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encode = new TextEncoder();
  let version = 0;
  let closed = false;
  const snapshots: string[] = [];
  let active = output;
  // Snapshots are kept until shutdown: a browser can still request a lazy chunk
  // from the previous HTML after a successful rebuild was published.
  const scratch = dev
    ? await realpath(await mkdtemp(join(tmpdir(), "omni-dashboard-dev-")))
    : undefined;
  async function rebuild() {
    if (!scratch || closed) return;
    const next = await mkdtemp(join(scratch, "build-"));
    try {
      await build(root, next);
      if (closed) {
        await rm(next, { recursive: true, force: true });
        return;
      }
      snapshots.unshift(next);
      active = next;
      version++;
      for (const client of clients) client.enqueue(encode.encode(`data: ${version}\n\n`));
    } catch (error) {
      await rm(next, { recursive: true, force: true });
      throw error;
    }
  }
  let initialError: unknown;
  const rebuilder = createRebuilder(rebuild, (error) => {
    initialError = error;
    onError(error);
  });
  let stopWatch: (() => void) | undefined;
  try {
    stopWatch =
      dev && options.watch !== false
        ? watchDashboard(root, () => {
            void rebuilder.request();
          })
        : undefined;
    if (dev) {
      await rebuilder.request();
      if (!version) throw initialError ?? new Error("Dashboard initial build failed");
    } else {
      if (!(await Bun.file(join(output, "index.html")).exists()))
        throw new Error("No dashboard build found; run bun run build first");
      active = await realpath(output);
    }
    const upstream = new URL(options.upstream ?? "http://127.0.0.1:9000");
    async function proxy(request: Request, url: URL) {
      const target = new URL(url.pathname + url.search, upstream);
      try {
        const init: BunFetchRequestInit = {
          method: request.method,
          headers: endToEnd(request.headers),
          body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
          signal: request.signal,
          redirect: "manual",
          // Pass compressed bytes and their matching headers through unchanged.
          decompress: false,
        };
        const response = await fetch(target, init);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: endToEnd(response.headers),
        });
      } catch {
        return new Response("Gateway unavailable", { status: 502 });
      }
    }
    async function containedFile(directory: string, pathname: string) {
      const candidate = resolve(directory, `.${pathname}`);
      if (!candidate.startsWith(`${directory}${sep}`)) return;
      try {
        const physical = await realpath(candidate);
        if (!physical.startsWith(`${directory}${sep}`)) return;
        const file = Bun.file(physical);
        if (await file.exists()) return file;
      } catch {
        /* missing file */
      }
    }
    const server = Bun.serve({
      hostname: options.hostname ?? "localhost",
      port: options.port ?? (dev ? 5173 : 4173),
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (
          url.pathname === "/api" ||
          url.pathname.startsWith("/api/") ||
          url.pathname === "/health"
        )
          return proxy(request, url);
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        if (url.pathname === RELOAD) {
          if (!dev) return new Response("Not found", { status: 404 });
          let controller: ReadableStreamDefaultController<Uint8Array>;
          const remove = () => {
            clients.delete(controller);
          };
          const stream = new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              clients.add(controller);
              controller.enqueue(encode.encode(": connected\n\n"));
              // A tab disconnected during publication must not miss the update.
              if (Number(url.searchParams.get("version")) !== version)
                controller.enqueue(encode.encode(`data: ${version}\n\n`));
              request.signal.addEventListener("abort", remove, { once: true });
            },
            cancel() {
              remove();
              request.signal.removeEventListener("abort", remove);
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return new Response("Bad path", { status: 400 });
        }
        if (
          pathname.includes("\0") ||
          pathname.includes("\\") ||
          pathname.split("/").includes("..")
        )
          return new Response("Forbidden", { status: 403 });
        for (const directory of dev ? snapshots : [active]) {
          const file = await containedFile(directory, pathname);
          if (file && pathname !== "/index.html")
            return new Response(request.method === "HEAD" ? null : file, {
              headers: { "content-type": file.type, "cache-control": "no-cache" },
            });
        }
        if (extname(pathname) && pathname !== "/index.html")
          return new Response("Not found", { status: 404 });
        let html = await Bun.file(join(active, "index.html")).text();
        if (dev)
          html = html.replace(
            "</body>",
            `<script>new EventSource('${RELOAD}?version=${version}').onmessage=()=>location.reload();</script></body>`,
          );
        return new Response(request.method === "HEAD" ? null : html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      },
    });
    return {
      url: server.url,
      rebuild: () => (dev ? rebuilder.request() : Promise.resolve()),
      async close() {
        closed = true;
        stopWatch?.();
        for (const client of clients) client.close();
        clients.clear();
        server.stop(true);
        // Join an in-flight build before removing its temporary output.
        await rebuilder.request();
        if (scratch) await rm(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closed = true;
    stopWatch?.();
    await rebuilder.request();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      preview: { type: "boolean" },
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      upstream: { type: "string" },
    },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error("Invalid port");
  const app = await startDashboardServer({
    mode: values.preview ? "preview" : "dev",
    hostname: values.host,
    ...(port === undefined ? {} : { port }),
    ...(values.upstream === undefined ? {} : { upstream: values.upstream }),
  });
  console.log(`Dashboard ${values.preview ? "preview" : "dev (full reload)"}: ${app.url}`);
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
