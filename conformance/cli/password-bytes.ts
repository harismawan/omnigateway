import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

const root = mkdtempSync("/tmp/opencode/e1-e5/password-bytes-");
const prefix = Buffer.from("correct-horse-battery").toString("hex");
const cases = [
  [`${prefix}0a`],
  [`${prefix}c3a97f0a`],
  [`${prefix}e4b8ad7f0a`],
  [`${prefix}f09f98807f0a`],
  [`${prefix}f09f98807f7f0a`],
  [`7f08${prefix}0a`],
  [`${prefix}c3`, "a9", "7f0a"],
  [`${prefix}f09f`, "9880", "7f0a"],
  [`${prefix}fffe0a`],
  [`${prefix}e080800a`],
  [`${prefix}c3`, "280a"],
  [`${prefix}00010409161b0a`],
  [`efbbbf${prefix}0a`],
  [`${prefix}c30a`],
  [`${prefix}c3`, `e4`, `b8ad0a`],
  [`${prefix}020506070b0c0e0f1011121314151718191a1c1d1e1f0a`],
  ["03"],
];
let count = 0;
for (const parts of cases) {
  const results = [];
  let tsHash = "";
  for (const rust of [false, true]) {
    const dbpath = join(root, rust ? "rust.db" : "ts.db");
    const cmd = rust
      ? [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]
      : ["bun", "--no-env-file", resolve("conformance/cli/password-reader-seam.ts")];
    const p = Bun.spawn(
      [
        Bun.which("python3") ?? "python3",
        resolve("conformance/cli/password-bytes.py"),
        JSON.stringify(parts),
        ...cmd,
        "--root",
        root,
        "--db",
        dbpath,
        "admin",
        "set-password",
      ],
      {
        env: {
          ...process.env,
          OMNI_ENCRYPTION_KEY: "password-golden-secret",
          READER_RUST: rust ? "1" : "0",
          ...(rust && process.env.READER_NO_PATH === "1" ? { PATH: "/nonexistent" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = JSON.parse(await new Response(p.stdout).text());
    assert.equal(await new Response(p.stderr).text(), "");
    assert.equal(await p.exited, 0);
    const db = new Database(dbpath);
    const row = db.query("SELECT value FROM settings WHERE key='adminPasswordHash'").get() as {
      value: string;
    } | null;
    db.close();
    // Compare hashes by checking both against the independently decoded TS input.
    let line = "";
    const decoder = new TextDecoder();
    for (const part of parts) {
      for (const c of decoder.decode(Buffer.from(part, "hex"), { stream: true })) {
        if (c === "\n" || c === "\r" || c === "\x03") break;
        if (c === "\x7f" || c === "\b") line = line.slice(0, -1);
        else line += c;
      }
    }
    if (result.code === 0) {
      assert(row);
      assert(await Bun.password.verify(line.trim(), row.value));
      if (!rust) tsHash = row.value;
    }
    if (rust) assert(result.restored, "terminal restored");
    results.push({ bytes: result.bytes, code: result.code, raw: result.raw });
  }
  await Bun.write(join(root, `${count}.json`), JSON.stringify({ parts, results, tsHash }));
  assert.deepEqual(results[1], results[0]);
  count++;
}
console.log(`PASS ${count} streaming UTF8/UTF16/control/terminal comparisons (${root})`);
