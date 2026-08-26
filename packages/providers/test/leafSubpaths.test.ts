import { expect, test } from "bun:test";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

/**
 * Bundles one entry point and reports which markers it contains.
 *
 * Returns booleans rather than the code because the assertions are about
 * presence, and a failed `toContain` on a bundle prints the whole bundle —
 * several hundred kilobytes of minified output standing between a reader and
 * the one-word answer they needed.
 */
async function markers(entry: string, probes: readonly string[]): Promise<Record<string, boolean>> {
  const built = await Bun.build({ entrypoints: [resolve(SRC, entry)], target: "browser" });
  expect(built.success).toBe(true);
  const code = (await Promise.all(built.outputs.map((artifact) => artifact.text()))).join("\n");
  return Object.fromEntries(probes.map((probe) => [probe, code.includes(probe)]));
}

/**
 * `catalog.ts` and `descriptors.ts` are leaf subpaths: the console imports the
 * first, the pure router imports both, so neither may reach the adapters or the
 * HTTP client. Nothing in the type system enforces that — one ordinary `import`
 * undoes it, and the symptom is a browser bundle that quietly grows a copy of
 * `node:http` rather than a failing build.
 *
 * The presence assertions are load-bearing. "The transport is absent" is also
 * what a harness that bundled nothing would report, so each test first proves it
 * bundled the thing it claims to be checking.
 */
test("the catalog subpath carries model data and no transport", async () => {
  expect(
    await markers("catalog.ts", [
      "PROVIDER_MODEL_CATALOG",
      "node:http",
      "nodeHttpClient",
      "CONNECT_ATTEMPT_TIMEOUT_MS",
    ]),
  ).toEqual({
    PROVIDER_MODEL_CATALOG: true,
    "node:http": false,
    nodeHttpClient: false,
    CONNECT_ATTEMPT_TIMEOUT_MS: false,
  });
});

test("the descriptors subpath carries provider data and no transport", async () => {
  expect(
    await markers("descriptors.ts", [
      "PROVIDER_DESCRIPTORS",
      // Proof it bundled the descriptors themselves rather than an empty
      // module: a key only a descriptor states.
      "writeOverInput",
      "node:http",
      "nodeHttpClient",
      "CONNECT_ATTEMPT_TIMEOUT_MS",
    ]),
  ).toEqual({
    PROVIDER_DESCRIPTORS: true,
    writeOverInput: true,
    "node:http": false,
    nodeHttpClient: false,
    CONNECT_ATTEMPT_TIMEOUT_MS: false,
  });
});

test("the package root does pull the transport, so the checks above mean something", async () => {
  // The control. If the root bundled clean too, the assertions above would be
  // passing for the wrong reason and would keep passing after a real leak.
  expect(await markers("index.ts", ["CONNECT_ATTEMPT_TIMEOUT_MS"])).toEqual({
    CONNECT_ATTEMPT_TIMEOUT_MS: true,
  });
});
