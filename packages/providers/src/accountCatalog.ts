/** Public, normalized account snapshot. Never put vendor credentials or URLs here. */
export type PublicModelCatalog = {
  version: 1;
  models: {
    id: string;
    name: string;
    pricing: null;
    limits: { contextWindow?: number; maxOutputTokens?: number };
  }[];
};

export function parsePublicModelCatalog(value: unknown): PublicModelCatalog | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.models)) return null;
  const models: PublicModelCatalog["models"] = [];
  const seen = new Set<string>();
  const valid = (v: unknown): v is string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: bound printable public metadata
    typeof v === "string" && /^[^\x00-\x1f\x7f]{1,200}$/.test(v);
  for (const raw of root.models.slice(0, 500)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!valid(r.id) || !valid(r.name) || seen.has(r.id)) continue;
    seen.add(r.id);
    const limits: PublicModelCatalog["models"][number]["limits"] = {};
    const source =
      typeof r.limits === "object" && r.limits !== null
        ? (r.limits as Record<string, unknown>)
        : {};
    for (const key of ["contextWindow", "maxOutputTokens"] as const) {
      const n = source[key];
      if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) limits[key] = n;
    }
    models.push({ id: r.id, name: r.name, pricing: null, limits });
  }
  return { version: 1, models };
}
