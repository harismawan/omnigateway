import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("comparison reports spread and excludes failed fast responses", async () => {
  const root = mkdtempSync("/tmp/opencode/bench-compare-");
  try {
    for (const side of ["base", "head"]) {
      mkdirSync(join(root, side));
      for (const [i, rps] of [10, 30, 99999].entries()) {
        await Bun.write(
          join(root, side, `${i}.json`),
          JSON.stringify({
            scenarios: [
              { name: "case", classification: i === 2 ? "failed" : "supported", metrics: { rps } },
            ],
          }),
        );
      }
    }
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "bench-compare.ts"),
        join(root, "base"),
        join(root, "head"),
      ],
      { stdout: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(output).toContain("2/3 rounds; 20 [10–30]");
    expect(output).toContain("1.000");
    expect(output).not.toContain("99999");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
