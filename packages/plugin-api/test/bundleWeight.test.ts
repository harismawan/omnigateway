/**
 * What each entry point costs a plugin that imports it.
 *
 * This package has four entries and only one of them may carry zod. The root
 * re-exports the manifest schema, which is built at module scope, so importing
 * it pulls a validator a plugin has no runtime use for — the manifest is parsed
 * by the *host*, before the plugin's own code is ever imported.
 *
 * The split into `/define`, `/events` and `/version` exists for that reason
 * alone, and it is the kind of guarantee that decays without being noticed: it
 * is invisible in review, no type expresses it, and every test can stay green
 * while a bundle quietly grows twentyfold. It did. A `WINDOW_MS` imported from
 * `@omni/ratelimit/catalog` — one three-entry duration table, in a package whose
 * first line is `import { z } from "zod"` — took the companion's server bundle
 * to 564 KB with 550 occurrences of zod in it, and nothing failed. The doc
 * claiming a 31 KB bundle went on saying so for as long as it was false.
 *
 * So this asserts the property directly, against a real build.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Inside this package's own directory, not the system temp root, because the
// specifier has to resolve the way it does for a real dependent — from here,
// `@omnigateway/plugin-api` is a workspace package; from `/tmp` it is nothing.
const scratch = mkdtempSync(join(import.meta.dir, ".bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/** Bundles one import of this package the way a plugin's own build would. */
async function bundle(specifier: string): Promise<string> {
  // Re-exported rather than merely imported, so nothing is dropped as unused: a
  // bundler that tree-shook the import away would make every assertion below
  // trivially true.
  const entry = join(scratch, `entry${counter++}.ts`);
  writeFileSync(entry, `export * from "${specifier}";\n`);

  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
  });

  if (!result.success) {
    throw new Error(`could not bundle ${specifier}: ${result.logs.join("\n")}`);
  }
  const outputs = await Promise.all(result.outputs.map((artifact) => artifact.text()));
  return outputs.join("\n");
}

describe("the entry points a plugin imports", () => {
  test("the root carries zod, which is why the other entries exist", async () => {
    // The control, and the load-bearing test in this file. Every assertion
    // below is "zod is absent", and absence is exactly what a broken harness
    // reports too — a bundle that failed to resolve anything would pass all of
    // them. This proves the check can see zod when zod is really there.
    const code = await bundle("@omnigateway/plugin-api");
    expect(code).toContain("zod");
  });

  test("`/define` carries none", async () => {
    expect(await bundle("@omnigateway/plugin-api/define")).not.toContain("zod");
  });

  test("`/events` carries none", async () => {
    // The specific regression this file was written for. `WINDOW_MS` lives here
    // rather than being imported from the rate limiter precisely so that a
    // plugin can ask how long a window is without buying a validator.
    expect(await bundle("@omnigateway/plugin-api/events")).not.toContain("zod");
  });

  test("`/version` carries none", async () => {
    expect(await bundle("@omnigateway/plugin-api/version")).not.toContain("zod");
  });

  test("the zod-free entries stay small enough that a regression is obvious", async () => {
    // A ceiling, not a measurement. The three entries together are a few
    // kilobytes of types, constants and an identity function; the number is far
    // above that and far below anything with a validator in it, so it catches a
    // dependency arriving without failing on ordinary growth.
    const code = await Promise.all([
      bundle("@omnigateway/plugin-api/define"),
      bundle("@omnigateway/plugin-api/events"),
      bundle("@omnigateway/plugin-api/version"),
    ]);
    const total = code.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    expect(total).toBeLessThan(32 * 1024);
  });
});
