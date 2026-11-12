#!/usr/bin/env bun
/**
 * Path vectors for the gateway's router and static file server, computed by
 * the runtime frozen TS runs on:
 *
 * - `pathname`: what `new URL(request.url).pathname` (and Elysia's path,
 *   which is the same text) makes of a request-target the HTTP parser
 *   accepted: dot segments resolved, `%2e` dots included, and the WHATWG
 *   path percent-encode set applied;
 * - `decoded`: `decodeURIComponent` of that pathname, or `null` where it
 *   throws `URIError`.
 *
 *   bun conformance/vectors/static-paths.ts > conformance/vectors/static-paths.json
 */
const targets = [
  "/",
  "/index.html",
  "/a/b/c",
  "/a/../b",
  "/a/./b",
  "/a/..",
  "/a/.",
  "/..",
  "/../../etc/passwd",
  "/%2e%2e/%2e%2e/etc/passwd",
  "/%2E%2E/x",
  "/.%2e/x",
  "/%2e./x",
  "/%2e/x",
  "/x/%2E",
  "/x/.%2E/",
  "/...",
  "/..a/b",
  "/a..",
  "//a",
  "///a//b/",
  "/api/../v1/models",
  "/x/../metrics",
  "/%252e%252e/etc",
  "/..%2fetc",
  "/..%5cetc",
  "/a%2Fb",
  '/a"b',
  "/a{b}",
  "/a^b",
  "/a|b",
  "/a[b]",
  "/a'b",
  "/a~b",
  "/a!$&()*+,;=:@b",
  "/a%20b",
  "/%C3%BC.txt",
  "/%c3%bc",
  "/%00",
  "/%",
  "/%Z1",
  "/a%2",
  "/%E0%A4%A",
  "/%C0%AF",
  "/%ED%A0%80",
  "/%F4%90%80%80",
  "/%F0%9F%98%80",
  "/%80",
  "/%FF",
  "/%41%42",
  "/assets/%2e%2e/index.html",
  "/assets//x.css",
  "/a/b/../../..",
  "/a\\b",
  "/..\\..\\etc/passwd",
  "/assets\\x.css",
  "/%5c..%5cetc",
];

const out = targets.map((target) => {
  // As Bun builds `request.url`: the origin, then the request-target verbatim.
  const pathname = new URL(`http://127.0.0.1:1${target}`).pathname;
  let decoded: string | null;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = null;
  }
  return { target, pathname, decoded };
});
// Formatted by the repository's pinned Biome, so `biome check` accepts the
// committed file unchanged and a rerun reproduces it byte for byte.
const formatted = Bun.spawnSync(
  ["bunx", "biome", "format", "--stdin-file-path=conformance/vectors/static-paths.json"],
  {
    cwd: new URL("../..", import.meta.url).pathname,
    stdin: new TextEncoder().encode(`${JSON.stringify({ cases: out })}\n`),
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
process.stdout.write(formatted.stdout.toString());
