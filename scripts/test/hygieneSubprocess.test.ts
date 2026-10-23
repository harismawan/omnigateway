import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omni hygiene "));
  roots.push(root);
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  for (const file of [
    "dead-exports.ts",
    "stale-claims.ts",
    "lib/history.ts",
    "lib/tree.ts",
    "lib/subprocess.ts",
  ]) {
    copyFileSync(join(import.meta.dir, "..", file), join(root, "scripts", file));
  }
  mkdirSync(join(root, "packages/providers/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/providers/src/descriptors.ts"),
    "export const descriptors = {};\n",
  );
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/value.ts"), "export function vanishedWidget() { return 1; }\n");
  writeFileSync(join(root, "src/consumer.ts"), "// `vanishedWidget` supplies the widget.\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "hygiene@test.invalid");
  git(root, "config", "user.name", "Hygiene Test");
  git(root, "add", "src", "packages");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "topic");
  git(root, "commit", "--allow-empty", "-qm", "topic");
  return root;
}

function run(root: string, script: string) {
  return Bun.spawnSync([process.execPath, join(root, "scripts", `${script}.ts`)], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hygiene CLI git subprocesses", () => {
  test("dead exports still reports an unreferenced changed export", () => {
    const root = scratch();
    writeFileSync(join(root, "src/value.ts"), "export function unusedWidget() { return 2; }\n");
    const result = run(root, "dead-exports");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unusedWidget");
  });

  test("stale claims still reports a removed symbol in an uncommitted deletion", () => {
    const root = scratch();
    unlinkSync(join(root, "src/value.ts"));
    const result = run(root, "stale-claims");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("vanishedWidget");
  });

  test("an added path absent from the base is skipped without git stderr noise", () => {
    const root = scratch();
    writeFileSync(join(root, "src/new widget.ts"), "export const newWidget = 1;\n");
    git(root, "add", "-N", "src/new widget.ts");
    const result = run(root, "stale-claims");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("0 removed symbols checked");
    expect(result.stderr.toString()).toBe("");
  });

  test("a missing base blob retains the legacy skipped outcome", () => {
    const root = scratch();
    const blob = git(root, "rev-parse", "main:src/value.ts").trim();
    unlinkSync(join(root, "src/value.ts"));
    rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const result = run(root, "stale-claims");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("no stale claims (0 removed symbols checked)");
  });

  test("a renamed destination absent from the base is not treated as git corruption", () => {
    const root = scratch();
    git(root, "mv", "src/value.ts", "src/renamed value.ts");
    const result = run(root, "stale-claims");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("0 removed symbols checked");
    expect(result.stderr.toString()).toBe("");
  });
});
