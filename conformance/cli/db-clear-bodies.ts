import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { databaseState } from "./database-state.ts";
import { fileState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/db3-clear-");
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1" };
const store = await createStore({
  path: join(root, "seed"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
try {
  for (const kind of [
    "inaccessible",
    "absolute",
    "parent",
    "symlink",
    "pipe",
    "n",
    "empty",
    "bad",
    "zero",
    "rows",
    "orphans",
    "unremovable",
    "yes",
    "future",
  ]) {
    const results = [];
    for (const cmd of commands) {
      for (const s of ["", "-wal", "-shm"]) rmSync(join(root, `db${s}`), { force: true });
      rmSync(join(root, "request_bodies"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      mkdirSync(join(root, "request_bodies", "aa"), { recursive: true });
      if (kind !== "zero")
        writeFileSync(join(root, "request_bodies", "aa", "body"), "body sentinel");
      const db = new Database(join(root, "db"));
      if (!["inaccessible", "zero", "orphans"].includes(kind))
        db.run(
          "INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,detail_state,truncated) VALUES ('old',1,'aa/body',13,'ready',0)",
        );
      if (kind === "future") db.run("UPDATE request_bodies SET at = 8000000000000");
      mkdirSync(join(root, "outside-dir"), { recursive: true });
      const outside = join(root, "outside-dir", "outside");
      writeFileSync(outside, "outside sentinel");
      if (["absolute", "parent", "symlink"].includes(kind)) {
        rmSync(join(root, "request_bodies", "aa", "body"));
        if (kind === "symlink")
          symlinkSync(join(root, "outside-dir"), join(root, "request_bodies", "link"));
        db.run("UPDATE request_bodies SET rel_path = ?", [
          kind === "absolute"
            ? outside
            : kind === "parent"
              ? "../outside-dir/outside"
              : "link/outside",
        ]);
      }
      db.close();
      const state = () => ({
        db: ["", "-wal", "-shm"].map((s) => {
          try {
            return readFileSync(join(root, `db${s}`));
          } catch (e) {
            if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
            throw e;
          }
        }),
        files: readdirSync(join(root, "request_bodies"), { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => [e.name, readFileSync(join(e.parentPath, e.name))]),
      });
      mkdirSync(join(root, "snapshots"), { recursive: true });
      writeFileSync(join(root, "snapshots", "sentinel"), "snapshot sentinel");
      const before = state();
      const beforeState = fileState(root, true);
      const refusal = ["pipe", "n", "empty", "bad"].includes(kind);
      if (kind === "unremovable") chmodSync(join(root, "request_bodies", "aa"), 0o500);
      if (kind === "inaccessible") chmodSync(join(root, "request_bodies", "aa"), 0);
      const tty = ["n", "empty", "yes"].includes(kind);
      const args = [
        ...cmd,
        "--root",
        root,
        "--db",
        "db",
        "db",
        "clear-bodies",
        ...(!tty && kind !== "pipe" ? ["--yes"] : []),
        ...(["zero", "orphans", "unremovable"].includes(kind) ? ["--json"] : []),
      ];
      const p = goldenSpawn(
        tty
          ? [
              "python3",
              resolve("conformance/cli/pty.py"),
              kind === "empty" ? "" : kind === "yes" ? " YeS " : "n",
              ...args,
            ]
          : args,
        {
          env: {
            ...env,
            PTY_NO_COLOR: "1",
            ...(kind === "bad" ? { OMNI_ENCRYPTION_KEY: "short" } : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      let code = await p.exited;
      if (kind === "inaccessible") chmodSync(join(root, "request_bodies", "aa"), 0o700);
      if (tty) {
        const nested = JSON.parse(out);
        out = Buffer.from(nested.bytes, "hex").toString();
        code = nested.code;
      }
      assert.equal(code, refusal ? 1 : 0);
      if (refusal) assert.deepEqual(fileState(root, true), beforeState);
      assert.equal(
        existsSync(outside),
        !["parent", "symlink"].includes(kind),
        `${kind}: outside sentinel`,
      );
      if (kind === "unremovable") {
        assert.deepEqual(state().files, before.files);
        chmodSync(join(root, "request_bodies", "aa"), 0o700);
      }
      if (!refusal) {
        const removed = ["inaccessible", "zero", "orphans", "future"].includes(kind) ? 0 : 1;
        const orphans = ["orphans", "unremovable"].includes(kind) ? 1 : 0;
        if (["zero", "orphans", "unremovable"].includes(kind))
          assert.deepEqual(JSON.parse(out), { removed, orphans });
        else assert(out.includes(`removed                 ${removed}`));
        assert.equal(
          state().files.length,
          ["inaccessible", "unremovable", "future"].includes(kind) ? 1 : 0,
        );
      }
      const check = new Database(join(root, "db"));
      const tables = databaseState(check);
      check.close();
      results.push({ out, err, code, tables, files: state().files });
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  await verifyGoldenExits("db-clear-bodies");
  console.log(`PASS ${count} clear-bodies comparisons`);
} finally {
  try {
    chmodSync(join(root, "request_bodies", "aa"), 0o700);
  } catch {}
  rmSync(root, { recursive: true, force: true });
}
