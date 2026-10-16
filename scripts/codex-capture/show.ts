#!/usr/bin/env bun
/**
 * Prints one captured request: headers in wire order (authorization redacted)
 * and a summary of the body, decompressing it when Codex sent zstd.
 *
 *   bun scripts/codex-capture/show.ts <NNN> <capture-dir>
 *
 * Output still carries the capture's installation id, thread ids and local
 * paths. Read it; never paste it into a fixture unsanitized.
 */
import { readFileSync } from "node:fs";

const k = process.argv[2];
const dir = process.argv[3];
if (k === undefined || dir === undefined) {
  console.error("usage: show.ts <NNN> <capture-dir>");
  process.exit(2);
}

const head = readFileSync(`${dir}/${k}.head.txt`, "latin1").replace(
  /(authorization: Bearer ).*/i,
  "$1<redacted>",
);
console.log(head);

const raw = readFileSync(`${dir}/${k}.body.bin`);
if (raw.length === 0) process.exit(0);
const text = /content-encoding: zstd/i.test(head)
  ? Buffer.from(Bun.zstdDecompressSync(raw)).toString("utf8")
  : raw.toString("utf8");
const body = JSON.parse(text) as Record<string, unknown>;

console.log("\nkeys:", Object.keys(body).join(", "));
for (const [key, value] of Object.entries(body)) {
  if (key === "input" || key === "client_metadata") continue;
  console.log(`${key} = ${JSON.stringify(value)?.slice(0, 200)}`);
}
const metadata = (body.client_metadata ?? {}) as Record<string, string>;
console.log("client_metadata keys:", Object.keys(metadata).join(", "));
const turn = metadata["x-codex-turn-metadata"];
if (turn !== undefined) console.log("turn-metadata:", turn);

console.log("input:");
for (const item of (body.input ?? []) as Record<string, unknown>[]) {
  const { content, tools, ...rest } = item;
  const first = Array.isArray(content)
    ? `content[0]=${JSON.stringify(content[0]).slice(0, 80)}`
    : "";
  const names = Array.isArray(tools)
    ? `tools=${tools.map((t: { name?: string }) => t.name).join("|")}`
    : "";
  console.log(" ", JSON.stringify(rest).slice(0, 260), first, names);
}
