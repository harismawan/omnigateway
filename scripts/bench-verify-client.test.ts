import { expect, test } from "bun:test";
import { runVerifier } from "./bench-verify-client";

test("fixed ticks skip in-flight work and shutdown drains it", async () => {
  let now = 0;
  let tick = () => {};
  let release = () => {};
  const run = runVerifier(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { classification: "supported", reason: "" };
  }, {
    now: () => now,
    schedule: (callback) => { tick = callback; return () => {}; },
  });
  now = 250; tick();
  now = 500; tick();
  release();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  now = 750; tick();
  const done = run.stop();
  release();
  const report = await done;
  expect(report).toMatchObject({ started: 2, completed: 2, skippedTicks: 2, violations: 0, requests: 2 });
});
