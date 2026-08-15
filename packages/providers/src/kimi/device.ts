import { randomUUID } from "node:crypto";
import type { HeaderPair } from "../types.ts";

export type KimiDevice = {
  deviceId: string;
  deviceName: string;
  deviceModel: string;
  osVersion: string;
};

/**
 * Mints a synthetic-but-stable device identity.
 *
 * Deliberately not read from the host. os.hostname() is often the operator's
 * name or their employer's asset tag, and it would go upstream on every
 * request. These values are made up once at connect time and then frozen onto
 * the credential — upstream only needs them to be stable, not true.
 */
export function mintKimiDevice(): KimiDevice {
  return {
    deviceId: randomUUID(),
    deviceName: "MacBook-Pro",
    deviceModel: "MacBookPro18,3",
    osVersion: "15.3.1",
  };
}

/** Reads the identity back off a credential's providerData. */
export function kimiDeviceHeaders(providerData: Record<string, unknown>): HeaderPair[] {
  const deviceId = providerData.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) return [];

  // Credentials created before the device fields existed carry only deviceId.
  const str = (v: unknown): string => (typeof v === "string" && v.length > 0 ? v : "unknown");

  return [
    ["X-Msh-Device-Id", deviceId],
    ["X-Msh-Device-Name", str(providerData.deviceName)],
    ["X-Msh-Device-Model", str(providerData.deviceModel)],
    ["X-Msh-Os-Version", str(providerData.osVersion)],
  ];
}
