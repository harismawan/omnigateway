import { constants, createCipheriv, createHash, publicEncrypt } from "node:crypto";

// Public wrapping key shipped in Qoder CLI 1.1.82 (not the profile-storage key).
export const QODER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export function encryptAuth(
  userJson: string,
  key: string,
): { encryptUserInfo: string; key: string } {
  if (!/^[0-9a-f]{16}$/.test(key)) throw new Error("Invalid Qoder encryption key");
  const bytes = Buffer.from(key, "ascii");
  // Compatibility with the CLI's wire protocol, not a general-purpose encryption scheme.
  const cipher = createCipheriv("aes-128-cbc", bytes, bytes);
  return {
    encryptUserInfo: Buffer.concat([cipher.update(userJson, "utf8"), cipher.final()]).toString(
      "base64",
    ),
    key: publicEncrypt(
      { key: QODER_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
      bytes,
    ).toString("base64"),
  };
}

export function signAuth(input: {
  authBase64: string;
  key: string;
  date: string;
  body: string;
  path: string;
}): string {
  return createHash("md5")
    .update([input.authBase64, input.key, input.date, input.body, input.path].join("\n"))
    .digest("hex");
}

/** Public anonymous endpoint-election signature used by the shipped CLI. */
export function signAnonymous(date: string): string {
  return createHash("md5").update(`cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&${date}`).digest("hex");
}
