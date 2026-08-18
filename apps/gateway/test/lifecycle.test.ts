import { expect, test } from "bun:test";
import { captureLogger } from "@omni/testkit";
import { createDeferredStop, createShutdown, type ShutdownDeps } from "../src/lifecycle.ts";

function deps(overrides: Partial<ShutdownDeps> = {}) {
  const events: string[] = [];
  const logger = captureLogger();
  const base: ShutdownDeps = {
    logger,
    stopLoops: [
      () => events.push("maintenance"),
      () => events.push("refresh"),
      () => events.push("quota"),
    ],
    stopServer: async () => {
      events.push("server");
    },
    closeStore: () => events.push("store"),
    exit: (code) => events.push(`exit:${code}`),
    ...overrides,
  };
  return { events, logger, shutdown: createShutdown(base) };
}

test("a shutdown stops the loops, then the server, then closes the store, and exits clean", async () => {
  const { events, logger, shutdown } = deps();

  shutdown("SIGTERM");
  await Bun.sleep(5);

  expect(events).toEqual(["maintenance", "refresh", "quota", "server", "store", "exit:0"]);
  expect(logger.lines.some((line) => line.includes("shutdown requested"))).toBe(true);
  expect(logger.lines.some((line) => line.includes("reason=SIGTERM"))).toBe(true);
});

test("a second request while one is in progress force-exits", async () => {
  const { events, shutdown } = deps({
    stopServer: () =>
      new Promise<void>(() => {
        // A server that never finishes stopping is why a second signal exists.
      }),
  });

  shutdown("SIGINT");
  shutdown("SIGINT");
  await Bun.sleep(5);

  expect(events).toEqual(["maintenance", "refresh", "quota", "store", "exit:1"]);
});

test("a forced shutdown still closes the store before it goes", () => {
  const { events, shutdown } = deps();

  shutdown("SIGINT", "force");

  expect(events).toEqual(["store", "exit:1"]);
});

test("a server that fails to stop is reported and exits with a failure code", async () => {
  const { events, logger, shutdown } = deps({
    stopServer: async () => {
      throw new Error("socket wedged");
    },
  });

  shutdown("api");
  await Bun.sleep(5);

  expect(events).toEqual(["maintenance", "refresh", "quota", "store", "exit:1"]);
  expect(logger.lines.some((line) => line.includes("shutdown failed"))).toBe(true);
  expect(logger.lines.some((line) => line.includes("socket wedged"))).toBe(true);
});

/**
 * The failure that only appears once a shutdown is asked for over HTTP.
 *
 * Bun stops a server by letting its connections finish, and the connection
 * carrying the request that asked for the shutdown is one of them — so the
 * gateway answered `ok` and then sat there, listening to nothing, until a
 * second signal escalated. A signal never hit this because the shell that sent
 * it holds no socket.
 */
test("a server that will not finish stopping is left behind rather than waited on", async () => {
  const { events, logger, shutdown } = deps({
    stopServer: () => new Promise<void>(() => {}),
    stopDeadlineMs: 5,
  });

  shutdown("api");
  await Bun.sleep(25);

  expect(events).toEqual(["maintenance", "refresh", "quota", "store", "exit:0"]);
  expect(logger.lines.some((line) => line.includes("shutdown timed out"))).toBe(true);
});

test("the stop effect defers, so the response is flushed before the process goes", async () => {
  const calls: [string, string][] = [];
  const stop = createDeferredStop((reason, mode) => calls.push([reason, mode ?? "graceful"]), 5);

  stop(0);
  expect(calls).toEqual([]);

  await Bun.sleep(20);
  expect(calls).toEqual([["api", "graceful"]]);
});

test("a nonzero exit code from the stop effect is a forced shutdown", async () => {
  const calls: [string, string][] = [];
  const stop = createDeferredStop((reason, mode) => calls.push([reason, mode ?? "graceful"]), 5);

  stop(3);
  await Bun.sleep(20);

  expect(calls).toEqual([["api", "force"]]);
});
