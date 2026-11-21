import { PROVIDER_DESCRIPTORS } from "../../../packages/providers/src/descriptors.ts";
import { resolveModel } from "../../../packages/router/src/resolve.ts";

const rows = [];
for (const model of [
  ...PROVIDER_DESCRIPTORS.antigravity.catalog.models.map((m) => m.id),
  "gemini-unlisted",
]) {
  for (const name of [model, `antigravity/${model}`, `antigravity:${model}`]) {
    const snapshot = { models: new Map() } as Parameters<typeof resolveModel>[1];
    rows.push({ name, expected: resolveModel(name, snapshot) });
  }
}
console.log(JSON.stringify(rows));
