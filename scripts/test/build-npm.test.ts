import { expect, test } from "bun:test";
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
