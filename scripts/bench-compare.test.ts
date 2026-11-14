import { expect, test } from "bun:test";
import { compare, overlaps, type Round } from "./bench-compare";

const round = (n: number, classification = "supported", hash = "a".repeat(64)): Round => ({
  provenance: { gatewaySha256: hash, harnessCommit: "fixture", environment: {} },
  config: {
    duration: "2s",
    warmup: "1s",
    gatewayCpus: "0-3",
    upstreamCpus: "4-5",
    loadCpus: "6-7",
    cpuSets: ["0-3"],
  },
  scenarios: [
    {
      name: "custom-chat.chat.json",
      provider: "custom-chat",
      classification,
      concurrency: 64,
      bodySha256: "b".repeat(64),
      metrics: { rps: n, latencyMs: { p50: n, p99: n }, cpuMsPerRequest: n, rssPeakMb: n },
    },
  ],
});
test("inclusive overlap and disjoint ranges", () => {
  expect(overlaps({ min: 1, max: 3 }, { min: 3, max: 4 })).toBe(true);
  expect(overlaps({ min: 1, max: 3 }, { min: 2, max: 2 })).toBe(true);
  expect(overlaps({ min: 1, max: 3 }, { min: 4, max: 5 })).toBe(false);
  expect(compare([round(10), round(30)], [round(20), round(40)])).toContain(
    "1.500 — insufficient rounds",
  );
});
test("unequal successful round counts are explicit", () => {
  const output = compare([round(10), round(20)], [round(40)]);
  expect(output).toContain("2/2; 15.000 [10.000–20.000]");
  expect(output).toContain("1/1; 40.000 [40.000–40.000]");
  expect(output).toContain("2.667 — insufficient rounds");
  expect(output).not.toContain(" — better");
});
test("missing observation is flagged", () => {
  const missing = round(1);
  missing.scenarios = [];
  expect(() => compare([round(1), missing], [round(2)])).toThrow("ordered selection");
});
test("ordered selection must match unless every round uses fresh processes", () => {
  const a = round(1),
    b = round(2);
  const first = a.scenarios[0];
  if (!first) throw Error("missing fixture");
  a.scenarios.unshift({ ...first, name: "first" });
  expect(() => compare([a], [b])).toThrow("ordered selection");
  b.scenarios = [...a.scenarios].reverse();
  expect(() => compare([a], [b])).toThrow("ordered selection");
  a.config = { ...a.config, freshProcess: true };
  b.config = { ...b.config, freshProcess: true };
  b.scenarios = [first];
  expect(compare([a], [b])).toContain("differing ordered selections allowed");
});
test("changed workload refused with differing field", () => {
  const a = round(1);
  const b = { ...round(2), config: { ...round(2).config, duration: "3s" } };
  expect(() => compare([a], [b])).toThrow("duration");
});
test("any failed or unsupported round suppresses scenario ratios", () => {
  for (const status of ["failed", "unsupported"]) {
    const output = compare([round(10), round(99999, status)], [round(20)]);
    expect(output).toContain(`1/2; ${status}`);
    expect(output).not.toContain("99999");
    expect(output).not.toContain(" — better");
    expect(output).not.toContain(" — worse");
  }
});
test("mixed or absent binary identity is refused", () => {
  expect(() => compare([round(10), round(20, "supported", "b".repeat(64))], [round(20)])).toThrow(
    "consistent",
  );
  expect(() => compare([round(10, "supported", "")], [round(20)])).toThrow("consistent");
});
test("three observations permit direction; all compatibility fields enforced", () => {
  expect(compare([round(1), round(2), round(3)], [round(4), round(5), round(6)])).toContain(
    "2.500 — better",
  );
  for (const field of [
    "duration",
    "warmup",
    "gatewayCpus",
    "upstreamCpus",
    "loadCpus",
    "cpuSets",
  ]) {
    const b = round(2);
    b.config = { ...b.config, [field]: "changed" };
    expect(() => compare([round(1), b], [round(2)])).toThrow(field);
    if (field === "environment")
      expect(() => compare([round(1), b], [round(1)])).toThrow("environment");
    else expect(() => compare([round(1)], [b])).toThrow(field);
  }
  for (const field of ["harnessCommit", "environment"] as const) {
    const b = round(2);
    if (field === "environment") b.provenance.environment = { OMNI_BENCH: "changed" };
    else b.provenance.harnessCommit = "changed";
    expect(() => compare([round(1), b], [round(1)])).toThrow(field);
  }
  for (const field of ["concurrency", "bodySha256"] as const) {
    const b = round(2);
    const s = b.scenarios[0];
    if (s) {
      if (field === "concurrency") s.concurrency = 1;
      else s.bodySha256 = "changed";
    }
    expect(() => compare([round(1)], [b])).toThrow(field);
  }
});
test("environment differences disclosed between sides but strict on demand", () => {
  const a = round(1),
    b = round(2);
  b.provenance.environment = { MIMALLOC_PURGE_DELAY: "1" };
  expect(compare([a], [b])).toContain("environment differences between sides");
  expect(() => compare([a], [b], { requireSameEnv: true })).toThrow("MIMALLOC_PURGE_DELAY");
});
test("only own scratch root prefix is normalized", () => {
  const a = round(1),
    b = round(2);
  a.provenance.environment = { OMNI_ROOT: "/tmp/a", OMNI_DB_PATH: "/tmp/a/db" };
  b.provenance.environment = { OMNI_ROOT: "/tmp/b", OMNI_DB_PATH: "/tmp/b/db" };
  expect(() => compare([a, b], [a])).not.toThrow();
  b.provenance.environment.OMNI_DB_PATH = "/elsewhere/db";
  expect(() => compare([a, b], [a])).toThrow("OMNI_DB_PATH");
  a.provenance.environment.OMNI_DB_PATH = "prefix/tmp/a/db";
  b.provenance.environment.OMNI_DB_PATH = "prefix/tmp/b/db";
  expect(() => compare([a, b], [a])).toThrow("OMNI_DB_PATH");
});
test("comparison carries measurement limits", () => {
  const text = compare([round(1)], [round(2)]);
  for (const limit of [
    "threads only",
    "100 ms",
    "250 ms tolerance",
    "extra gateway work",
    "not a proof",
  ])
    expect(text).toContain(limit);
});
test("comparison discloses largest runner start load per side", () => {
  const a = round(1),
    b = round(2);
  Object.assign(a, { loadWait: { startLoad: 0.4 } });
  Object.assign(b, { loadWait: { startLoad: 0.8 } });
  expect(compare([a, b], [a])).toContain("Largest start-of-run load: base 0.8; head 0.4");
});
test("verifier counts come from measured metrics", () => {
  const a = round(1);
  const metric = a.scenarios[0]?.metrics;
  if (!metric) throw Error("missing fixture");
  Object.assign(metric, {
    integrity: { verifier: { started: 8, completed: 8, skippedTicks: 1, violations: 0 } },
  });
  expect(compare([a], [a])).toContain("custom-chat.chat.json=8/8/1/0");
});
