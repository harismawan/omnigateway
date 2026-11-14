import { expect, test } from "bun:test";
import { compare, overlaps, type Round } from "./bench-compare";

const round = (n: number, classification = "supported", hash = "a".repeat(64)): Round => ({
  provenance: { gatewaySha256: hash },
  scenarios: [
    {
      name: "custom-chat.chat.json",
      provider: "custom-chat",
      classification,
      metrics: { rps: n, latencyMs: { p50: n, p99: n }, cpuMsPerRequest: n, rssPeakMb: n },
    },
  ],
});
test("inclusive overlap and disjoint ranges", () => {
  expect(overlaps({ min: 1, max: 3 }, { min: 3, max: 4 })).toBe(true);
  expect(overlaps({ min: 1, max: 3 }, { min: 2, max: 2 })).toBe(true);
  expect(overlaps({ min: 1, max: 3 }, { min: 4, max: 5 })).toBe(false);
  expect(compare([round(10), round(30)], [round(20), round(40)])).toContain(
    "1.500 — inside spread",
  );
});
test("unequal successful round counts are explicit", () => {
  const output = compare([round(10), round(20)], [round(40)]);
  expect(output).toContain("2/2; 15.000 [10.000–20.000]");
  expect(output).toContain("1/1; 40.000 [40.000–40.000]");
  expect(output).toContain("2.667 — better");
  expect(output).toContain("2.667 — worse");
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
