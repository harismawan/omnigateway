import { expect, test } from "bun:test";
import { kimiDeviceHeaders, mintKimiDevice } from "../src/kimi/device.ts";

test("mintKimiDevice produces a stable-shaped synthetic identity", () => {
  const d = mintKimiDevice();
  expect(d.deviceId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(d.deviceName.length).toBeGreaterThan(0);
  // Never the operator's real machine name.
  expect(d.deviceName).not.toBe(require("node:os").hostname());
  expect(mintKimiDevice().deviceId).not.toBe(d.deviceId);
});

test("kimiDeviceHeaders emits all four headers", () => {
  const names = kimiDeviceHeaders({
    deviceId: "abc",
    deviceName: "n",
    deviceModel: "m",
    osVersion: "o",
  }).map(([n]) => n);
  expect(names).toEqual([
    "X-Msh-Device-Id",
    "X-Msh-Device-Name",
    "X-Msh-Device-Model",
    "X-Msh-Os-Version",
  ]);
});

test("kimiDeviceHeaders fills defaults for credentials that predate the fields", () => {
  const h = new Map(kimiDeviceHeaders({ deviceId: "abc" }));
  expect(h.get("X-Msh-Device-Id")).toBe("abc");
  expect(h.get("X-Msh-Device-Name")).toBe("unknown");
  expect(h.get("X-Msh-Device-Model")).toBe("unknown");
  expect(h.get("X-Msh-Os-Version")).toBe("unknown");
});

test("kimiDeviceHeaders emits nothing when there is no device id", () => {
  expect(kimiDeviceHeaders({})).toEqual([]);
});
