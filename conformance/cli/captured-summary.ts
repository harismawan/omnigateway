// Frozen control oracle: deterministic rival commit after set, before summary.

import "./driver-env.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setKeySmartRouting } from "../../packages/control/src/keys.ts";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const dir = mkdtempSync("/tmp/opencode/captured-summary-");
try {
  const store = await createStore({
    path: join(dir, "db"),
    encryptionKey: await deriveKey("captured-summary-secret"),
  });
  await store.keys.create({
    id: "k",
    label: "before",
    prefix: "p",
    hash: "h",
    modelAllowlist: null,
    limits: {},
    bodyLoggingOptOut: false,
    expiresAt: null,
    guardrailPolicy: null,
    smartRouting: false,
  });
  const original = store.keys.setSmartRouting.bind(store.keys);
  await store.keys.list();
  const db = new Database(join(dir, "db"));
  db.run(
    "INSERT INTO api_keys(id,label,prefix,hash,limits,created_at,model_allowlist) VALUES('bad','bad','b','bad','{}',2,'broken')",
  );
  db.close();
  store.keys.setSmartRouting = async (id, enabled) => {
    await original(id, enabled);
    await original(id, false);
  };
  const result = await setKeySmartRouting(store, "k", { enabled: true }, 100);
  assert.equal(result.smartRouting, true);
  assert.equal((await store.keys.get("k"))?.smartRouting, false);
  store.close();
  console.log("PASS frozen TS captured-summary gate");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
