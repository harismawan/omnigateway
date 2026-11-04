import type { PublicModelCatalog } from "../accountCatalog.ts";

export type QoderModel = {
  key: string;
  displayName: string;
  images: boolean;
  reasoning: boolean;
  maxInputTokens?: number;
};

function text(value: unknown): value is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in public model metadata
  return typeof value === "string" && /^[^\x00-\x1f\x7f]{1,200}$/.test(value);
}

export function parseModelCatalog(value: unknown): QoderModel[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { assistant?: unknown }).assistant)
  ) {
    throw new Error("Invalid Qoder model catalog");
  }
  const rows = (value as { assistant: unknown[] }).assistant;
  const models: QoderModel[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 2000)) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if ([false, 0, "0"].includes(r.enable as false | 0 | "0")) continue;
    if (!text(r.key) || !text(r.display_name) || seen.has(r.key)) continue;
    seen.add(r.key);
    models.push({
      key: r.key,
      displayName: r.display_name,
      images: r.is_vl === true,
      reasoning: r.is_reasoning === true,
      ...(Number.isSafeInteger(r.max_input_tokens) && (r.max_input_tokens as number) > 0
        ? { maxInputTokens: r.max_input_tokens as number }
        : {}),
    });
    if (models.length === 500) break;
  }
  return models;
}

export function publicModelCatalog(models: readonly QoderModel[]): PublicModelCatalog {
  return {
    version: 1,
    models: models.map((m) => ({
      id: m.key,
      name: m.displayName,
      pricing: null,
      limits: m.maxInputTokens === undefined ? {} : { contextWindow: m.maxInputTokens },
    })),
  };
}
