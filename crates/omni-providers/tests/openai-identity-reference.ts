import * as id from "../../../packages/providers/src/openai/codexIdentity.ts";

const uuid = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const salt = "ab".repeat(32);
const minted = "01234567-89ab-4cde-8fab-0123456789ab";
Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => minted });
Object.defineProperty(globalThis.crypto, "getRandomValues", {
  value: (out: Uint8Array) => {
    out.fill(7);
    return out;
  },
});
const data = [
  {},
  { installationId: uuid },
  { idSalt: salt },
  { installationId: uuid, idSalt: salt },
  ...[null, false, 42, [], {}, "", "bad", "AB".repeat(32), "a".repeat(63), "g".repeat(64)].map(
    (v) => ({ installationId: v, idSalt: v }),
  ),
  { installationId: uuid + "\n", idSalt: salt + "\n" },
  { installationId: { nested: [1] }, idSalt: [salt] },
];
const secrets = data.map((data) => ({
  data,
  read: id.codexSecretsFrom(data),
  ensured: id.ensureCodexSecrets(data),
}));
const hashes = [
  "",
  "hi",
  "conversation-123",
  "用户😀",
  uuid,
  "\u0000\n",
  "019b86b5-42c0-7505-b36d-80ccdd119119",
  "ffffffff-ffff-7fff-bfff-ffffffffffff",
].flatMap((seed) =>
  [undefined, "", salt].flatMap((salt) =>
    [-1, 0, 1234.75, 1790812800000].map((timestamp) => ({
      seed,
      salt,
      timestamp,
      keyed: id.keyed(salt, seed),
      v4: id.uuidV4From(seed),
      v7: id.uuidV7From(seed, timestamp),
      thread: id.threadIdFrom(seed),
      prefix: id.prefixNamespace(seed),
      instant: id.threadInstant(seed, timestamp),
      valid: id.isUuid(seed),
    })),
  ),
);
console.log(JSON.stringify({ secrets, hashes }));
