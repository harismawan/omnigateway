#!/usr/bin/env bun
/** Boot sweep + ten-second heartbeat. Frozen has no hourly-sweep trigger. */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../../packages/store/src/sqlite/db.ts";

const { values } = parseArgs({ options: { ts: { type: "string" }, rust: { type: "string" } } });
if (!values.ts || !values.rust) throw new Error("--ts and --rust required");
const work = mkdtempSync("/tmp/opencode/a11/maintenance-");
const results: unknown[] = [];
for (const [name, binary] of [["ts", values.ts], ["rust", values.rust]]) {
  const root = join(work, name!);
  mkdirSync(root);
  const path = join(root, "omni.db");
  const seed = openDb(path);
  seed.run("INSERT INTO request_logs(id,at,requested_model,status,duration_ms,state,node_id) VALUES ('dead',1000,'model',0,0,'pending','dead-node')");
  seed.run(`UPDATE request_logs SET rtk_applied=1,rtk_filter_hits=2,rtk_original_code_units=30,rtk_compressed_code_units=10,rtk_estimated_tokens_saved=5,rtk_filters='["grep"]'`);
  seed.close();
  const env = { PATH: process.env.PATH!, HOME: root, OMNI_ROOT: root,
    OMNI_DB_PATH: path, OMNI_ENCRYPTION_KEY: "maintenance-conformance-0123456789",
    OMNI_HOST: "127.0.0.1", OMNI_PORT: "18561", OMNI_LOG_LEVEL: "debug" };
  const child = Bun.spawn([resolve(binary!)], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 20_000;
    let first: number | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}`);
      const db = new Database(path, { readonly: true });
      const seen = db.query<{ seen_at: number }, []>("SELECT seen_at FROM nodes WHERE id != 'dead-node'").get()?.seen_at;
      db.close();
      if (seen !== undefined) {
        first ??= seen;
        if (seen > first) break;
      }
      await Bun.sleep(100);
    }
    const db = new Database(path, { readonly: true });
    const seen = db.query<{ seen_at: number }, []>("SELECT seen_at FROM nodes WHERE id != 'dead-node'").get()?.seen_at;
    if (seen === undefined || first === undefined || seen <= first) throw new Error(`${name}: no periodic heartbeat`);
    const tables: Record<string, unknown> = {};
    for (const table of ["request_logs", "usage_daily", "usage_rollup"]) {
      tables[table] = db.query(`SELECT * FROM ${table} ORDER BY 1,2`).values().map(row => row.map(v => v === null ? ["null"] : [typeof v, v]));
    }
    results.push(tables);
    db.close();
  } finally {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    await child.exited;
    clearTimeout(timeout);
    writeFileSync(join(root, "stdout.log"), await stdout);
    writeFileSync(join(root, "stderr.log"), await stderr);
  }
}
if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new Error(`typed tables differ: ${JSON.stringify(results)}`);
console.log("PASS: boot dead-node retirement, 3 typed tables, both periodic heartbeats; hourly sweep not externally triggerable");
