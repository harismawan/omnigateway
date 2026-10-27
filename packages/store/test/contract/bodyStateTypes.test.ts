import { expect, test } from "bun:test";
import type { RequestLog, RequestLogWrite, UsageRepo } from "../../src/types.ts";
import { logRow } from "./harness.ts";

/**
 * `usage.begin` / `usage.append` take a log that may ask for `pending` and
 * nothing later: `ready`, `omitted` and `failed` are the store's to write
 * (`BodyRepo.publish` / `fail`, `sweepPending`). Refused when this file is type
 * checked — `bun run typecheck` covers `packages/*` tests — rather than
 * discarded at run time; the runtime filter is pinned in `bodyState.test.ts`.
 * The body only builds the calls, so nothing here touches a store.
 */
test("usage writes refuse a terminal body state at compile time", () => {
  const writes = (usage: UsageRepo, read: RequestLog): void => {
    const base = logRow({ id: "r" });
    void usage.begin({ ...base, bodyState: "pending" });
    void usage.append({ ...base, bodyState: null });
    void usage.append(base);
    // @ts-expect-error — `ready` is written by `publish`, never by a log write.
    void usage.begin({ ...base, bodyState: "ready" });
    // @ts-expect-error — `omitted` likewise.
    void usage.append({ ...base, bodyState: "omitted" });
    // @ts-expect-error — `failed` is written by `fail` and `sweepPending`.
    void usage.append({ ...base, bodyState: "failed" });
    // @ts-expect-error — a row read back must say what its body state is to be.
    void usage.append(read);
    void usage.append({ ...read, bodyState: null });
  };
  // A write-log is still a log: everything that reads one takes it as it is.
  const asRead: RequestLog = logRow({ id: "r" }) satisfies RequestLogWrite;
  expect(typeof writes).toBe("function");
  expect(asRead.bodyState).toBeNull();
});
