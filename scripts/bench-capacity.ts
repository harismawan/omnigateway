#!/usr/bin/env bun
import { readdirSync } from "node:fs";
/** Sanity gate, not a performance conclusion: rerun on a quiet measurement host. */
import { join } from "node:path";

const [directory, ...files] = process.argv.slice(2);
if (!directory || !files.length)
  throw Error("usage: bench-capacity.ts <direct-results-directory> <gateway-result.json>...");
type Case = {
  provider: string;
  name: string;
  classification: string;
  metrics: { rps: number } | null;
};
const rows: Case[] = (
  await Promise.all(files.map(async (file) => (await Bun.file(file).json()).scenarios as Case[]))
).flat();
const expected = ["chat", "responses", "messages"].flatMap((wire) =>
  ["c1", "c1-clients1", "c2000"].map((shape) => `${wire}-${shape}.json`),
);
const actual = readdirSync(directory);
for (const file of actual)
  if (!expected.includes(file)) throw Error(`unrecognised probe file: ${file}`);
for (const file of expected) if (!actual.includes(file)) throw Error(`missing probe file: ${file}`);
console.log("| wire | chunks/clients | direct statuses clean | gate |\n|---|---:|---|---|");
for (const wire of ["chat", "responses", "messages"]) {
  for (const [chunks, clients] of [
    [1, 64],
    [1, 1],
    [2000, 16],
  ]) {
    const direct = await Bun.file(
      join(directory, `${wire}-c${chunks}${clients === 1 ? "-clients1" : ""}.json`),
    ).json();
    const candidates = rows.filter(
      (row) =>
        row.classification === "supported" &&
        (wire === "messages"
          ? row.provider.startsWith("anthropic-")
          : row.provider === `custom-${wire}`) &&
        row.name.endsWith("chunks-2000") === (chunks === 2000),
    );
    const best = Math.max(0, ...candidates.map((row) => row.metrics?.rps ?? 0));
    const clean =
      direct.statusCodeDistribution["200"] > 0 &&
      Object.keys(direct.statusCodeDistribution).every((status) => status === "200") &&
      Object.keys(direct.errorDistribution).length === 0 &&
      direct.summary.successRate === 1;
    const pass = clean && (clients === 1 || (best > 0 && direct.summary.requestsPerSec > 3 * best));
    console.log(
      `| ${wire} | ${chunks}/${clients} | ${clean} | ${pass ? "pass" : "inconclusive/fail"}: ${clients === 1 ? "all requests successful only; no rate ratio" : ">3× best observed gateway"} |`,
    );
    if (!pass) process.exitCode = 1;
  }
}
