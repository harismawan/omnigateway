import { afterEach, expect, test } from "bun:test";
import { estimateInputTokens, GatewayError } from "@omni/ir";
import { PONYTAIL_MARKER } from "@omni/ponytail";
import { builtinPrompts, injectPrompts } from "@omni/prompts";
import { MAX_PROMPT_TEXT_CHARS } from "@omni/prompts/catalog";
import { PromptStoreError, type Store } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import { createKey, setKeyPrompts } from "../src/keys.ts";
import {
  activatePromptVersion,
  createPrompt,
  duplicatePrompt,
  listPrompts,
  readPrompt,
  removePrompt,
  savePromptVersion,
  updatePrompt,
} from "../src/prompts.ts";
import {
  keyPromptsSchema,
  promptActivateSchema,
  promptCreateSchema,
  promptDuplicateSchema,
  promptIdsSchema,
  promptMetadataSchema,
  promptSaveSchema,
} from "../src/schemas.ts";
import { putSettings } from "../src/settings.ts";

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});
async function fresh() {
  const store = await memoryStore();
  opened.push(store);
  return store;
}
const input = { id: "team", name: "Team", text: "  Team rules\n\t " };

test("strict schemas reject bad identifiers, lists, booleans, limits and unknown fields", () => {
  for (const ids of [
    ["ponytail-unknown"],
    ["UPPER"],
    ["a", "a"],
    ["ponytail-full", "ponytail-lite"],
    ["a", "b", "c", "d", "e", "f"],
    "team",
    null,
  ])
    expect(promptIdsSchema.safeParse(ids).success).toBe(false);
  expect(promptIdsSchema.parse(["team", "ponytail-full"])).toEqual(["team", "ponytail-full"]);
  for (const body of [
    { ids: [] },
    { inheritGlobal: true },
    { ids: [], inheritGlobal: 1 },
    { ids: [], inheritGlobal: true, extra: true },
  ])
    expect(keyPromptsSchema.safeParse(body).success).toBe(false);
  for (const id of ["ponytail-full", "ponytail-other", "", "a".repeat(41), "Bad_slug"])
    expect(promptCreateSchema.safeParse({ ...input, id }).success).toBe(false);
  for (const schema of [
    promptCreateSchema,
    promptSaveSchema,
    promptMetadataSchema,
    promptDuplicateSchema,
    promptActivateSchema,
  ])
    expect(schema.safeParse({ ...input, version: 1, extra: true }).success).toBe(false);
  for (const body of [
    { version: 0 },
    { version: 1.5 },
    { version: "1" },
    { version: 1, extra: true },
  ])
    expect(promptActivateSchema.safeParse(body).success).toBe(false);
  for (const body of [
    { ...input, name: "" },
    { ...input, name: "x".repeat(81) },
    { ...input, description: "x".repeat(501) },
    { ...input, note: "x".repeat(201) },
    { ...input, activate: "true" },
  ])
    expect(promptCreateSchema.safeParse(body).success).toBe(false);
  for (const text of ["", " \n\t", "x".repeat(MAX_PROMPT_TEXT_CHARS + 1)])
    expect(promptSaveSchema.safeParse({ text }).success).toBe(false);
  expect(promptSaveSchema.parse({ text: `  ${"x".repeat(MAX_PROMPT_TEXT_CHARS - 2)} \n` })).toEqual(
    { text: `  ${"x".repeat(MAX_PROMPT_TEXT_CHARS - 2)}`, note: null, activate: true },
  );
});

