#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EXPORT_WORKER_ENTRY = "apps/gateway/src/export/worker.ts";

/**
 * The gateway executable: the server, and the export worker it starts with
 * `new Worker(url)` — not an import, so it is compiled in only when listed as
 * a second entrypoint. Inside the executable an entry lives at its path from
 * `root`, which is what `OMNI_EXPORT_WORKER` tells `spawnExportWorker` to
 * resolve. `entry` is the server's; only the build test passes another, a
 * probe that spawns the worker the way the server does.
 */
export async function buildGatewayBinary(
  outfile: string,
  root: string,
  entry = "apps/gateway/src/index.ts",
): Promise<void> {
  await buildBinary([entry, EXPORT_WORKER_ENTRY], outfile, root, {
    OMNI_EXPORT_WORKER: JSON.stringify(`./${EXPORT_WORKER_ENTRY}`),
  });
}

/** Compile directly to disk: executable artifacts must never be rewritten as text. */
export async function buildBinary(
  entrypoints: string[],
  outfile: string,
  root: string,
  define: Readonly<Record<string, string>> = {},
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
    define: { ...define },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`could not compile ${entrypoints.join(", ")}`);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const outfile = resolve(root, process.argv[2] ?? "dist/omnigateway");
  await buildGatewayBinary(outfile, root);
  console.log(`built gateway binary in ${outfile}`);
}
