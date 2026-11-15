import { Database } from "bun:sqlite";

/** Conformance seed format, reproduced here without importing gateway code. */
export async function seedOAuth(path: string, secret: string, label: string) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("omnigateway-field-encryption-v1"),
      iterations: 210000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const encrypt = async (text: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = Buffer.from(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)),
    );
    return `enc:v1:${Buffer.from(iv).toString("hex")}:${sealed.subarray(0, -16).toString("hex")}:${sealed.subarray(-16).toString("hex")}`;
  };
  const db = new Database(path);
  try {
    db.run(
      "UPDATE credentials SET auth_type='oauth',access_token=?,refresh_token=?,api_key=NULL,expires_at=?,token_version=0 WHERE label=?",
      [await encrypt("bench-access"), await encrypt("bench-refresh"), 4102444800000, label],
    );
  } finally {
    db.close();
  }
}
