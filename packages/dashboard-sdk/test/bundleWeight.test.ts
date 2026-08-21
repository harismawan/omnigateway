import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a plugin actually pays to import this package.
 *
 * The sibling test in `packages/plugin-api` exists because a doc claiming a
 * 31 KB bundle went on claiming it for as long as it was false. This one exists
 * for a narrower reason: `src/index.ts` re-exports `DASHBOARD_SDK_VERSION` from
 * `@omnigateway/plugin-api/version`, a leaf module holding two constants — and
 * the package *root* next door re-exports the same constant alongside the zod
 * manifest schema. Changing one character of that specifier would put half a
 * megabyte of validator into every plugin bundle, typecheck clean, and fail
 * nothing.
 *
 * Bundled from inside this package's own directory rather than the system temp
 * root, because the specifier has to resolve the way it does for a real
 * dependent: from here `@omnigateway/dashboard-sdk` is a workspace package,
 * from `/tmp` it is nothing.
 */
const scratch = mkdtempSync(join(import.meta.dir, ".bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundle(): Promise<string> {
  // Re-exported rather than imported, so nothing is dropped as unused — a
  // bundler that tree-shook it away would make every assertion here trivially
  // true.
  const entry = join(scratch, "entry.ts");
  writeFileSync(entry, `export * from "@omnigateway/dashboard-sdk";\n`);

  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    // The specifiers the console owns. A plugin's own build marks these
    // external, so measuring with them inlined would report React's weight
    // rather than this package's.
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "styled-components",
      "@tanstack/react-query",
    ],
  });

  if (!result.success) throw new Error(`could not bundle the SDK: ${result.logs.join("\n")}`);
  const outputs = await Promise.all(result.outputs.map((artifact) => artifact.text()));
  return outputs.join("\n");
}

test("carries no zod, so the version subpath is still doing its job", async () => {
  expect(await bundle()).not.toContain("zod");
});

test("stays small enough that a regression is obvious", async () => {
  const code = await bundle();
  // Generous against the real figure — a few KB — because the number that
  // matters is the order of magnitude. Pulling in the plugin-api root would put
  // this into the hundreds.
  expect(Buffer.byteLength(code)).toBeLessThan(32 * 1024);
});

test("keeps React out of what a plugin ships", async () => {
  // `live.ts` imports React for its value, so the one thing that must remain
  // true is that the import stays an import. A bundler misconfigured to inline
  // it would put a second React in every plugin — the failure the whole
  // federation exists to prevent, arriving through this package.
  const code = await bundle();
  expect(code).toContain(`from "react"`);
  expect(code).not.toContain("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE");
});
