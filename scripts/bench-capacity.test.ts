import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("capacity gates single-client failures, missing and unknown probes", async () => {
  const dir = mkdtempSync("/tmp/opencode/capacity-test-");
  const gateway = join(dir, "../", `${dir.split("/").pop()}-gateway.json`);
  try {
    await Bun.write(
      gateway,
      JSON.stringify({
        scenarios: ["chat", "responses", "messages"].flatMap((wire) =>
          [1, 2000].map((chunks) => ({
            provider: wire === "messages" ? "anthropic-key" : `custom-${wire}`,
            name: chunks === 2000 ? "chunks-2000" : "normal",
            classification: "supported",
            metrics: { rps: 1 },
          })),
        ),
      }),
    );
    const good = {
      statusCodeDistribution: { "200": 10 },
      errorDistribution: {},
      summary: { successRate: 1, requestsPerSec: 100 },
    };
    for (const wire of ["chat", "responses", "messages"])
      for (const shape of ["c1", "c1-clients1", "c2000"])
        await Bun.write(join(dir, `${wire}-${shape}.json`), JSON.stringify(good));
    const check = async () =>
      Bun.spawn(["bun", "scripts/bench-capacity.ts", dir, gateway], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
    expect(await check()).toBe(0);
    const single = join(dir, "chat-c1-clients1.json");
    await Bun.write(
      single,
      JSON.stringify({
        ...good,
        statusCodeDistribution: { "500": 10 },
        summary: { successRate: 0, requestsPerSec: 100 },
      }),
    );
    expect(await check()).not.toBe(0);
    rmSync(single);
    expect(await check()).not.toBe(0);
    await Bun.write(single, JSON.stringify(good));
    await Bun.write(join(dir, "unknown.json"), "{}");
    expect(await check()).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(gateway, { force: true });
  }
});
