#!/usr/bin/env bun
/**
 * Checks that a regenerated `vectors.json` only *added* sections.
 *
 *   bun conformance/vectors/check-additive.ts <old.json> <new.json>
 *
 * Every top-level section present in the old file must serialize identically
 * in the new one, with one exception: `encryption.vectors[*].ciphertext`, which
 * is random (fresh IVs) on every export. Exits non-zero on any other change.
 */
const [oldPath, newPath] = process.argv.slice(2);
if (oldPath === undefined || newPath === undefined) {
  console.error("usage: check-additive.ts <old.json> <new.json>");
  process.exit(2);
}
const before = JSON.parse(await Bun.file(oldPath).text()) as Record<string, unknown>;
const after = JSON.parse(await Bun.file(newPath).text()) as Record<string, unknown>;

const masked = (doc: Record<string, unknown>): Record<string, unknown> => {
  const copy = structuredClone(doc);
  const enc = copy.encryption as { vectors?: { ciphertext?: string }[] } | undefined;
  for (const v of enc?.vectors ?? []) v.ciphertext = "<random>";
  return copy;
};

const a = masked(before);
const b = masked(after);
let failed = false;
const oldKeys = Object.keys(a);
const newKeys = Object.keys(b);
for (const key of oldKeys) {
  if (!(key in b)) {
    console.error(`removed: ${key}`);
    failed = true;
  } else if (JSON.stringify(a[key], null, 2) !== JSON.stringify(b[key], null, 2)) {
    console.error(`changed: ${key}`);
    failed = true;
  }
}
if (JSON.stringify(newKeys.slice(0, oldKeys.length)) !== JSON.stringify(oldKeys)) {
  console.error("existing sections moved");
  failed = true;
}
const added = newKeys.filter((k) => !(k in a));
console.log(`unchanged: ${oldKeys.length} sections; added: ${added.join(", ") || "none"}`);
process.exit(failed ? 1 : 0);
