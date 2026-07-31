const PREFIX = "enc:v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KDF_SALT = new TextEncoder().encode("omnigateway-field-encryption-v1");

/**
 * Derives the AES-256-GCM field key from the operator's secret.
 *
 * PBKDF2 rather than scrypt because WebCrypto provides it natively. The input
 * is a high-entropy generated secret rather than a chosen password, so the
 * iteration count is defence in depth, not the primary barrier.
 */
export async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: KDF_SALT, iterations: 210_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns `enc:v1:<iv-hex>:<ciphertext-hex>:<tag-hex>`. */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  return [PREFIX, hex(iv), hex(body), hex(tag)].join(":");
}

export async function decrypt(key: CryptoKey, value: string): Promise<string> {
  const parts = value.split(":");
  const [scheme, version, ivHex, bodyHex, tagHex] = parts;
  if (parts.length !== 5 || scheme !== "enc" || version !== "v1" || !ivHex || !tagHex) {
    throw new Error("malformed ciphertext");
  }
  const sealed = new Uint8Array([...unhex(bodyHex ?? ""), ...unhex(tagHex)]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(ivHex), tagLength: TAG_BYTES * 8 },
    key,
    sealed,
  );
  return new TextDecoder().decode(plain);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
