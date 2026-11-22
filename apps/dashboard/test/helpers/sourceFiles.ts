import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `.ts`/`.tsx` under `dir`, recursively.
 *
 * Kept in the console's own test helpers, so the console's suite reaches
 * nothing outside `apps/dashboard`.
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
