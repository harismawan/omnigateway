#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Compile directly to disk: executable artifacts must never be rewritten as text. */
export async function buildBinary(
  entrypoints: string[],
  outfile: string,
  root: string,
): Promise<void> {
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    root,
    entrypoints: entrypoints.map((entry) => resolve(root, entry)),
    target: "bun",
    format: "esm",
    bytecode: true,
    minify: true,
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`could not compile ${entrypoints.join(", ")}`);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const outfile = resolve(root, process.argv[2] ?? "dist/omnigateway");
  await buildBinary(["apps/gateway/src/index.ts"], outfile, root);
  console.log(`built gateway binary in ${outfile}`);
}
