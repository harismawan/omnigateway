#!/usr/bin/env bun
/**
 * Checks that a regenerated `rtk.json.gz` only *added* cases.
 *
 *   bun conformance/vectors/rtk-check-additive.ts <old.json.gz> <new.json.gz>
 *
 * Cases are keyed by their content-hash `id`. Every case in the old file must
 * be present in the new one with an identical expected value; a missing or
 * changed case is a behaviour change in the frozen build (or a generator edit
 * that dropped coverage) and exits non-zero. `frozenSources` must match too:
 * vectors from a different TS build are not regenerations.
 */
const [oldPath, newPath] = process.argv.slice(2);
if (oldPath === undefined || newPath === undefined) {
  console.error("usage: rtk-check-additive.ts <old.json.gz> <new.json.gz>");
  process.exit(2);
}

type Doc = Record<string, unknown>;
const load = async (path: string): Promise<Doc> =>
  JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(path).arrayBuffer()))) as Doc;

const before = await load(oldPath);
const after = await load(newPath);
let failed = false;

if (JSON.stringify(before.frozenSources) !== JSON.stringify(after.frozenSources)) {
  console.error("frozenSources differ: the TS build changed");
  failed = true;
}

const SECTIONS = ["transform", "classify", "extract", "scan", "filters"];
const summary: string[] = [];
for (const name of SECTIONS) {
  const oldCases = (before[name] ?? []) as { id: string }[];
  const newCases = new Map(((after[name] ?? []) as { id: string }[]).map((c) => [c.id, c]));
  let changed = 0;
  let removed = 0;
  for (const c of oldCases) {
    const next = newCases.get(c.id);
    if (next === undefined) removed++;
    else if (JSON.stringify(next) !== JSON.stringify(c)) changed++;
  }
  if (removed > 0 || changed > 0) {
    console.error(`${name}: ${removed} removed, ${changed} changed`);
    failed = true;
  }
  summary.push(`${name} +${newCases.size - oldCases.length + removed}`);
}
console.log(`unchanged cases preserved; added: ${summary.join(", ")}`);
process.exit(failed ? 1 : 0);
