import { expect, test } from "bun:test";
import { parseCredential } from "../src/qoder/credential.ts";
import { parseModelCatalog, publicModelCatalog } from "../src/qoder/modelCatalog.ts";

test("Qoder catalog projects assistant models without vendor secrets or guessed prices", () => {
  const rows = parseModelCatalog({
    assistant: [
      {
        key: "synthetic",
        display_name: "Synthetic",
        is_vl: true,
        is_reasoning: false,
        max_input_tokens: 1234,
        api_key: "never-public",
        url: "https://evil.test",
        model: "internal",
      },
      { key: "disabled", display_name: "Disabled", enable: "0" },
      { key: "disabled2", display_name: "Disabled", enable: false },
      { key: "bad\nname", display_name: "Bad" },
      { key: "minimal", display_name: "Minimal", max_input_tokens: -1 },
    ],
    quest: [{ key: "not-assistant", display_name: "Other scene" }],
  });
  expect(rows).toEqual([
    {
      key: "synthetic",
      displayName: "Synthetic",
      images: true,
      reasoning: false,
      maxInputTokens: 1234,
    },
    { key: "minimal", displayName: "Minimal", images: false, reasoning: false },
  ]);
  expect(publicModelCatalog(rows)).toEqual({
    version: 1,
    models: [
      { id: "synthetic", name: "Synthetic", pricing: null, limits: { contextWindow: 1234 } },
      { id: "minimal", name: "Minimal", pricing: null, limits: {} },
    ],
  });
});

test("Qoder catalog distinguishes valid empty responses from malformed roots and caps rows", () => {
  expect(parseModelCatalog({ assistant: [] })).toEqual([]);
  for (const bad of [null, [], {}, { assistant: {} }, { assistant: null }]) {
    expect(() => parseModelCatalog(bad)).toThrow();
  }
  const row = { key: "synthetic", display_name: "Synthetic" };
  expect(parseModelCatalog({ assistant: [row, row] })).toHaveLength(1);
  expect(
    parseModelCatalog({
      assistant: Array.from({ length: 600 }, (_, i) => ({ ...row, key: `synthetic-${i}` })),
    }),
  ).toHaveLength(500);
});

const bundle = {
  version: 1 as const,
  deviceToken: "dummy-token",
  uid: "user-1",
  machineId: "synthetic-device",
  encryptUserInfo: "encrypted-envelope",
  key: "wrapped-key",
  issuedAt: 1700000000000,
  origin: "https://api2.qoder.sh",
  models: [{ key: "synthetic", displayName: "Synthetic", images: false, reasoning: true }],
};

test("Qoder credential parsing rejects raw bearer tokens, hostile origins and malformed metadata", () => {
  expect(parseCredential(JSON.stringify(bundle))).toEqual(bundle);
  for (const bad of [
    "raw-token",
    "null",
    JSON.stringify({ ...bundle, version: 2 }),
    JSON.stringify({ ...bundle, origin: "https://evil.test" }),
    JSON.stringify({ ...bundle, deviceToken: "" }),
    JSON.stringify({ ...bundle, models: [{}] }),
    JSON.stringify({ ...bundle, issuedAt: null }),
  ]) {
    expect(() => parseCredential(bad)).toThrow("Invalid Qoder credential");
  }
});
