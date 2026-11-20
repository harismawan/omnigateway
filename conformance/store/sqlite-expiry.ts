/** Write the parked REAL row through the frozen SQLite credential store. */
import { deriveKey } from "../../packages/store/src/encryption.ts";
import { createStore } from "../../packages/store/src/sqlite/store.ts";

const path = process.argv[2];
if (!path) throw new Error("expected database path");
const store = await createStore({
  path,
  encryptionKey: await deriveKey("snapshot-test-encryption-key"),
});
try {
  await store.credentials.create({
    id: "ts-real",
    provider: "custom",
    label: "ts-real",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: 1.5,
    accountEmail: null,
    providerData: { endpointId: "e" },
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "fixture-key",
    idToken: null,
  });
} finally {
  store.close();
}
