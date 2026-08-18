import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import { settingsSchema } from "../src/schemas.ts";
import { putSettings } from "../src/settings.ts";

/**
 * Snapshot retention is written by its own operation, not by the settings form.
 *
 * Every other settings field is required, because a partial write would reset
 * whatever it omitted. These two are the exception in the other direction: the
 * surface that edits them is the database panel, and a settings save from a
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

test("a retention field that is present is still validated", () => {
  expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, snapshotKeepLatest: 0 })).toThrow();
});
