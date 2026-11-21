import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { databaseState } from "./database-state.ts";
import { fileState, frozenPostState } from "./db-file-state.ts";
import { goldenSpawn } from "./exit-gate.ts";

export async function adapterCases(
  commands: string[][],
  seed: string,
  env: Record<string, string | undefined>,
  operation: "backup" | "restore",
) {
  const root = mkdtempSync("/tmp/opencode/e1-e5/db-adapter-");
  const dir = join(root, "snapshots"),
    id = "db_2000-01-01T00-00-00-000Z_manual.sqlite";
  let count = 0;
  try {
    mkdirSync(join(root, "request_bodies"));
    writeFileSync(join(root, "request_bodies/sentinel"), "body sentinel");
    for (const kind of operation === "backup"
      ? ["inaccessible", "unreadable", "directory"]
      : ["inaccessible", "loop", "long"]) {
      const results = [];
      for (const cmd of commands) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        for (const s of ["", "-wal", "-shm"]) rmSync(join(root, "db") + s, { force: true });
        copyFileSync(seed, join(root, "db"));
        const input = kind === "long" ? id.replace("manual", "a".repeat(300)) : id;
        if (kind === "directory") mkdirSync(join(dir, id));
        else if (kind === "loop") symlinkSync(id, join(dir, id));
        else writeFileSync(join(dir, id), "retention sentinel");
        const mode = kind === "unreadable" ? 0o300 : kind === "inaccessible" ? 0 : 0o700;
        const run = async (args: string[]) => {
          const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", ...args], {
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          return {
            out: await new Response(p.stdout).text(),
            err: await new Response(p.stderr).text(),
            code: await p.exited,
          };
        };
        chmodSync(dir, 0o700);
        const before = fileState(root);
        chmodSync(dir, mode);
        let listing: Awaited<ReturnType<typeof run>>, result: Awaited<ReturnType<typeof run>>;
        try {
          listing = await run(["snapshots", "--json"]);
          result = await run(operation === "backup" ? ["backup", "--json"] : ["restore", input]);
        } finally {
          assert.equal(statSync(dir).mode & 0o7777, mode);
          chmodSync(dir, 0o700);
        }
        assert.equal(listing.code, 0, kind);
        if (kind === "directory") {
          assert.equal(result.code, 1);
          assert.equal(
            result.err,
            `Path is a directory: rm returned EISDIR (is a directory) ${join(dir, id)}\n`,
          );
          assert.equal(readdirSync(dir).length, 2);
        } else if (operation === "backup" && kind === "inaccessible") {
          assert.equal(result.code, 1);
          result.err = result.err.replace(/db_\d{4}-[^/']+_manual\.sqlite/g, "<snapshot>");
          assert.equal(result.err, `EACCES: permission denied, rm '${join(dir, "<snapshot>")}'\n`);
        } else if (operation === "backup") {
          assert.equal(result.code, 0, kind);
          const data = JSON.parse(result.out);
          assert.equal(readFileSync(join(dir, id), "utf8"), "retention sentinel");
          assert.equal(readdirSync(dir).length, 2);
          assert(readFileSync(join(dir, data.id)).length > 0);
          data.id = data.filename = "<id>";
          data.createdAt = "<time>";
          result.out = JSON.stringify(data);
        } else {
          assert.deepEqual(fileState(root), before, kind);
          assert.equal(result.code, 1, kind);
          assert.match(result.err, /BAD_REQUEST: no such snapshot/, kind);
        }
        const post = frozenPostState(root);
        const fresh = readdirSync(dir).filter((name) => name !== id);
        const tables = fresh.map((name) => {
          const db = new Database(join(dir, name), { readonly: true });
          try {
            return databaseState(db);
          } finally {
            db.close();
          }
        });
        for (const entry of post)
          if (fresh.some((name) => entry.path === `snapshots/${name}`))
            entry.path = "snapshots/<new snapshot>";
        results.push({ listing, result, post, tables });
      }
      if (operation === "backup" && kind !== "inaccessible") {
        const a = results[0].post.find((e) => e.path === "snapshots/<new snapshot>")!.bytes!;
        const b = results[1].post.find((e) => e.path === "snapshots/<new snapshot>")!.bytes!;
        const offsets = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i).filter(
          (i) => a[i] !== b[i],
        );
        console.log(
          `${kind}: snapshots/<new snapshot> differing offsets ${JSON.stringify(offsets)}; TS=${JSON.stringify(offsets.map((i) => a[i]))}; Rust=${JSON.stringify(offsets.map((i) => b[i]))}`,
        );
        assert.deepEqual(
          results[1].tables,
          results[0].tables,
          "new snapshot contents table by table",
        );
        assert(
          offsets.every((i) => i >= 96 && i < 100),
          "only SQLite writer-version bytes may differ",
        );
        a.fill(0, 96, 100);
        b.fill(0, 96, 100);
      }
      assert.deepEqual(results[1], results[0], kind);
      count++;
    }
  } finally {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
  return count;
}
