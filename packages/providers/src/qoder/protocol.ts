const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const QODER = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$";

function swapThirds(value: string): string {
  const n = Math.floor(value.length / 3);
  if (n === 0) return value;
  return value.slice(-n) + value.slice(n, -n) + value.slice(0, n);
}

export function encodeBody(plain: string): string {
  const base64 = Buffer.from(plain, "utf8").toString("base64");
  return swapThirds(Array.from(base64, (c) => QODER[STANDARD.indexOf(c)]).join(""));
}

export function decodeBody(encoded: string): string {
  if (encoded.length % 4 !== 0) throw new Error("Invalid Qoder encoding");
  const chars = Array.from(swapThirds(encoded), (c) => {
    const index = QODER.indexOf(c);
    if (index < 0) throw new Error("Invalid Qoder encoding");
    return STANDARD[index];
  }).join("");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chars)) {
    throw new Error("Invalid Qoder encoding");
  }
  const bytes = Buffer.from(chars, "base64");
  if (bytes.toString("base64") !== chars) throw new Error("Invalid Qoder encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The CLI intentionally accepts plaintext JSON when response decryption fails. */
export function decodeServerJson(text: string): unknown {
  try {
    return JSON.parse(decodeBody(text));
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid Qoder JSON response");
    }
  }
}
