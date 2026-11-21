import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackages, PLATFORMS, releaseVersion, verifyPacked } from "../build-npm.ts";

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

/** A release archive as `rust-binaries` packs it: binary, omni link, public/, LICENSE. */
function archive(dir: string, target: string, tag: string, body: string): string {
  const stage = join(dir, `stage-${target}`);
  mkdirSync(join(stage, "public"), { recursive: true });
  writeFileSync(join(stage, "omnigateway"), body);
  chmodSync(join(stage, "omnigateway"), 0o755);
  symlinkSync("omnigateway", join(stage, "omni"));
  writeFileSync(join(stage, "public", "index.html"), "<html></html>");
  writeFileSync(join(stage, "LICENSE"), "MIT");
  const file = join(dir, `omnigateway-${tag}-${target}.tar.gz`);
  const tar = Bun.spawnSync(["tar", "-czf", file, "-C", stage, "."]);
  expect(tar.exitCode).toBe(0);
  return file;
}

function fixture(): { dir: string; assets: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "omni-npm-"));
  dirs.push(dir);
  const assets = join(dir, "assets");
  mkdirSync(assets);
  for (const { target } of PLATFORMS) archive(assets, target, "v1.0.0", `binary for ${target}`);
  return { dir, assets, out: join(dir, "out") };
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("every platform package carries its archive's bytes and claims only its host", async () => {
  const { assets, out } = fixture();
  await buildPackages({ version: "1.0.0", assets, out });
  for (const { target, npm, os, cpu } of PLATFORMS) {
    const pkg = join(out, npm.replace("@omnigateway/", ""));
    const manifest = json(join(pkg, "package.json"));
    expect(manifest.name).toBe(npm);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.os).toEqual([os]);
    expect(manifest.cpu).toEqual([cpu]);
    expect(readFileSync(join(pkg, "omnigateway"), "utf8")).toBe(`binary for ${target}`);
    expect(lstatSync(join(pkg, "omnigateway")).mode & 0o111).toBe(0o111);
    expect(existsSync(join(pkg, "public", "index.html"))).toBe(true);
    // npm drops symlinks from tarballs; the main package links `omni` instead.
    expect(existsSync(join(pkg, "omni"))).toBe(false);
  }
});

test("the main package pins every platform at its own version and refuses Windows", async () => {
  const { assets, out } = fixture();
  await buildPackages({ version: "1.0.0", assets, out });
  const manifest = json(join(out, "omnigateway", "package.json"));
  expect(manifest.name).toBe("omnigateway");
  expect(manifest.version).toBe("1.0.0");
  expect(manifest.optionalDependencies).toEqual(
    Object.fromEntries(PLATFORMS.map(({ npm }) => [npm, "1.0.0"])),
  );
  expect(manifest.os).toEqual(["linux", "darwin"]);
  expect(manifest.cpu).toEqual(["x64", "arm64"]);
  expect(manifest.bin).toEqual({ omni: "bin/omni", omnigateway: "bin/omnigateway" });
  expect(manifest.scripts).toEqual({ postinstall: "node postinstall.js" });
  expect(manifest.engines).toEqual({ node: ">=18" });
  expect(manifest.dependencies).toBeUndefined();
  // The bridge sits where every 0.x unit's ExecStart points.
  for (const file of ["gateway.js", "postinstall.js", "lib/run.js", "lib/platform.js"]) {
    expect(existsSync(join(out, "omnigateway", file))).toBe(true);
  }
  for (const file of ["bin/omni", "bin/omnigateway"]) {
    expect(lstatSync(join(out, "omnigateway", file)).mode & 0o111).toBe(0o111);
  }
});

test("a missing archive stops the build rather than publishing a partial set", async () => {
  const { assets, out } = fixture();
  rmSync(join(assets, "omnigateway-v1.0.0-aarch64-apple-darwin.tar.gz"));
  await expect(buildPackages({ version: "1.0.0", assets, out })).rejects.toThrow(
    /aarch64-apple-darwin/,
  );
});

test("an archive for another tag stops the build", async () => {
  const { assets, out } = fixture();
  await expect(buildPackages({ version: "1.0.1", assets, out })).rejects.toThrow(/v1\.0\.1/);
});

/** `npm pack` of every built directory, as the publish step does. */
function pack(dirs: string[], into: string): string[] {
  mkdirSync(into, { recursive: true });
  return dirs.map((dir) => {
    const out = Bun.spawnSync(["npm", "pack", "--silent", "--pack-destination", into, dir], {
      cwd: dir,
    });
    expect(out.exitCode).toBe(0);
    return join(into, out.stdout.toString().trim().split("\n").at(-1) as string);
  });
}

test.skipIf(Bun.which("npm") === null)(
  "packed platform tarballs carry exactly the archive's binary",
  async () => {
    const { dir, assets, out } = fixture();
    const dirs = await buildPackages({ version: "1.0.0", assets, out });
    const tarballs = pack(dirs, join(dir, "packed"));
    expect(await verifyPacked({ version: "1.0.0", assets, tarballs })).toBe(4);
    // A tampered tarball is caught.
    const bad = join(out, "linux-x64", "omnigateway");
    writeFileSync(bad, "something else");
    const again = pack([join(out, "linux-x64")], join(dir, "packed-bad"));
    await expect(
      verifyPacked({ version: "1.0.0", assets, tarballs: [...tarballs.slice(1), ...again] }),
    ).rejects.toThrow(/linux-x64/);
  },
);
