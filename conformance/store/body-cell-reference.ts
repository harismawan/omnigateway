// Independent frozen repository + control operation, reading the Rust fixture's
// actual database and ciphertext (never Rust-decoded metadata).
import { Database } from "bun:sqlite";
import { readRequestBody } from "../../packages/control/src/bodies.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
import { createBodyRepo } from "../../packages/store/src/sqlite/bodies.ts";

const [path, dir, id] = Bun.argv.slice(2);
if (!path || !dir || id === undefined)
  throw Error("database, body directory and request ID required");
const db = new Database(path);
try {
  const bodies = createBodyRepo(db, await deriveKey("body-cells"), dir);
  // The frozen body reader only uses this repo from the full store.
  console.log(
    JSON.stringify(await readRequestBody({ bodies } as Parameters<typeof readRequestBody>[0], id)),
  );
} catch {
  console.log('{"error":{"code":"INTERNAL","message":"internal error"}}');
} finally {
  db.close();
}
