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
