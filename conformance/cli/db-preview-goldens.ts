import { previewTable } from "../../apps/cli/src/commands/db.ts";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const previews = [
  { snapshot: { zebra: 1, apple: 200 }, live: { apple: 3, zebra: 40 } },
  { snapshot: { only_snapshot: 0, shared: 1 }, live: { shared: 2 } },
  { snapshot: { shared: 1 }, live: { only_live: 0, shared: 2 } },
  { snapshot: { apple: 12 }, live: null },
  { snapshot: {}, live: {} },
  { snapshot: { "é😀long_table": 123456789, a: 0, "😀": 1, "\uE000": 2 }, live: { a: 123456, "é😀long_table": 7 } },
];
export const goldens = previews.map(preview => ({ preview, output: previewTable(preview) }));
export function checkPreviewGoldens() {
  assert.deepEqual(JSON.parse(readFileSync(new URL("./db-preview-goldens.json", import.meta.url), "utf8")), goldens);
}
if (import.meta.main) console.log(JSON.stringify(goldens, null, 2));
