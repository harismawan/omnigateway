import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

describe("the Bun development and build toolchain", () => {
  test("local version metadata pins Bun 1.4.4", () => {
    const path = join(repoRoot, ".bun-version");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("1.4.4");
  });

  test("the root package manager pins Bun 1.4.4", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    expect(manifest.packageManager).toBe("bun@1.4.4");
  });

  test.each(["ci", "release"])("the %s workflow pins Bun 1.4.4", (workflow) => {
    const source = readFileSync(join(repoRoot, `.github/workflows/${workflow}.yml`), "utf8");
    const versions = [...source.matchAll(/^\s*bun-version:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );
    expect(versions).toEqual(["1.4.4"]);
  });

  test("the Docker build pins Bun 1.4.4", () => {
    const source = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    const images = [...source.matchAll(/^FROM\s+oven\/bun:(\S+)/gim)].map((match) => match[1]);
    expect(images).toEqual(["1.4.4-alpine"]);
  });
});
