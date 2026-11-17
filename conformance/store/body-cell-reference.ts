// Independent frozen repository + control operation, reading the Rust fixture's
// actual database and ciphertext (never Rust-decoded metadata).
import { Database } from "bun:sqlite";
import { createBodyRepo } from "../../packages/store/src/sqlite/bodies.ts";
import { readRequestBody } from "../../packages/control/src/bodies.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
const [path, dir, id] = Bun.argv.slice(2);
const db = new Database(path!);
try {
  const bodies = createBodyRepo(db, await deriveKey("body-cells"), dir!);
  console.log(JSON.stringify(await readRequestBody({ bodies } as any, id!)));
} catch {
  console.log('{"error":{"code":"INTERNAL","message":"internal error"}}');
} finally { db.close(); }
