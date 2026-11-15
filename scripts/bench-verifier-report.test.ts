import { expect, test } from "bun:test";
import { collectVerifierReport } from "./bench-verifier-report";

test("silent verifier exit becomes a diagnostic rather than an exception", async () => {
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "pipe" });
  const report = await collectVerifierReport(child);
  expect(report.requests).toBe(0);
  expect(report.errors).toContain("verifier produced no report");
});
