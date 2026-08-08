import type { ProviderId } from "./request.ts";

export type ProviderModelChoice = {
  id: string;
  label: string;
};

export type ProviderModelCatalogEntry = {
  defaultModel: string;
  models: readonly ProviderModelChoice[];
};

export const PROVIDER_MODEL_CATALOG: Readonly<Record<ProviderId, ProviderModelCatalogEntry>> = {
  anthropic: {
    defaultModel: "claude-opus-5",
    models: [
      { id: "claude-fable-5", label: "claude-fable-5" },
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
  },
  openai: {
    defaultModel: "gpt-5.6",
    models: [
      { id: "gpt-5.6", label: "gpt-5.6" },
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    ],
  },
  kimi: {
    defaultModel: "k3-256k",
    models: [
      { id: "k3-256k", label: "Kimi K3 — 256K" },
      { id: "k3", label: "Kimi K3 — up to 1M" },
      { id: "kimi-for-coding", label: "Kimi K2.7 Code" },
      {
        id: "kimi-for-coding-highspeed",
        label: "Kimi K2.7 Code — High Speed",
      },
    ],
  },
};
