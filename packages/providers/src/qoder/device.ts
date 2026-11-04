import { createHash } from "node:crypto";

export function syntheticUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
