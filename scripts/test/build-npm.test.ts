import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DEPENDENCIES, releaseVersion, runtimeDependencies } from "../build-npm.ts";

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

test("the published package has no external runtime dependencies", () => {
  const gateway = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "apps", "gateway", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  expect(runtimeDependencies(gateway)).toEqual({});
});

test("the range that actually ships is empty", () => {
  expect(RUNTIME_DEPENDENCIES).toEqual({});
});

test("an external that is not a gateway dependency stops the build", () => {
  // Publishing it with no version lets npm resolve `latest` on a native module.
  expect(() => runtimeDependencies({ dependencies: {} }, ["some-external-pkg"])).toThrow(
    /not a gateway dependency/,
  );
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
 * The bundled artifact runs with zero external runtime dependencies.
 * The `--no-install` on every artifact spawn ensures no runtime auto-install occurs.
 */

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
 * The artifact runs from a temporary directory holding only the declared
 * runtime dependencies — the shape a published install has, which this
 * checkout (a workspace with every internal package resolvable) does not.
 */
test("the bundled CLI reports the version it was built with", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-cli-version-"));
  dirs.push(dir);
  const outfile = join(dir, "omni.js");

  const build = bundleCli(outfile, "9.9.9-test");
  // stderr rather than the exit code, so a bundling failure prints its reason
  // instead of "expected 0, received 1" about a build nobody can see.
  expect(build.exitCode === 0 ? "" : (build.stderr?.toString() ?? "")).toBe("");

  const built = Bun.spawnSync(["bun", "--no-install", outfile, "--version"], { cwd: dir });
  // Same trade as the bundle above: a crashed artifact names its reason.
  expect(built.exitCode === 0 ? "" : (built.stderr?.toString() ?? "")).toBe("");
  expect(built.stdout.toString().trim()).toBe("9.9.9-test");
});

test("a second version produces a second answer", () => {
  // The control. A bundle that hard-coded `9.9.9-test`, or a `--version` that
  // echoed an argument, satisfies the test above exactly as well.
  const dir = mkdtempSync(join(tmpdir(), "omni-cli-version-"));
  dirs.push(dir);
  const outfile = join(dir, "omni.js");

  expect(bundleCli(outfile, "1.2.3").exitCode).toBe(0);
  expect(
    Bun.spawnSync(["bun", "--no-install", outfile, "--version"], { cwd: dir })
      .stdout.toString()
      .trim(),
  ).toBe("1.2.3");
});

/**
 * The same number, on the command an operator actually pastes into a report.
 *
 * `--version` is the assertion above; this is the one that matters in practice,
 * because `doctor` is the diagnostic bundle and it named every path on the
 * installation without ever saying which build produced them. Asserted against
 * the bundled artifact rather than the checkout, for the reason the tests above
 * are: in a checkout both answers are `0.0.0-dev`, so a `doctor` that
 * hard-coded the fallback would satisfy an in-repo test perfectly.
 *
 * `--root` at a temporary directory, so the artifact diagnoses a throwaway
 * installation rather than whatever this machine has at `~/.config`.
 */
test("the bundled CLI names that same version in doctor --json", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-cli-doctor-"));
  dirs.push(dir);
  const outfile = join(dir, "omni.js");

  const build = bundleCli(outfile, "9.9.9-test");
  expect(build.exitCode === 0 ? "" : (build.stderr?.toString() ?? "")).toBe("");

  const built = Bun.spawnSync(["bun", "--no-install", outfile, "doctor", "--json", "--root", dir], {
    cwd: dir,
  });
  expect(built.exitCode === 0 ? "" : (built.stderr?.toString() ?? "")).toBe("");
  expect(JSON.parse(built.stdout.toString()).version).toBe("9.9.9-test");

  // The human first line too, and from the same bundle. Spec §3 specifies both
  // forms, and hard-coding the fallback in *either* is invisible in a checkout,
  // where the real answer and the fallback are the same string.
  const human = Bun.spawnSync(["bun", "--no-install", outfile, "doctor", "--root", dir], {
    cwd: dir,
  });
  expect(human.stdout.toString().split("\n")[0]).toBe("omni 9.9.9-test");
});
