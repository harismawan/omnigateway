import { expect, test } from "bun:test";
import { smoke, setupViaApi, recoveryVerdict, sampleRecovery } from "./bench-probe";

for (const phase of ["headers", "body"]) {
  test(`smoke deadline bounds stalled ${phase}`, async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        if (phase === "headers") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } }));
      },
    });
    try {
      await expect(smoke(server.url.toString().replace(/\/$/, ""), "key", [["/v1/messages", "{}"]], 50)).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  }, 2000);
}

test("authenticated setup propagates cookie through credentials models and keys", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/setup") return Response.json({}, { headers: { "set-cookie": "session=ok; HttpOnly" } });
    if (req.headers.get("cookie") !== "session=ok") return new Response("unauthorized", { status: 401 });
    seen.push(path);
    return Response.json({ key: ((await req.json()) as { label?: string }).label });
  } });
  try {
    expect(await setupViaApi(server.url.toString().replace(/\/$/, ""), "pw", {}, { m: {} }, {})).toEqual({ plain: "bench plain", limited: "bench limited" });
    expect(seen).toEqual(["/api/credentials", "/api/models/m", "/api/keys", "/api/keys"]);
  } finally { await server.stop(true); }
});

test("recovery classification uses ten-second observation, requires data", () => {
  const s = (rssMb: number | null, deadlineMs = 10000) => ({ rssMb, deadlineMs, elapsedMs: deadlineMs + 1 });
  expect(recoveryVerdict(10, [s(40, 5000), s(29)], 0)).toBe("pass");
  expect(recoveryVerdict(10, [s(31)], 0)).toBe("miss");
  for (const samples of [[], [s(null)], [s(10, 5000)]]) expect(recoveryVerdict(10, samples, 0)).toBe("inconclusive");
  expect(recoveryVerdict(null, [s(10)], 0)).toBe("inconclusive");
  expect(recoveryVerdict(10, [s(10)], 1)).toBe("miss");
});

test("sampling caller records delayed observations and refuses a sixty-second recovery", async () => {
  let clock = 0;
  let calls = 0;
  const samples = await sampleRecovery(0, () => clock, async ms => { clock += ms; }, () => {
    calls++;
    clock = calls === 1 ? 5001 : 60000;
    return calls === 1 ? 40 : 10;
  });
  expect(samples).toEqual([{ deadlineMs: 5000, elapsedMs: 5001, rssMb: 40 }, { deadlineMs: 10000, elapsedMs: 60000, rssMb: 10 }]);
  expect(recoveryVerdict(10, samples, 0)).toBe("inconclusive");
  expect(recoveryVerdict(10, samples, 1)).toBe("miss");
  samples[1]!.elapsedMs = 10025;
  expect(recoveryVerdict(10, samples, 0)).toBe("pass");
  samples[1]!.elapsedMs = 10026;
  expect(recoveryVerdict(10, samples, 0)).toBe("inconclusive");
});
