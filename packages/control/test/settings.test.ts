import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import { settingsSchema } from "../src/schemas.ts";
import { putSettings } from "../src/settings.ts";

/**
 * Snapshot retention is written by its own operation, not by the settings form.
 *
 * Body retention may also be omitted by older clients. Snapshot fields have
 * their own editing surface, the database panel, and a settings save from a
 * client that has never heard of retention must leave the policy alone rather
 * than quietly returning it to the default.
 */
test("a settings save that does not mention retention leaves the stored policy alone", async () => {
  const store = await memoryStore();
  await store.config.putSettings({ snapshotKeepLatest: 3, snapshotMaxAgeDays: 7 });

  const { snapshotKeepLatest: _keep, snapshotMaxAgeDays: _age, ...rest } = DEFAULT_SETTINGS;
  const saved = await putSettings(store, { ...rest, maxAttempts: 5 });

  expect(saved.maxAttempts).toBe(5);
  expect(saved.snapshotKeepLatest).toBe(3);
  expect(saved.snapshotMaxAgeDays).toBe(7);
  expect((await store.config.getSettings()).snapshotKeepLatest).toBe(3);
  store.close();
});

test("the schema accepts a settings object with no retention fields at all", () => {
  const { snapshotKeepLatest: _keep, snapshotMaxAgeDays: _age, ...rest } = DEFAULT_SETTINGS;
  expect(() => settingsSchema.parse(rest)).not.toThrow();
});

/** Older clients must not reset an independently saved body window. */
test("old settings saves preserve body retention and default to one day", async () => {
  expect(DEFAULT_SETTINGS.bodyRetentionDays).toBe(1);
  expect(DEFAULT_SETTINGS.logRetentionDays).toBe(30);
  const { bodyRetentionDays: _body, ...old } = DEFAULT_SETTINGS;
  const store = await memoryStore();
  expect((await putSettings(store, old)).bodyRetentionDays).toBe(1);
  await store.config.putSettings({ bodyRetentionDays: 7 });
  expect((await putSettings(store, old)).bodyRetentionDays).toBe(7);
  store.close();
});

test("body retention accepts positive whole days up to the existing retention ceiling", () => {
  for (const value of [1, 7, 3_650]) {
    expect(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, bodyRetentionDays: value }).bodyRetentionDays,
    ).toBe(value);
  }
  for (const value of [0, -1, 1.5, 3_651, "1", null]) {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, bodyRetentionDays: value })).toThrow();
  }
});

test("a retention field that is present is still validated", () => {
  expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, snapshotKeepLatest: 0 })).toThrow();
});
