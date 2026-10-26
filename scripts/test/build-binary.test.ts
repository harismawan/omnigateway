import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function compile(root: string, entry: string, outfile: string): Bun.SyncSubprocess {
  return Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { buildBinary } = await import(${JSON.stringify(join(repoRoot, "scripts/build-binary.ts"))});
       await buildBinary([${JSON.stringify(entry)}], ${JSON.stringify(outfile)}, ${JSON.stringify(root)});`,
    ],
    { cwd: repoRoot },
  );
}

test("binary executes standalone without autoloading dotenv or bunfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-binary-"));
  dirs.push(dir);
  const outfile = join(dir, "nested", "fixture");
  writeFileSync(
    join(dir, "entry.ts"),
    `console.log(process.env.OMNI_BUILD_FIXTURE ?? "isolated");`,
  );
  const build = compile(dir, "entry.ts", outfile);
  expect(build.exitCode === 0 ? "" : (build.stderr?.toString() ?? "build failed")).toBe("");
  expect(readFileSync(outfile).subarray(0, 2).toString()).not.toBe("#!");

  writeFileSync(join(dir, ".env"), "OMNI_BUILD_FIXTURE=dotenv-loaded\n");
  writeFileSync(join(dir, "bunfig.toml"), "[invalid toml\n");
  const run = Bun.spawnSync([outfile], {
    cwd: dir,
    env: { ...process.env, PATH: "", OMNI_BUILD_FIXTURE: undefined },
  });
  expect(run.exitCode === 0 ? "" : run.stderr.toString()).toBe("");
  expect(run.stdout.toString().trim()).toBe("isolated");

  const configured = Bun.spawnSync([outfile], {
    cwd: dir,
    env: { ...process.env, PATH: "", OMNI_BUILD_FIXTURE: "explicit-env" },
  });
  expect(configured.exitCode).toBe(0);
  expect(configured.stdout.toString().trim()).toBe("explicit-env");
}, 30_000);

test("binary build fails when its entrypoint is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-binary-missing-"));
  dirs.push(dir);
  const build = compile(dir, "missing.ts", join(dir, "fixture"));
  expect(build.exitCode).not.toBe(0);
  expect(build.stderr?.toString()).toContain("missing.ts");
});

/**
 * The compiled gateway carries its export worker and can start it.
 *
 * `new Worker(url)` is not an import, so `--compile` embeds the worker only
 * when it is a second entrypoint, and the server only finds it at the path
 * `OMNI_EXPORT_WORKER` names inside the executable. Built through the same
 * `buildGatewayBinary` the release and the Docker image run, with a probe in
 * place of the server that spawns the worker the way the server does, and
 * run from another directory, so nothing on disk can stand in for it.
 */
test("the gateway binary can start its export worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-binary-export-"));
  dirs.push(dir);
  const outfile = join(dir, "gateway");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { buildGatewayBinary } = await import(${JSON.stringify(join(repoRoot, "scripts/build-binary.ts"))});
       await buildGatewayBinary(${JSON.stringify(outfile)}, ${JSON.stringify(repoRoot)}, "apps/gateway/test/fixtures/export/workerProbe.ts");`,
    ],
    { cwd: repoRoot },
  );
  expect(build.exitCode === 0 ? "" : (build.stderr?.toString() ?? "build failed")).toBe("");
  const run = Bun.spawnSync([outfile, join(dir, "omnigateway.db")], { cwd: dir });
  expect(run.stdout.toString().trim()).toBe(
    JSON.stringify({ type: "previewResult", ref: "probe", ok: false, error: "no such request" }),
  );
}, 60_000);
