import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifier } from "./bench-verify-client";

test("repeated stop signals drain a real pending request exactly once", async () => {
  let arrived = () => {};
  const pending = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = Bun.serve({
    port: 0,
    async fetch() {
      arrived();
      await Bun.sleep(600);
      return Response.json({
        choices: [{ message: { content: "lorem ipsum " } }],
        usage: { prompt_tokens: 64, completion_tokens: 2 },
      });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "verifier-test-"));
  try {
    const file = join(dir, "config.json");
    await Bun.write(
      file,
      JSON.stringify({
        base: server.url.toString().replace(/\/$/, ""),
        key: "fixture",
        scenario: {
          provider: "custom-chat",
          ingress: "chat",
          mode: "json",
          path: "/v1/chat/completions",
          body: JSON.stringify({ model: "custom-chat-c1" }),
        },
      }),
    );
    const child = Bun.spawn(["bun", join(import.meta.dir, "bench-verify-client.ts"), file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await pending;
    child.kill("SIGTERM");
    await Bun.sleep(50);
    child.kill("SIGTERM");
    child.kill("SIGINT");
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    child.kill("SIGTERM");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ started: 1, completed: 1, violations: 0 });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed ticks skip in-flight work and shutdown drains it", async () => {
  let now = 0;
  let tick = () => {};
  let release = () => {};
  const run = runVerifier(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { classification: "supported", reason: "" };
    },
    {
      now: () => now,
      schedule: (callback) => {
        tick = callback;
        return () => {};
      },
    },
  );
  now = 250;
  tick();
  now = 500;
  tick();
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  now = 750;
  tick();
  const done = run.stop();
  release();
  const report = await done;
  expect(report).toMatchObject({
    started: 2,
    completed: 2,
    skippedTicks: 2,
    violations: 0,
    requests: 2,
  });
});
