import { trustedInferenceOrigin } from "./endpoint.ts";
import type { QoderModel } from "./modelCatalog.ts";

export type QoderCredentialBundle = {
  version: 1;
  deviceToken: string;
  uid: string;
  machineId: string;
  encryptUserInfo: string;
  key: string;
  issuedAt: number;
  origin: string;
  models: QoderModel[];
};

export function parseCredential(value: string): QoderCredentialBundle {
  try {
    const b = JSON.parse(value) as QoderCredentialBundle;
    if (
      b?.version !== 1 ||
      !trustedInferenceOrigin(b.origin) ||
      !Number.isSafeInteger(b.issuedAt) ||
      b.issuedAt <= 0 ||
      ![b.deviceToken, b.uid, b.machineId, b.encryptUserInfo, b.key].every(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: enforce header-safe credential fields
        (v) => typeof v === "string" && v.length > 0 && !/[\x00-\x1f\x7f]/.test(v),
      ) ||
      !Array.isArray(b.models) ||
      b.models.length > 500 ||
      b.models.some(
        (m) =>
          !m ||
          typeof m.key !== "string" ||
          !m.key ||
          m.key.length > 200 ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in model identifiers
          /[\x00-\x1f\x7f]/.test(m.key) ||
          typeof m.displayName !== "string" ||
          !m.displayName ||
          m.displayName.length > 200 ||
          typeof m.images !== "boolean" ||
          typeof m.reasoning !== "boolean" ||
          (m.maxInputTokens !== undefined &&
            (!Number.isSafeInteger(m.maxInputTokens) || m.maxInputTokens <= 0)),
      )
    ) {
      throw new Error();
    }
    return b;
  } catch {
    throw new Error("Invalid Qoder credential");
  }
}
