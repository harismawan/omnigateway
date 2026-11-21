// Frozen functions are the oracle; only deferred catalogs are emptied to match
// the Rust registry's currently supported data, per the migration ruling.
import { modelListBody } from "../apps/gateway/src/routes/models.ts";
import { PROVIDER_DESCRIPTORS } from "../packages/providers/src/descriptors.ts";

for (const [id, d] of Object.entries(PROVIDER_DESCRIPTORS))
  if (!["anthropic", "openai", "custom"].includes(id)) d.catalog = { ...d.catalog, models: [] };
const target = (provider: string, model: string, extra = {}) => ({
  provider,
  model,
  tier: 1,
  weight: 1,
  costPerMTok: { input: 0, output: 0 },
  capabilities: { tools: true, images: true, reasoning: true },
  ...extra,
});
const credential = (id: string, authType: string, extra = {}) => ({
  id,
  provider: "openai",
  authType,
  enabled: true,
  providerData: {},
  ...extra,
});
const key = credential("key", "apiKey"),
  oauth = credential("oauth", "oauth");
const sets = [
  [],
  [key],
  [oauth],
  [key, oauth],
  [{ ...oauth, enabled: false }],
  [key, { ...oauth, enabled: false }],
  [oauth, { ...key, enabled: false }],
  [credential("other", "oauth", { provider: "anthropic" })],
];
const rows: unknown[] = [];
function add(
  targets: Parameters<typeof modelListBody>[0][number]["targets"],
  credentials: Parameters<typeof modelListBody>[1],
  id = "别名-é-🦀",
) {
  const models = [{ id, targets, strategy: "priority", isAlias: false }];
  rows.push({ models, credentials, expected: JSON.stringify(modelListBody(models, credentials)) });
}
for (const provider of ["anthropic", "openai"])
  for (const model of PROVIDER_DESCRIPTORS[provider]!.catalog.models)
    for (const credentials of sets) add([target(provider, model.id)], credentials);
for (const credentials of sets) {
  for (const pin of [undefined, "key", "oauth", "missing", "other"])
    for (const figures of [
      {},
      { contextWindow: 2000000, maxOutputTokens: 200000 },
      { contextWindow: 100, maxOutputTokens: 10 },
      { contextWindow: 0, maxOutputTokens: 0 },
      { contextWindow: 1.5, maxOutputTokens: 0.25 },
      { contextWindow: 123 },
    ])
      add([target("openai", "gpt-6.1-sol", { credentialId: pin, ...figures })], credentials);
  add([target("anthropic", "claude-opus-5-5"), target("openai", "gpt-6.1-sol")], credentials);
  add([target("openai", "gpt-6.1-sol"), target("custom", "unlisted")], credentials);
  add([target("custom", "x", { contextWindow: 50 }), target("openai", "gpt-6.1-sol")], credentials);
  for (const provider of ["custom", "kimi", "kilo", "grok", "muse", "qoder", "antigravity"])
    add([target(provider, "unlisted-é")], credentials);
  add([], credentials);
  add(
    [target("custom", "x", { endpointId: "a", credentialId: "oauth" })],
    [credential("oauth", "oauth", { provider: "custom", providerData: { endpointId: "b" } })],
  );
}
rows.push({ models: [], credentials: [], expected: JSON.stringify(modelListBody([], [])) });
process.stdout.write(JSON.stringify(rows));
