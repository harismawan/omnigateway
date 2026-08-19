import { expect, test } from "bun:test";
import { DASHBOARD_SDK_VERSION } from "@omni/plugins/manifest";
import { SDK_VERSION } from "../src/index.ts";

test("SDK_VERSION is the host's DASHBOARD_SDK_VERSION, not a copy of it", () => {
  // The gateway checks a plugin's `sdk` range against DASHBOARD_SDK_VERSION at
  // load, and the plugin's bundle was built against SDK_VERSION. Two literals
  // would let a plugin verify clean, take a live nav entry, and then refuse to
  // mount — a failure that reads as a broken plugin and is a broken constant.
  expect(SDK_VERSION).toBe(DASHBOARD_SDK_VERSION);
});

test("SDK_VERSION is a semver version, because a range is matched against it", () => {
  // `sdk` in a manifest is a range like "^1.0.0". A value that is not a plain
  // version makes every range comparison meaningless rather than false.
  expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
