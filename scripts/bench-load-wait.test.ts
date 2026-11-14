import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

test("load guard waits for falling load, times out, or bypasses", async () => {
  const dir = mkdtempSync("/tmp/opencode/load-wait-");
  const file = `${dir}/load`;
  const run = (busy = "0") =>
    Bun.spawn(
      [
        "bash",
        "-c",
        'source scripts/bench-load-wait.sh; wait_for_load; code=$?; echo "$load_begin $load_waited $load_start"; exit "$code"',
      ],
      {
        env: {
          ...process.env,
          BENCH_TEST_LOAD_FILE: file,
          LOAD_WAIT: "1",
          LOAD_POLL: "0.05",
          MAX_LOAD: "1",
          ALLOW_BUSY: busy,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  try {
    await Bun.write(file, "9 0 0");
    const falling = run();
    await Bun.sleep(150);
    await Bun.write(file, "0.5 0 0");
    expect(await falling.exited).toBe(0);
    expect(await new Response(falling.stderr).text()).toContain("wait ended");
    expect(await new Response(falling.stdout).text()).toMatch(/^9 .* 0.5/);
    await Bun.write(file, "9 0 0");
    const high = run();
    expect(await high.exited).toBe(2);
    expect(await new Response(high.stderr).text()).toContain("last load 9");
    const bypass = run("1");
    expect(await bypass.exited).toBe(0);
    expect(await new Response(bypass.stderr).text()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
