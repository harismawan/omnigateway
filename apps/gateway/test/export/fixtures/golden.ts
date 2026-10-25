import { expect } from "bun:test";
import { resolve } from "node:path";

/**
 * Compares `actual` with the golden file `name` byte for byte. JSON goldens are
 * stored pretty-printed for review and compared after re-serialising, which
 * keeps key order — so a reordered field fails exactly as a changed one does.
 * `UPDATE_GOLDEN=1` rewrites the file instead; read the diff before committing.
 */
export async function golden(name: string, actual: string): Promise<void> {
  const path = resolve(import.meta.dir, name);
  const json = name.endsWith(".json");
  if (Bun.env.UPDATE_GOLDEN === "1") {
    await Bun.write(path, json ? `${JSON.stringify(JSON.parse(actual), null, 2)}\n` : actual);
  }
  const stored = await Bun.file(path).text();
  expect(actual).toBe(json ? JSON.stringify(JSON.parse(stored)) : stored);
}
