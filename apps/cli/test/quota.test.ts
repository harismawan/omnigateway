import { expect, test } from "bun:test";
import type { BurnEstimate } from "@omni/control";
import type { QuotaSample, QuotaWindow } from "@omni/store";
import { seedCredential } from "@omni/testkit";
import { cli, fakeService, makeRoot, openStore } from "./helpers/harness.ts";

/** Every test runs against one fixed instant, so every estimate is arithmetic. */
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function installation(): Promise<string> {
  const root = makeRoot();
  const migrated = await cli(["db", "migrate"], { root });
  expect(migrated.code).toBe(0);
  return root;
}

/** An account with a label a table can be searched for. */
async function account(root: string, id: string, label: string): Promise<void> {
  const store = await openStore(root);
  await seedCredential(store, { id, label, provider: "anthropic" });
  store.close();
}

async function saveQuota(root: string, rows: QuotaWindow[]): Promise<void> {
  const store = await openStore(root);
  await store.credentials.saveQuota(rows);
  store.close();
}

/**
 * Two hours into a five-hour window at 62 of 100.
 *
 * 31 units an hour against 38 left is a little over an hour, and the window
 * runs for three more: this one does not last.
 */
function draining(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    startsAt: NOW - 2 * HOUR,
    used: 62,
    limit: 100,
    resetsAt: NOW + 3 * HOUR,
    observedAt: NOW,
    windowMs: null,
    ...overrides,
  };
}

/** Two days into a weekly window at 18 of 100, which outlives its own reset. */
function roomy(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "cred-1",
    windowType: "weekly",
    startsAt: NOW - 2 * DAY,
    used: 18,
    limit: 100,
    resetsAt: NOW + 5 * DAY,
    observedAt: NOW,
    windowMs: null,
    ...overrides,
  };
}

test("status says how long a window that will not survive has left", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [draining()]);

  const result = await cli(["status"], {
    root,
    service: fakeService({ root }),
    now: () => NOW,
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain("5h 62% ~1h13m");
});

test("status says a window that lasts will last, without an arithmetic prompt", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [roomy()]);

  const result = await cli(["status"], {
    root,
    service: fakeService({ root }),
    now: () => NOW,
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain("7d 18% ok");
  expect(result.out).not.toContain("~");
});

test("status prints no estimate from a reading nobody believes", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  // Twenty minutes old against the default five-minute poll: stale, and the
  // percentage is still worth showing while the projection is not.
  await saveQuota(root, [draining({ observedAt: NOW - 20 * 60_000 })]);

  const result = await cli(["status"], {
    root,
    service: fakeService({ root }),
    now: () => NOW,
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain("5h 62%");
  expect(result.out).not.toMatch(/~\d/);
  expect(result.out).not.toMatch(/62% ok/);
  // The age note is the whole point of a stale row, and still prints.
  expect(result.out).toContain("(20m ago)");
});

test("status prints no estimate for a window that was never observed", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [draining({ observedAt: 0 })]);

  const result = await cli(["status"], {
    root,
    service: fakeService({ root }),
    now: () => NOW,
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain("5h 62%");
  expect(result.out).not.toMatch(/~\d/);
  expect(result.out).not.toMatch(/62% ok/);
});

test("quota lists each window's use, rate, estimate, and reset", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [draining(), roomy()]);

  const result = await cli(["quota"], { root, now: () => NOW });

  expect(result.code).toBe(0);
  expect(result.out).toContain("anthropic:work");
  // 62 of 100 in two hours is 31 units an hour, which is 31% of the limit.
  expect(result.out).toMatch(/5h\s+62\/100\s+31\.0%\/h\s+empty ~1h13m\s+3h00m/);
  expect(result.out).toMatch(/7d\s+18\/100\s+0\.4%\/h\s+ok\s+5d00h/);
});

test("quota names a stale reading rather than estimating from it", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [draining({ observedAt: NOW - 20 * 60_000 })]);

  const result = await cli(["quota"], { root, now: () => NOW });

  expect(result.code).toBe(0);
  // The fraction is still the last thing known; the rate and the ETA are not.
  expect(result.out).toMatch(/5h\s+62\/100\s+—\s+stale/);
  expect(result.out).not.toContain("~");
  expect(result.out).not.toContain("ok");
});

test("quota separates a window never observed from one that aged out", async () => {
  // Two different things to go and fix. Control folds both into `stale: true`,
  // but `observedAt` still tells them apart: nothing has ever been read here,
  // which is not the same as a reading that stopped being refreshed.
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [draining({ observedAt: 0 })]);

  const result = await cli(["quota"], { root, now: () => NOW });

  expect(result.code).toBe(0);
  expect(result.out).toMatch(/5h\s+62\/100\s+—\s+unknown/);
  expect(result.out).not.toContain("stale");
  expect(result.out).not.toContain("ok");
});

test("quota reads unknown for an account whose provider reports nothing", async () => {
  const root = await installation();
  await account(root, "cred-1", "silent");

  const result = await cli(["quota"], { root, now: () => NOW });

  expect(result.code).toBe(0);
  expect(result.out).toContain("anthropic:silent");
  expect(result.out).toContain("unknown");
  // Nothing reported is not "nothing used": neither a fraction nor a rate may
  // be invented for an account the gateway has no reading for.
  expect(result.out).not.toContain("ok");
  expect(result.out).not.toMatch(/\d+\/\d+/);
  expect(result.out).not.toMatch(/\d\.\d%\/h/);
});

test("quota renders a window with no limit or no reset as unavailable, not as zero", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  await saveQuota(root, [
    // Usage with no ceiling: a rate exists, a fraction and an ETA do not.
    draining({ used: 500, limit: null }),
    // A limit with no stated reset: no window start, so no rate at all.
    roomy({ resetsAt: null }),
  ]);

  const result = await cli(["quota"], { root, now: () => NOW });

  expect(result.code).toBe(0);
  expect(result.out).toMatch(/5h\s+500\/—\s+250\.0\/h\s+unknown/);
  expect(result.out).toMatch(/7d\s+18\/100\s+—\s+unknown\s+—/);
  expect(result.out).not.toContain("ok");
  expect(result.out).not.toContain("0.0%/h");
});

test("quota --json carries the retained samples beside the derived estimate", async () => {
  const root = await installation();
  await account(root, "cred-1", "work");
  // Two probes, five minutes apart: the second moved, so both are retained.
  await saveQuota(root, [draining({ used: 40, observedAt: NOW - 300_000 })]);
  await saveQuota(root, [draining()]);

  const result = await cli(["quota", "--json"], { root, now: () => NOW });
  const body = JSON.parse(result.out) as {
    credentials: Array<{ id: string; label: string; windows: QuotaWindow[] }>;
    burn: BurnEstimate[];
    samples: QuotaSample[];
  };

  expect(result.code).toBe(0);
  expect(body.credentials[0]?.label).toBe("work");
  expect(body.credentials[0]?.windows[0]?.used).toBe(62);
  expect(body.samples.map((sample) => sample.used).sort((a, b) => a - b)).toEqual([40, 62]);

  const burn = body.burn[0];
  expect(burn?.windowStartsAt).toBe(NOW - 2 * HOUR);
  expect(burn?.ratePerHour).toBe(31);
  expect(burn?.survives).toBe(false);
  expect(burn?.stale).toBe(false);
});
