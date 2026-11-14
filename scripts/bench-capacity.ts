#!/usr/bin/env bun
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
console.log(
  "| wire | chunks | direct statuses clean | >3× best observed gateway |\n|---|---:|---|---|",
);
for (const wire of ["chat", "responses", "messages"]) {
  for (const chunks of [1, 2000]) {
    const direct = await Bun.file(join(directory, `${wire}-c${chunks}.json`)).json();
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
      Object.keys(direct.statusCodeDistribution).every((status) => status === "200") &&
      Object.keys(direct.errorDistribution).length === 0 &&
      direct.summary.successRate === 1;
    const pass = clean && best > 0 && direct.summary.requestsPerSec > 3 * best;
    console.log(`| ${wire} | ${chunks} | ${clean} | ${pass ? "pass" : "inconclusive/fail"} |`);
    if (!pass) process.exitCode = 1;
  }
}
