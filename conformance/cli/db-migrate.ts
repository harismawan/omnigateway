import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { frozenPostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const base = mkdtempSync("/tmp/opencode/e1-e5/db21-migrate-"),
  root = join(base, "root");
const sqlDir = resolve("packages/store/src/sqlite/migrations"),
  sqls = readdirSync(sqlDir)
    .sort()
    .map((n) => readFileSync(join(sqlDir, n), "utf8"));
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let failures = 0,
  count = 0;
const cases = [
  ...Array.from({ length: 21 }, (_, i) => `schema-${i}`),
  "new",
  "human",
  "settings-missing",
  "ledger-malformed",
  "schema-malformed",
  "not-db",
  "missing-key",
  "invalid-config",
  "directory",
  "broken-link",
  "symlink",
  "running",
  "bad-to",
  "running-to",
  "prompt-to",
  "decline-to",
  "argv-equals",
  "argv-extra",
  "argv-unknown",
  "argv-missing",
];
try {
  for (const kind of cases) {
    const results = [];
    for (const cmd of commands) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      const path = join(root, "db"),
        env: Record<string, string | undefined> = {
          ...process.env,
          HOME: root,
          XDG_STATE_HOME: join(root, "state"),
          NO_COLOR: "1",
          OMNI_ENCRYPTION_KEY: "database-golden-secret",
          OMNI_DAY_OFFSET_MINUTES: "0",
        };
      const prefix =
        kind.startsWith("schema-") && kind !== "schema-malformed" ? Number(kind.slice(7)) : 20;
      const fresh = ["new", "human", "broken-link"].includes(kind);
      if (!fresh) {
        const db = new Database(path);
        db.run("PRAGMA journal_mode=WAL");
        db.run("CREATE TABLE migrations(id INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)");
        for (let i = 0; i < prefix; i++) {
          db.run(sqls[i]);
          db.run("INSERT INTO migrations VALUES (?,1)", [i + 1]);
        }
        if (prefix > 0) {
          db.run(
            "INSERT INTO credentials(id,provider,label,auth_type,api_key,created_at,updated_at) VALUES('cred','p','retained','api_key','opaque encrypted bytes',1,1)",
          );
          db.run("INSERT INTO settings VALUES ('fixture','retained')");
        }
        if (kind === "settings-missing") db.run("DROP TABLE settings");
        if (kind === "ledger-malformed")
          db.run("DROP TABLE migrations;CREATE TABLE migrations(wrong)");
        if (kind === "schema-malformed") db.run("DELETE FROM migrations WHERE id=20");
        db.close();
      }
      if (kind === "not-db") writeFileSync(path, "not sqlite");
      if (kind === "directory") {
        rmSync(path);
        mkdirSync(path);
      }
      if (kind === "broken-link") symlinkSync("target", path);
      if (kind === "symlink") {
        const bytes = readFileSync(path);
        rmSync(path);
        writeFileSync(join(root, "target"), bytes);
        symlinkSync("target", path);
      }
      if (kind === "missing-key") delete env.OMNI_ENCRYPTION_KEY;
      if (kind === "invalid-config") env.OMNI_PORT = "invalid";
      if (kind === "running" || kind === "running-to") {
        mkdirSync(join(root, "state/omnigateway"), { recursive: true });
        writeFileSync(join(root, "state/omnigateway/gateway.pid"), String(process.pid));
      }
      let args = [
        "--root",
        root,
        "--db",
        "db",
        "db",
        "migrate",
        ...(kind === "human" ? [] : ["--json"]),
      ];
      if (kind.endsWith("-to"))
        args.push(
          "--to",
          kind === "bad-to" ? "mysql://localhost" : "postgres://user:secret@localhost/db",
        );
      if (kind === "argv-equals") args = ["db", "migrate", `--root=${root}`, "--db=db", "--json"];
      if (kind === "argv-extra") args.push("ignored");
      if (kind === "argv-unknown") args.push("--wat");
      if (kind === "argv-missing") args.push("--to");
      const start = Date.now();
      const p = goldenSpawn(
        kind === "decline-to"
          ? ["python3", resolve("conformance/cli/pty.py"), "n", ...cmd, ...args]
          : [...cmd, ...args],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      let [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      const end = Date.now();
      if (kind === "decline-to") {
        assert.equal(err, "");
        const nested = JSON.parse(out);
        out = "";
        err = Buffer.from(nested.bytes, "hex").toString();
        code = nested.code;
      }
      const state = frozenPostState(root);
      if (code === 0) {
        const db = new Database(path, { readonly: true });
        const ledger = db.query("SELECT * FROM migrations ORDER BY id").all() as {
          id: number;
          applied_at: number;
        }[];
        assert.equal(ledger.length, 20);
        if (!fresh && prefix > 0) {
          assert.equal(
            db.query("SELECT api_key FROM credentials").get().api_key,
            "opaque encrypted bytes",
          );
          assert.equal(
            db.query("SELECT value FROM settings WHERE key='fixture'").get().value,
            "retained",
          );
        }
        const pageNo = db.query("SELECT rootpage FROM sqlite_master WHERE name='migrations'").get()
          .rootpage as number;
        db.close();
        const bytes = state.find(
          (e) => e.path === (kind === "symlink" || kind === "broken-link" ? "target" : "db"),
        )!.bytes!;
        bytes.fill(0, 96, 100);
        const page = (pageNo - 1) * (bytes.readUInt16BE(16) || 65536),
          header = page + (pageNo === 1 ? 100 : 0);
        const varint = (at: number): [number, number] => {
          let v = 0;
          for (let n = 0; n < 8; n++) {
            const b = bytes[at++];
            v = v * 128 + (b & 127);
            if (b < 128) return [v, at];
          }
          return [v * 256 + bytes[at], at + 1];
        };
        assert.equal(bytes[header], 13);
        // Normalize only proven clock cells, using the existing generation suite's
        // table-leaf decoder and invocation-window assertion, never whole pages.
        for (let i = 0; i < bytes.readUInt16BE(header + 3); i++) {
          const [len, next] = varint(page + bytes.readUInt16BE(header + 8 + i * 2)),
            [id, record] = varint(next);
          if (!fresh && id <= prefix) continue;
          const row = ledger.find((r) => r.id === id)!;
          assert(row.applied_at >= start && row.applied_at <= end);
          const [hlen, s] = varint(record),
            [idType, t] = varint(s),
            [timeType, last] = varint(t);
          assert.equal(idType, 0);
          assert.equal(timeType, 5);
          assert.equal(last, record + hlen);
          assert.equal(len, hlen + 6);
          assert.equal(bytes.readIntBE(record + hlen, 6), row.applied_at);
          bytes.writeIntBE(0, record + hlen, 6);
        }
        if (kind !== "human") assert.deepEqual(JSON.parse(out), { path, created: fresh });
        else assert.equal(out, `database  ${path}\nschema    created\n`);
      }
      results.push({ out, err, code, state });
    }
    try {
      assert.deepEqual(results[1], results[0]);
      console.log(`PASS ${kind} exit=${results[0].code}`);
    } catch (e) {
      failures++;
      console.log(
        `FAILED ${kind}`,
        results.map(({ state, ...r }) => r),
      );
    }
    count++;
  }
  await verifyGoldenExits("db-migrate");
  console.log(`${count} comparisons; ${failures} failed`);
  assert.equal(failures, 0);
} finally {
  rmSync(base, { recursive: true, force: true });
}
