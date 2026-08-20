import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("package.json is not object");
  return parsed as PackageJson;
}

/**
 * The four specifiers the console owns.
 *
 * The same four `apps/dashboard/shared/manifest.ts` externalises and serves
 * through the import map, which is not a coincidence: that file is the host
 * half of this declaration.
 */
const HOST_OWNED = ["react", "react-dom", "styled-components", "@tanstack/react-query"];

test("the host-owned packages are peer dependencies", () => {
  const peers = readPackageJson().peerDependencies ?? {};
  for (const name of HOST_OWNED) {
    expect(Object.keys(peers)).toContain(name);
  }
});

test("no host-owned package is a dependency or a devDependency", () => {
  // This is the failure the whole federation design exists to prevent, and it
  // is one character in a JSON file. A plugin that resolves its own React ends
  // up with two React instances on one page and every hook in it throws
  // "invalid hook call" — an error that points at the plugin's components and
  // never at the duplicated dependency. Moving a name out of `peerDependencies`
  // is what does it, and nothing else in the suite would notice.
  const pkg = readPackageJson();
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  for (const name of HOST_OWNED) {
    expect(deps).not.toContain(name);
    expect(devDeps).not.toContain(name);
  }
});

test("nothing in the source imports React at runtime", () => {
  // Types are free; a value import is not. The SDK is the one dependency every
  // plugin bundle has, so it is the worst possible place to be wrong about
  // which React instance is in use — a `import { useMemo } from "react"` here
  // would defeat the peer declaration above from inside.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const file of ["index.ts", "api.ts", "theme.ts", "ui.ts"]) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import ")) continue;
      if (!/from\s+"(react|react-dom|styled-components|@tanstack\/react-query)/.test(trimmed)) {
        continue;
      }
      expect(trimmed.startsWith("import type ")).toBe(true);
    }
  }
});
