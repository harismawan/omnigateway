import { expect, test } from "bun:test";
import { PROVIDER_MODEL_CATALOG, type ProviderId } from "../src/index.ts";

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "kimi"];

const EXPECTED = {
  anthropic: {
    defaultModel: "claude-opus-5",
    ids: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    defaultModel: "gpt-5.6",
    ids: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  kimi: {
    defaultModel: "k3-256k",
    ids: ["k3-256k", "k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
  },
} as const;

test("catalog covers every provider with ordered curated IDs", () => {
  expect(Object.keys(PROVIDER_MODEL_CATALOG).sort()).toEqual([...PROVIDERS].sort());

  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    expect(entry.defaultModel).toBe(EXPECTED[provider].defaultModel);
    expect(entry.models.map((model) => model.id)).toEqual([...EXPECTED[provider].ids]);
  }
});

test("catalog entries have non-empty unique values and exactly one default", () => {
  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    const ids = entry.models.map((model) => model.id);

    expect(entry.defaultModel.length).toBeGreaterThan(0);
    expect(entry.models.every((model) => model.id.length > 0 && model.label.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === entry.defaultModel)).toHaveLength(1);
  }
});

test("Kimi labels describe coding endpoint aliases", () => {
  expect(PROVIDER_MODEL_CATALOG.kimi.models).toEqual([
    { id: "k3-256k", label: "Kimi K3 — 256K" },
    { id: "k3", label: "Kimi K3 — up to 1M" },
    { id: "kimi-for-coding", label: "Kimi K2.7 Code" },
    { id: "kimi-for-coding-highspeed", label: "Kimi K2.7 Code — High Speed" },
  ]);
});
