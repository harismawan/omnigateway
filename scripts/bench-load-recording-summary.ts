#!/usr/bin/env bun
export {};
/** Sanity evidence only; ranges deliberately retained on a contended host. */
const directory = process.argv[2];
if (!directory) throw Error("usage: bench-load-recording-summary.ts <directory>");
const spread = (values: number[]) => {
  values.sort((a, b) => a - b);
  return { min: values[0], median: values[1], max: values[2] };
};
const results = [];
for (const concurrency of [64, 1]) {
  const sides = [];
  for (const recording of ["off", "on"]) {
    const rounds = await Promise.all(
      [1, 2, 3].map((i) => Bun.file(`${directory}/${concurrency}-${i}-${recording}.json`).json()),
    );
    if (
      rounds.some(
        (r) =>
          Object.keys(r.errorDistribution).length ||
          Object.keys(r.statusCodeDistribution).some((s) => s !== "200"),
      )
    )
      throw Error("direct request errors");
    sides.push({
      recording,
      rps: spread(rounds.map((r) => r.summary.requestsPerSec)),
      p50Ms: spread(rounds.map((r) => r.latencyPercentiles.p50 * 1000)),
      p99Ms: spread(rounds.map((r) => r.latencyPercentiles.p99 * 1000)),
    });
  }
  results.push({ concurrency, sides });
}
console.log(
  JSON.stringify(
    { scope: "Functional/load-side sanity only; not a performance finding", results },
    null,
    2,
  ),
);
