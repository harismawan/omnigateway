import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { providerCatalog } from "../src/catalog.ts";

test("account catalogs merge deterministically without mutating static defaults or inventing limits", () => {
  const row = (id: string, limits: Record<string, number>) => ({
    id,
    name: id,
    pricing: null,
    limits,
  });
  const account = (models: unknown[]) => ({
    provider: "qoder",
    providerData: { modelCatalog: { version: 1, models } },
  });
  const before = JSON.stringify(PROVIDER_DESCRIPTORS);
  const catalog = providerCatalog(() => {}, PROVIDER_DESCRIPTORS, [
    account([row("z", { contextWindow: 100 }), row("a", { contextWindow: 200 })]),
    account([row("z", { contextWindow: 50 }), row("a", {})]),
  ]);
  expect(catalog.find((p) => p.id === "qoder")?.models).toEqual([
    { id: "a", label: "a", pricing: null, limits: {}, auth: ["oauth"] },
    { id: "z", label: "z", pricing: null, limits: { contextWindow: 50 }, auth: ["oauth"] },
  ]);
  expect(JSON.stringify(PROVIDER_DESCRIPTORS)).toBe(before);
});
