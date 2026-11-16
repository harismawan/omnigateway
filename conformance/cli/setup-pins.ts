import "./driver-env.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

// Independent review part1/probe.ts, with assertions on both concrete limits.
const root = mkdtempSync("/tmp/opencode/e1-e5/setup-pins-");
const binary = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
await Bun.write(
  join(root, "manifest.json"),
  JSON.stringify({
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    binary,
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  }),
);
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey("setup-golden-secret"),
});
store.close();
const db = new Database(join(root, "db"));
db.run(
  "INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES ('api','openai','api','apiKey',1,1),('oauth','openai','oauth','oauth',1,1)",
);
db.run("INSERT INTO virtual_models VALUES ('pool', ?, 'weighted', 0)", [
  JSON.stringify([
    { provider: "openai", model: "gpt-6-astra", credentialId: "api", endpointId: "" },
  ]),
]);
for (const [data, expected, enabled, pin, endpoint] of [
  [{}, 922000, 1, "api", ""],
  [{ endpointId: "" }, 272000, 1, "api", ""],
  [{}, 272000, 0, "api", ""],
  [{}, 272000, 1, "missing", ""],
  [{ endpointId: "custom" }, 922000, 1, "api", "custom"],
  [{ endpointId: "other" }, 272000, 1, "api", "custom"],
  [{ endpointId: 42 }, 272000, 1, "api", ""],
] as const) {
  db.run("UPDATE credentials SET enabled=? WHERE id='api'", [enabled]);
  db.run("UPDATE virtual_models SET targets=?", [
    JSON.stringify([
      { provider: "openai", model: "gpt-6-astra", credentialId: pin, endpointId: endpoint },
    ]),
  ]);
  db.run("UPDATE credentials SET provider_data=? WHERE id='api'", [JSON.stringify(data)]);
  const results = [];
  for (const cmd of [
    ["bun", "--no-env-file", resolve("conformance/cli/setup-seam.ts")],
    [binary],
  ]) {
    const p = Bun.spawn(
      [
        "python3",
        resolve("conformance/cli/pty.py"),
        "",
        ...cmd,
        "--root",
        root,
        "--db",
        "db",
        "setup",
        "opencode",
        "--dry-run",
        "--json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          OMNI_ENCRYPTION_KEY: "setup-golden-secret",
          PTY_NO_COLOR: "1",
          PTY_ANSWERS: JSON.stringify(["pool", "", "", "", ""]),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = JSON.parse(await new Response(p.stdout).text());
    assert.equal(await p.exited, 0);
    assert.equal(await new Response(p.stderr).text(), "");
    assert.equal(result.code, 0);
    const output = Buffer.from(result.bytes, "hex").toString();
    await Bun.write(join(root, `${expected}-${results.length}.txt`), output);
    const envelope = JSON.parse(output.slice(output.indexOf("{")));
    const config = JSON.parse(envelope.files[0].contents);
    assert.equal(config.provider.omnigateway.models.pool.limit.context, expected);
    assert.equal(config.provider.omnigateway.models.pool.limit.output, 128000);
    results.push(result);
  }
  assert.deepEqual(results[1], results[0]);
}
db.close();
console.log(`PASS 7 setup pin limit regressions (${root})`);
