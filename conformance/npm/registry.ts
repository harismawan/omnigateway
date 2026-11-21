/**
 * A read-only npm registry over a directory of `.tgz` files, enough for
 * `npm install -g` / `npm update -g`: one packument per name, `latest` = the
 * highest version present. Tarballs are added between steps by copying files.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Manifest = { name: string; version: string } & Record<string, unknown>;

function manifestOf(file: string): Manifest {
  const out = Bun.spawnSync(["tar", "-xzOf", file, "package/package.json"]);
  if (out.exitCode !== 0) throw new Error(`no package.json in ${file}`);
  return JSON.parse(out.stdout.toString()) as Manifest;
}

function compare(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function serve(dir: string, port = 0): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname.startsWith("/-/tarball/")) {
        const name = decodeURIComponent(url.pathname.slice("/-/tarball/".length));
        return new Response(readFileSync(join(dir, name)));
      }
      if (request.method !== "GET" || url.pathname.startsWith("/-/")) {
        return new Response("{}", { status: 404 });
      }
      const wanted = decodeURIComponent(url.pathname.slice(1));
      const versions: Record<string, unknown> = {};
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
        const bytes = readFileSync(join(dir, file));
        const manifest = manifestOf(join(dir, file));
        if (manifest.name !== wanted) continue;
        versions[manifest.version] = {
          ...manifest,
          dist: {
            tarball: `${base}/-/tarball/${encodeURIComponent(file)}`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          },
        };
      }
      const sorted = Object.keys(versions).sort(compare);
      const latest = sorted.at(-1);
      if (latest === undefined) return new Response('{"error":"not found"}', { status: 404 });
      return Response.json({ name: wanted, "dist-tags": { latest }, versions });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

// `bun registry.ts <dir>`: serve until killed, printing the URL once ready.
// A separate process, because the driver's spawnSync blocks its own loop.
if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: registry.ts <dir>");
  console.log(serve(dir).url);
}
