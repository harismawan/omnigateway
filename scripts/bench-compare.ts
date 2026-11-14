#!/usr/bin/env bun
/** Two files or round directories; failures are never included in ratios. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = {
  name: string;
  classification?: string;
  rps?: number;
  metrics?: { rps: number } | null;
};
async function load(path: string) {
  const paths = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((p) => p.endsWith(".json"))
        .sort()
        .map((p) => join(path, p))
    : [path];
  return Promise.all(paths.map(async (p) => (await Bun.file(p).json()).scenarios as Row[]));
}
const [a, b] = process.argv.slice(2);
if (!a || !b) throw Error("usage: bench-compare.ts <base.json|directory> <head.json|directory>");
const sides = await Promise.all([load(a), load(b)]);
const names = [...new Set(sides.flat(2).map((r) => r.name))];
const summary = (rounds: Row[][], name: string) => {
  const values = rounds
    .map((rows) => rows.find((r) => r.name === name))
    .filter((r) => r && (r.classification === undefined || r.classification === "supported"))
    .map((r) => r?.metrics?.rps ?? r?.rps)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((x, y) => x - y);
  const n = values.length;
  const median = n
    ? ((values[Math.floor((n - 1) / 2)] ?? 0) + (values[Math.floor(n / 2)] ?? 0)) / 2
    : null;
  return {
    median,
    cell: `${n}/${rounds.length} rounds; ${median ?? "n/a"} [${values[0] ?? "n/a"}–${values[n - 1] ?? "n/a"}]`,
  };
};
console.log(
  "| scenario | base req/s median [min–max] | head req/s median [min–max] | head/base |\n|---|---|---|---:|",
);
for (const name of names) {
  const base = summary(sides[0] ?? [], name),
    head = summary(sides[1] ?? [], name);
  console.log(
    `| ${name} | ${base.cell} | ${head.cell} | ${base.median && head.median ? (head.median / base.median).toFixed(3) : "n/a"} |`,
  );
}
