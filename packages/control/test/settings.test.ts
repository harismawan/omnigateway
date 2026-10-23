import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, DEFAULT_SMART_ROUTER_POLICY } from "@omni/store";
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

test("the guardrail settings save, clear, and survive a save that omits them", async () => {
  const store = await memoryStore();
  const saved = await putSettings(store, {
    ...DEFAULT_SETTINGS,
    guardrailModel: "anthropic/claude-haiku-4",
    guardrailTimeoutMs: 5_000,
  });
  expect(saved.guardrailModel).toBe("anthropic/claude-haiku-4");
  expect(saved.guardrailTimeoutMs).toBe(5_000);

  // A save from a client that never heard of the fields keeps them.
  const { guardrailModel: _model, guardrailTimeoutMs: _timeout, ...old } = DEFAULT_SETTINGS;
  const kept = await putSettings(store, old);
  expect(kept.guardrailModel).toBe("anthropic/claude-haiku-4");
  expect(kept.guardrailTimeoutMs).toBe(5_000);

  // `null` is how the classifier is unset, distinct from omitting the field.
  expect((await putSettings(store, { ...old, guardrailModel: null })).guardrailModel).toBeNull();
  store.close();
});

test("the guardrail settings refuse an empty model and an out-of-range timeout", () => {
  for (const guardrailModel of ["", "   ", 7]) {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailModel })).toThrow();
  }
  for (const guardrailTimeoutMs of [0, -1, 1.5, 60_001, "10000"]) {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailTimeoutMs })).toThrow();
  }
  expect(settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailTimeoutMs: 60_000 })).toMatchObject({
    guardrailTimeoutMs: 60_000,
  });
  expect(settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailModel: " fast " })).toMatchObject({
    guardrailModel: "fast",
  });
});

test("the history window is an integer in 1..10, and a save that omits it keeps it", async () => {
  for (const guardrailHistoryTurns of [0, -1, 11, 1.5, "3", null]) {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailHistoryTurns })).toThrow();
  }
  for (const guardrailHistoryTurns of [1, 10]) {
    expect(settingsSchema.parse({ ...DEFAULT_SETTINGS, guardrailHistoryTurns })).toMatchObject({
      guardrailHistoryTurns,
    });
  }

  const store = await memoryStore();
  expect(
    (await putSettings(store, { ...DEFAULT_SETTINGS, guardrailHistoryTurns: 7 }))
      .guardrailHistoryTurns,
  ).toBe(7);
  const { guardrailHistoryTurns: _turns, ...old } = DEFAULT_SETTINGS;
  expect((await putSettings(store, old)).guardrailHistoryTurns).toBe(7);
  store.close();
});

test("the smart router settings save, clear, and survive a save that omits them", async () => {
  const store = await memoryStore();
  const saved = await putSettings(store, {
    ...DEFAULT_SETTINGS,
    smartRouterEnabled: true,
    smartRouterClassifierModel: "local-judge",
    smartRouterLocalModel: "local-chat",
    smartRouterPolicy: "Anything about Project Falcon.",
    smartRouterTimeoutMs: 5_000,
  });
  expect(saved.smartRouterEnabled).toBe(true);
  expect(saved.smartRouterClassifierModel).toBe("local-judge");
  expect(saved.smartRouterLocalModel).toBe("local-chat");
  expect(saved.smartRouterPolicy).toBe("Anything about Project Falcon.");
  expect(saved.smartRouterTimeoutMs).toBe(5_000);

  // A save from a client that never heard of the five keeps every one — a
  // reset to the defaults here would quietly switch routing off.
  const {
    smartRouterEnabled: _enabled,
    smartRouterClassifierModel: _classifier,
    smartRouterLocalModel: _local,
    smartRouterPolicy: _policy,
    smartRouterTimeoutMs: _timeout,
    ...old
  } = DEFAULT_SETTINGS;
  const kept = await putSettings(store, { ...old, maxAttempts: 4 });
  expect(kept.maxAttempts).toBe(4);
  expect(kept.smartRouterEnabled).toBe(true);
  expect(kept.smartRouterClassifierModel).toBe("local-judge");
  expect(kept.smartRouterLocalModel).toBe("local-chat");
  expect(kept.smartRouterPolicy).toBe("Anything about Project Falcon.");
  expect(kept.smartRouterTimeoutMs).toBe(5_000);

  // `null` is how a model is unset, distinct from omitting the field; a
  // present `false` switches the feature off.
  const cleared = await putSettings(store, {
    ...old,
    smartRouterEnabled: false,
    smartRouterClassifierModel: null,
    smartRouterLocalModel: null,
  });
  expect(cleared.smartRouterEnabled).toBe(false);
  expect(cleared.smartRouterClassifierModel).toBeNull();
  expect(cleared.smartRouterLocalModel).toBeNull();
  expect(cleared.smartRouterPolicy).toBe("Anything about Project Falcon.");
  store.close();
});

test("a stored default policy reads back as the gateway's own text", async () => {
  const store = await memoryStore();
  expect((await store.config.getSettings()).smartRouterPolicy).toBe(DEFAULT_SMART_ROUTER_POLICY);
  store.close();
});
