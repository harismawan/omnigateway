import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export async function checkManifest(directory: string) {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) throw Error(`missing completion manifest: ${path}`);
  const m = await Bun.file(path).json();
  const actual = readdirSync(directory)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort();
  if (
    JSON.stringify([...m.expected].sort()) !== JSON.stringify(actual) ||
    JSON.stringify([...m.present].sort()) !== JSON.stringify(actual)
  )
    throw Error(`incomplete rounds: ${directory}`);
}
if (import.meta.main) {
  const [dir, n] = process.argv.slice(2);
  if (!dir || !n) throw Error("directory rounds required");
  await Bun.write(
    join(dir, "manifest.json"),
    JSON.stringify({
      expected: Array.from({ length: Number(n) }, (_, i) => `${i + 1}.json`),
      present: readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)),
    }),
  );
}
