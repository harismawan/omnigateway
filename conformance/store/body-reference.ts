// Imports are byte-identical to 1780bb39 (checked before running).
import { maskSecrets } from "../../packages/store/src/bodies/mask.ts";
import { boundValue } from "../../packages/store/src/bodies/bound.ts";
import { prepareArtifact, sealArtifact, decodeArtifact } from "../../packages/store/src/bodies/artifact.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
const input = JSON.parse(await Bun.stdin.text());
if (input.op === "pure") {
  console.log(JSON.stringify(input.values.map((text: string) => {
    const value = JSON.parse(text);
    return { masked: JSON.stringify(maskSecrets(value)), bounded: JSON.stringify(boundValue(value)) };
  })));
} else if (input.op === "corpus") {
  await import("./body-corpus.ts");
} else if (input.op === "prepare") {
  console.log(JSON.stringify(input.values.map((text: string) => prepareArtifact(JSON.parse(text)).json)));
} else {
  const key = await deriveKey(input.secret);
  if (input.op === "seal") {
    const sealed = await sealArtifact(key, input.json);
    console.log(JSON.stringify({ bytes: Buffer.from(sealed.bytes).toString("hex"), sha256: sealed.sha256 }));
  } else {
    const bytes = Buffer.from(input.bytes, "hex");
    const read = await decodeArtifact(key, bytes, input.sha256 ?? null);
    const plaintext = read.ok && bytes.subarray(0, 4).toString() === "OGBA" && bytes[5] === 0
      ? new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(10, 22), additionalData: bytes.subarray(0, 10), tagLength: 128 }, key, bytes.subarray(22)))
      : null;
    console.log(JSON.stringify({ ...read, plaintext }));
  }
}