test("create, metadata replacement, draft/save/rollback and newest-first projections", async () => {
  const store = await fresh();
  const created = await createPrompt(store, { ...input, description: "original" });
  expect(created).toMatchObject({
    id: "team",
    builtin: false,
    activeVersion: 1,
    assignments: { global: false, keyIds: [] },
    versions: [{ version: 1, text: "  Team rules", note: null }],
  });
  expect(created.estimatedTokens).toBe(
    estimateInputTokens({
      model: "",
      stream: false,
      messages: [],
      system: [{ type: "text", text: "  Team rules" }],
    }),
  );
  expect(await updatePrompt(store, "team", { name: "Renamed" })).toMatchObject({
    name: "Renamed",
    description: null,
  });
  const draft = await savePromptVersion(store, "team", {
    text: "draft ",
    note: "draft note",
    activate: false,
  });
  expect(draft).toMatchObject({ promptId: "team", version: 2, text: "draft", note: "draft note" });
  expect((await readPrompt(store, "team")).activeVersion).toBe(1);
  expect(await activatePromptVersion(store, "team", { version: 2 })).toMatchObject({
    activeVersion: 2,
  });
  await savePromptVersion(store, "team", { text: "latest" });
  expect((await readPrompt(store, "team")).versions.map((v) => v.version)).toEqual([3, 2, 1]);
  expect(await activatePromptVersion(store, "team", { version: 1 })).toMatchObject({
    activeVersion: 1,
  });
  await removePrompt(store, "team");
  await expect(readPrompt(store, "team")).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("builtins are fixed readonly library entries; draft estimate uses latest text", async () => {
  const store = await fresh();
  const list = await listPrompts(store);
  expect(list.map((p) => p.name)).toEqual(["Ponytail Lite", "Ponytail Full", "Ponytail Ultra"]);
  for (const builtin of builtinPrompts()) {
    const view = await readPrompt(store, builtin.id);
    expect(view).toMatchObject({
      builtin: true,
      activeVersion: "v4.9.0",
      versions: [{ version: "v4.9.0", text: builtin.text, note: null, createdAt: null }],
    });
    expect(view.description).toContain("v4.9.0");
    for (const operation of [
      () => updatePrompt(store, builtin.id, { name: "oops" }),
      () => savePromptVersion(store, builtin.id, { text: "oops" }),
      () => activatePromptVersion(store, builtin.id, { version: 1 }),
      () => removePrompt(store, builtin.id),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  const draft = await createPrompt(store, { ...input, activate: false });
  expect(draft.activeVersion).toBeNull();
  expect(draft.estimatedTokens).toBeGreaterThan(0);
  expect((await listPrompts(store)).at(-1)).not.toHaveProperty("versions");
  expect(await store.prompts.list()).toHaveLength(1);
});

test("duplicate copies active text, latest never-active draft and builtin without marker semantics", async () => {
  const store = await fresh();
  await createPrompt(store, input);
  await savePromptVersion(store, "team", { text: "newer draft", activate: false });
  expect(
    (await duplicatePrompt(store, "team", { id: "copy", name: "Copy" })).versions[0]?.text,
  ).toBe("  Team rules");
  await createPrompt(store, { ...input, id: "draft", activate: false });
  await savePromptVersion(store, "draft", { text: "latest draft", activate: false });
  const copy = await duplicatePrompt(store, "draft", { id: "draft-copy", name: "Copy" });
  expect(copy).toMatchObject({ activeVersion: 1, versions: [{ text: "latest draft" }] });
  const builtinCopy = await duplicatePrompt(store, "ponytail-full", {
    id: "builtin-copy",
    name: "Copy",
  });
  const resolved = (await store.prompts.listActive()).find((p) => p.id === builtinCopy.id);
  expect(resolved).toBeDefined();
  expect(resolved).not.toHaveProperty("marker");
  if (!resolved) throw new Error("missing copy");
  expect(
    injectPrompts(
      { model: "", stream: false, messages: [], system: [{ type: "text", text: PONYTAIL_MARKER }] },
      [{ id: resolved.id, version: resolved.version, text: resolved.text }],
    ).report.applied,
  ).toEqual([{ id: "builtin-copy", version: 1 }]);
});

test("explicit assignments include revoked and expired keys, not effective inheritance", async () => {
  const store = await fresh();
  await createPrompt(store, { ...input, activate: false });
  const a = await createKey(store, {
    prompts: { ids: ["team"], inheritGlobal: false },
    expiresAt: 1,
  });
  const b = await createKey(store, {});
  await store.keys.revoke(a.id);
  await setKeyPrompts(store, b.id, { ids: ["team"], inheritGlobal: true });
  await store.config.putSettings({ prompts: ["team"] });
  expect((await readPrompt(store, "team")).assignments).toEqual({
    global: true,
    keyIds: [a.id, b.id].sort(),
  });
  await expect(removePrompt(store, "team")).rejects.toMatchObject({ code: "CONFLICT" });
  await setKeyPrompts(store, b.id, { ids: [], inheritGlobal: true });
  expect((await readPrompt(store, "team")).assignments.keyIds).toEqual([a.id]);
  await expect(
    setKeyPrompts(store, b.id, { ids: ["missing"], inheritGlobal: true }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    setKeyPrompts(store, "missing-key", { ids: [], inheritGlobal: true }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("store failures translate to safe codes without exposing repository messages", async () => {
  const store = await fresh();
  await createPrompt(store, input);
  await expect(createPrompt(store, input)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(activatePromptVersion(store, "team", { version: 999 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const secret = "private repository text";
  for (const kind of ["missing", "version-missing", "exists", "limit", "assigned"] as const) {
    const error = new PromptStoreError(kind, { global: true, keyIds: ["key1"] });
    error.message = secret;
    const failing = {
      ...store,
      prompts: {
        ...store.prompts,
        remove: async () => {
          throw error;
        },
      },
    };
    try {
      await removePrompt(failing, "team");
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      if (!(e instanceof GatewayError)) throw e;
      expect(e.code).toBe(
        kind === "missing" || kind === "version-missing" ? "BAD_REQUEST" : "CONFLICT",
      );
      expect(e.message).not.toContain(secret);
      if (kind === "assigned") {
        expect(e.message).toContain("global");
        expect(e.message).toContain("key1");
      }
    }
  }
  const failure = new PromptStoreError("missing");
  const failing = {
    ...store,
    config: {
      ...store.config,
      putSettings: async () => {
        throw failure;
      },
    },
    keys: {
      ...store.keys,
      create: async () => {
        throw failure;
      },
      setPrompts: async () => {
        throw failure;
      },
    },
  };
  await expect(putSettings(failing, await store.config.getSettings())).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(createKey(failing, {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const key = await createKey(store, {});
  await expect(
    setKeyPrompts(failing, key.id, { ids: [], inheritGlobal: true }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("library cap is a translated transactional refusal, deletion needs no control preflight", async () => {
  const store = await fresh();
  for (let i = 0; i < 50; i++) await createPrompt(store, { ...input, id: `p-${i}` });
  await expect(createPrompt(store, { ...input, id: "overflow" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const noPreflight = {
    ...store,
    prompts: {
      ...store.prompts,
      assignments: async () => {
        throw new Error("must not preflight deletion");
      },
      get: async () => {
        throw new Error("must not preflight deletion");
      },
    },
  };
  await removePrompt(noPreflight, "p-0");
  expect(await store.prompts.get("p-0")).toBeNull();
});

test("legacy mode cannot silently exceed or truncate a full user assignment list", async () => {
  const store = await fresh();
  const ids = ["a", "b", "c", "d", "e"];
  for (const id of ids) await createPrompt(store, { ...input, id });
  const saved = await store.config.putSettings({ prompts: ids });
  await expect(putSettings(store, { ...saved, ponytailMode: "full" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await store.config.getSettings()).toEqual(saved);
});
