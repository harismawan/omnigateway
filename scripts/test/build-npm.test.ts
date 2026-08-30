import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseVersion } from "../build-npm.ts";

test("a release tag becomes the published version", () => {
  expect(releaseVersion("v1.2.3")).toBe("1.2.3");
  expect(releaseVersion("1.2.3")).toBe("1.2.3");
  expect(releaseVersion("  v0.1.0\n")).toBe("0.1.0");
});

test("a prerelease tag is kept intact", () => {
  expect(releaseVersion("v2.0.0-rc.1")).toBe("2.0.0-rc.1");
});

test("a tag that is not a version stops the build", () => {
  // npm keeps a published version forever, so guessing at a malformed tag is
  // the one thing this must not do.
  for (const bad of ["", "latest", "v1.2", "v1.2.3.4", "release-1.2.3"]) {
    expect(() => releaseVersion(bad)).toThrow(/semver/);
  }
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const root = join(import.meta.dir, "..", "..");

/**
 * Bundles through a child `bun`, because this one cannot.
 *
 * `Bun.build` under `bun test` does not resolve `workspace:*` dependencies —
 * measured on 1.4.0, and independent of cwd: the same call succeeds from a
 * standalone `bun` with cwd anywhere and fails inside the runner with
 * `Could not resolve: "@omni/control"`. There are no `node_modules/@omni`
 * symlinks in this repository at all; the runtime answers those specifiers from
 * bun.lock, and the bundler inside the test runner does not.
 *
 * Spawning is not a workaround around the assertion, it is the arrangement the
 * release actually uses — `.github/workflows/release.yml` runs
 * `bun scripts/build-npm.ts` as its own process.
 */
function bundleCli(outfile: string, version: string): Bun.SyncSubprocess {
  const script = `
    const { bundle } = await import(${JSON.stringify(join(root, "scripts", "build-npm.ts"))});
    await bundle("apps/cli/src/index.ts", ${JSON.stringify(outfile)}, ${JSON.stringify(version)});
  `;
  return Bun.spawnSync(["bun", "-e", script], { cwd: root });
}

/**
 * The version reaching the artifact, not the version reaching the manifest.
 *
 * Every published build answered `omni --version` with `0.0.0`. The release
 * version was written into the generated `package.json` and nowhere the CLI
 * could read it, so npm and the binary it installed disagreed permanently and
 * silently — an operator reporting a bug named a version that never shipped.
 *
 * Asserted by running the bundle rather than by reading its text. A `define`
 * that lands in the output but is shadowed, folded to the wrong branch or never
 * consulted is indistinguishable from a working one in a substring check.
 *
 * The artifact runs from a temporary directory with no `node_modules` above it,
 * which is the shape a published install has and this checkout does not.
 */
test("the bundled CLI reports the version it was built with", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-cli-version-"));
  dirs.push(dir);
  const outfile = join(dir, "omni.js");

  const build = bundleCli(outfile, "9.9.9-test");
  // stderr rather than the exit code, so a bundling failure prints its reason
  // instead of "expected 0, received 1" about a build nobody can see.
  expect(build.exitCode === 0 ? "" : (build.stderr?.toString() ?? "")).toBe("");

  const built = Bun.spawnSync(["bun", outfile, "--version"], { cwd: dir });
  expect(built.stdout.toString().trim()).toBe("9.9.9-test");
  expect(built.exitCode).toBe(0);
});

test("a second version produces a second answer", () => {
  // The control. A bundle that hard-coded `9.9.9-test`, or a `--version` that
  // echoed an argument, satisfies the test above exactly as well.
  const dir = mkdtempSync(join(tmpdir(), "omni-cli-version-"));
  dirs.push(dir);
  const outfile = join(dir, "omni.js");

  expect(bundleCli(outfile, "1.2.3").exitCode).toBe(0);
  expect(Bun.spawnSync(["bun", outfile, "--version"], { cwd: dir }).stdout.toString().trim()).toBe(
    "1.2.3",
  );
});
