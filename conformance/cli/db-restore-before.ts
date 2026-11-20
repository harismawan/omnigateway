import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { frozenPostState, restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const base = mkdtempSync("/tmp/opencode/e1-e5/db14-before-");
const id = "db_2026-11-01T00-00-00-000Z_manual.sqlite";
const commands = [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")]];
if (process.argv.includes("--compare"))
  commands.push([resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]);
try {
  const seed = join(base, "seed");
  const store = await createStore({
    path: seed,
    encryptionKey: await deriveKey("database-golden-secret"),
  });
  store.close();
  for (const kind of [
    "snapshots-readonly",
    "candidate-removed",
    "candidate-replaced",
    "live-dir-readonly",
  ]) {
    const results = [];
    for (const [index, command] of commands.entries()) {
      const root = join(base, `${kind}-${index}`),
        snapshots = join(root, "snapshots"),
        live = join(root, "db"),
        candidate = join(snapshots, id);
      mkdirSync(snapshots, { recursive: true });
      copyFileSync(seed, live);
      copyFileSync(seed, candidate);
      const replacement = join(root, "replacement");
      copyFileSync(seed, replacement);
      const db = new Database(replacement);
      db.run("INSERT INTO settings (key,value) VALUES ('replacement','installed')");
      db.close();
      const mutation =
        kind === "candidate-removed"
          ? "remove"
          : kind === "candidate-replaced"
            ? "replace"
            : "readonly";
      const target = kind.startsWith("candidate-")
        ? candidate
        : kind === "snapshots-readonly"
          ? snapshots
          : root;
      const args = [
        "python3",
        resolve("conformance/cli/pty.py"),
        "y",
        ...command,
        "--root",
        root,
        "--db",
        "db",
        "db",
        "restore",
        id,
        "--json",
      ];
      const p = goldenSpawn(args, {
        env: {
          ...process.env,
          HOME: root,
          XDG_STATE_HOME: join(root, "state"),
          OMNI_ENCRYPTION_KEY: "database-golden-secret",
          PTY_NO_COLOR: "1",
          PTY_STDOUT_PIPE: "1",
          PTY_RESTORE_MUTATION: mutation,
          PTY_RESTORE_TARGET: target,
          PTY_RESTORE_SOURCE: replacement,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [text, stderr] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      await p.exited;
      assert.equal(stderr, "");
      const nested = JSON.parse(text);
      let out = Buffer.from(nested.stdout, "hex").toString(),
        err = Buffer.from(nested.bytes, "hex").toString();
      const code = nested.code;
      assert.equal(code, kind === "candidate-replaced" ? 0 : 1, err);
      const undos = readdirSync(snapshots).filter((n) => n.endsWith("_preRestore.sqlite"));
      if (kind === "candidate-removed") {
        assert(err.includes("no such snapshot"));
        assert.equal(undos.length, 0);
      }
      if (kind === "snapshots-readonly") assert.equal(undos.length, 0);
      const state = undos.length ? restorePostState(root, undos[0]) : frozenPostState(root);
      chmodSync(root, 0o755);
      chmodSync(snapshots, 0o755);
      if (kind === "candidate-replaced") {
        const data = JSON.parse(out);
        assert.equal(data.counts.settings, 1, "second inspection sees replacement");
        const installed = new Database(live, { readonly: true });
        assert.equal(
          installed.query("SELECT value FROM settings WHERE key='replacement'").get().value,
          "installed",
        );
        installed.close();
        data.preRestoreSnapshot.id = data.preRestoreSnapshot.filename = "<undo>";
        data.preRestoreSnapshot.createdAt = "<time>";
        out = JSON.stringify(data);
      }
      err = err
        .replaceAll(root, "<root>")
        .replace(/db_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_preRestore\.sqlite/g, "<undo>");
      results.push({ out, err, code, state });
      console.log(
        `${kind} ${index === 0 ? "TS" : "Rust"}: exit=${code}, undos=${undos.length}, stderr=${JSON.stringify(err)}`,
      );
    }
    if (results.length === 2) assert.deepEqual(results[1], results[0], kind);
  }
  await verifyGoldenExits("db-restore-before");
  console.log("PASS 4 pre-rename comparisons");
} finally {
  for (const name of readdirSync(base)) {
    try {
      chmodSync(join(base, name), 0o755);
      chmodSync(join(base, name, "snapshots"), 0o755);
    } catch {}
  }
  rmSync(base, { recursive: true, force: true });
}
