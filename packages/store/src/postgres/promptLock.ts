import type { Conn } from "./db.ts";

/** Always before settings/key/parent writes and their config-version triggers. */
export async function lockPromptManagement(conn: Conn): Promise<void> {
  await conn.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", ["omni:prompt-management"]);
}
