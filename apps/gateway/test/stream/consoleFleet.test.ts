import { expect, test } from "bun:test";
import type { ConsoleRead } from "@omni/control";
import { memoryCoord } from "@omni/coord";
import { createConsoleFleet } from "../../src/stream/consoleFleet.ts";

const read = (tag: string): ConsoleRead => ({
  source: "file",
  path: `/var/log/${tag}`,
  lines: [{ raw: tag, at: 1, level: "info", msg: tag }],
});

test("reads its own console locally and another's over the coordinator", async () => {
  const coord = memoryCoord();
  const a = createConsoleFleet({ coord, nodeId: "a", local: async () => read("a") });
  const b = createConsoleFleet({ coord, nodeId: "b", local: async () => read("b") });

  expect((await a.read("a", { lines: 10 })).path).toBe("/var/log/a");
  expect((await a.read("b", { lines: 10 })).path).toBe("/var/log/b");
  expect((await b.read("a", { lines: 10 })).lines[0]?.msg).toBe("a");
  a.stop();
  b.stop();
});

test("a process that captures nothing answers none, and one that is gone times out", async () => {
  const coord = memoryCoord();
  const a = createConsoleFleet({ coord, nodeId: "a", local: async () => read("a"), timeoutMs: 20 });
  const quiet = createConsoleFleet({ coord, nodeId: "quiet", local: undefined });

  expect((await a.read("quiet", { lines: 10 })).source).toBe("none");
  await expect(a.read("gone", { lines: 10 })).rejects.toThrow("did not answer");
  a.stop();
  quiet.stop();
});
