import { zstdEncode } from "../../../packages/providers/src/http-client.ts";

const rows = [];
for (const size of [
  0, 1, 7, 62000, 131071, 131072, 131073, 507000, 2097151, 2097152, 2097153, 8388608,
]) {
  for (const varied of [false, true]) {
    const raw = Buffer.alloc(size);
    let state = 0x12345678;
    for (let i = 0; i < size; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw[i] = varied ? state & 255 : 97 + (i % 7);
    }
    const frame = await zstdEncode(raw);
    rows.push({
      size,
      varied,
      length: frame.length,
      hash: Bun.CryptoHasher.hash("sha256", frame, "hex"),
      header: frame.subarray(0, 6).toString("hex"),
    });
  }
}
console.log(JSON.stringify(rows));
