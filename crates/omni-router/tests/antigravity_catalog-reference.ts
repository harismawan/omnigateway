import { resolveModel } from '../../../packages/router/src/resolve.ts';
import { PROVIDER_DESCRIPTORS } from '../../../packages/providers/src/descriptors.ts';
const rows = [];
for (const model of [...PROVIDER_DESCRIPTORS.antigravity.catalog.models.map(m => m.id), 'gemini-unlisted']) {
  for (const name of [model, `antigravity/${model}`, `antigravity:${model}`]) {
    rows.push({name, expected: resolveModel(name, {models: new Map()} as any)});
  }
}
console.log(JSON.stringify(rows));
