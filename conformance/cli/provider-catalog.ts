#!/usr/bin/env bun
/**
 * Generates the Rust CLI's built-in provider descriptors from the frozen TS
 * registry, never from a hand-copied table.
 *
 *   bun conformance/cli/provider-catalog.ts          # rewrite the data file
 *   bun conformance/cli/provider-catalog.ts --check  # exit 1 on any drift
 *
 * The file is exactly `JSON.stringify(PROVIDER_DESCRIPTORS)`, formatted by the
 * repository's pinned Biome so `biome check` accepts it unchanged. Registry
 * order, catalog order, labels, pricing, API and OAuth limits, model auth,
 * capabilities and presentation are all carried. Plugin providers are not:
 * they are installation state. The Rust CLI matches frozen discovery for
 * plugins that contribute no provider and refuses only where frozen TS would
 * import a provider-capable plugin's code, rather than omit it silently.
 */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROVIDER_DESCRIPTORS } from "../../packages/providers/src/descriptors.ts";

const repo = resolve(import.meta.dir, "../..");
const target = "crates/omni-control/data/provider-catalog.json";
const path = resolve(repo, target);

// Nothing JSON cannot carry: no functions, undefined, non-finite numbers or
// non-plain values. A lossy encoding would be a hand edit in disguise.
const plain = JSON.parse(JSON.stringify(PROVIDER_DESCRIPTORS));
assert.deepEqual(plain, { ...PROVIDER_DESCRIPTORS });
for (const [id, descriptor] of Object.entries(PROVIDER_DESCRIPTORS))
  assert.equal(descriptor.id, id);
// Every row prices all five token classes and states both limits (OAuth limits
// too, where present): the frozen types require them, so the catalog table's
// dash for an absent price or limit is unreachable from built-in data.
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
for (const { catalog } of Object.values(PROVIDER_DESCRIPTORS))
  for (const row of catalog.models) {
    for (const k of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const)
      assert(finite(row.pricing[k]), `${row.id} pricing.${k}`);
    for (const limits of [row.limits, ...(row.oauthLimits ? [row.oauthLimits] : [])])
      assert(finite(limits.contextWindow) && finite(limits.maxOutputTokens), `${row.id} limits`);
  }

const formatted = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${target}`], {
  cwd: repo,
  stdin: new TextEncoder().encode(`${JSON.stringify(PROVIDER_DESCRIPTORS)}\n`),
  stdout: "pipe",
  stderr: "pipe",
});
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
const text = formatted.stdout.toString();
assert.deepEqual(JSON.parse(text), plain);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current !== text) {
    console.error(`${target} has drifted from PROVIDER_DESCRIPTORS; regenerate it`);
    process.exit(1);
  }
  console.log(`${target} matches PROVIDER_DESCRIPTORS`);
} else {
  writeFileSync(path, text);
  console.log(`wrote ${target}`);
}
