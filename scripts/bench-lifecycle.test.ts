import { expect, test } from "bun:test";

test("Responses fixture lifecycle is sequenced and usage is completed-only", async () => {
  const proc = Bun.spawn(
    [process.execPath, `${import.meta.dir}/bench-gateway-upstream.ts`, "--port", "18149"],
    { stdout: "ignore", stderr: "inherit" },
  );
  try {
    await Bun.sleep(300);
    const response = await fetch("http://127.0.0.1:18149/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "mock-c3-d0", stream: true }),
    });
    const frames = (await response.text())
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)));
    expect(frames.map((f) => f.sequence_number)).toEqual(frames.map((_, i) => i));
    expect(frames.map((f) => f.type)).toContain("response.in_progress");
    expect(frames.map((f) => f.type)).toContain("response.content_part.done");
    expect(frames.filter((f) => f.response?.usage).map((f) => f.type)).toEqual([
      "response.completed",
    ]);
  } finally {
    proc.kill();
    await proc.exited;
  }
});
