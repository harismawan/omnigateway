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

// Every case section either file has: a section the old file had must keep
// all its cases, and a new section counts as purely added.
const isSection = (value: unknown): value is { id: string }[] =>
  Array.isArray(value) && value.every((c) => typeof (c as { id?: unknown }).id === "string");
const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
  (name) => isSection(before[name]) || isSection(after[name]),
);
const summary: string[] = [];
for (const name of names) {
  const oldCases = isSection(before[name]) ? before[name] : [];
  const newList = isSection(after[name]) ? after[name] : [];
  if (before[name] !== undefined && !isSection(after[name])) {
    console.error(`${name}: section removed`);
    failed = true;
  }
  const newCases = new Map(newList.map((c) => [c.id, c]));
  const oldIds = new Set(oldCases.map((c) => c.id));
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
  const added = newList.filter((c) => !oldIds.has(c.id)).length;
  summary.push(`${name} +${added}`);
}
console.log(
  failed
    ? `NOT ADDITIVE: existing cases were removed or changed (see above); added: ${summary.join(", ")}`
    : `additive: every existing case preserved; added: ${summary.join(", ")}`,
);
process.exit(failed ? 1 : 0);
