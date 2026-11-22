/**
 * The Rust gateway reads its built-in provider catalog from
 * `crates/omni-control/data/provider-catalog.json`; the TS registry is
 * `PROVIDER_DESCRIPTORS`. Its generator went with the conformance harness, so
 * every catalog change is now two hand edits, and this is what keeps them one
 * fact: the file must equal the registry as JSON, every row, price, limit and
 * order included.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_DESCRIPTORS } from "../../packages/providers/src/descriptors.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const dataFile = join(repoRoot, "crates/omni-control/data/provider-catalog.json");

test("the Rust catalog data equals PROVIDER_DESCRIPTORS", () => {
  const registry: unknown = JSON.parse(JSON.stringify(PROVIDER_DESCRIPTORS));
  const data: unknown = JSON.parse(readFileSync(dataFile, "utf8"));
  // The control: an empty registry would equal an empty file.
  expect(Object.keys(PROVIDER_DESCRIPTORS)).toContain("antigravity");
  expect(data).toEqual(registry);
  // Key order is the registry order the Rust side reports.
  expect(Object.keys(data as Record<string, unknown>)).toEqual(Object.keys(PROVIDER_DESCRIPTORS));
});
