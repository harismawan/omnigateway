/**
 * The working-tree reads both hygiene checks are built on.
 *
 * Neither property can be observed in the developing checkout: it has no
 * tracked-but-missing file, and any uncommitted edit it does have is one the
 * old commit-to-commit form would also have missed without anyone noticing,
 * because "no findings" is what a clean tree reports too. Both defects survived
 * in `stale-claims.ts` for two commits while the fix and its explanation sat in
 * the sibling — so the properties are asserted here, once, against repositories
 * this file builds.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSources, readable } from "../lib/tree.ts";

const roots: string[] = [];

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omni-tree-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "tree@test.invalid");
  git(root, "config", "user.name", "Tree Test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "notes.md"), "# notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("what the hygiene checks read", () => {
  test("a clean tree reports nothing changed", () => {
    // The control. Every assertion below is "this file is listed", and a diff
    // that lists everything satisfies all of them.
    const root = scratch();
    expect(changedSources(root, "HEAD")).toEqual([]);
  });

  test("an uncommitted edit is listed", () => {
    // The defect. `${base}..HEAD` compares commit to commit, so this file was
    // invisible — and a check blind to uncommitted work is blind at the only
    // moment its finding is still free to act on.
    const root = scratch();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    expect(changedSources(root, "HEAD")).toEqual(["src/a.ts"]);
  });

  test("an uncommitted deletion is listed", () => {
    // The shape that matters most to `stale-claims`: a symbol is removed by
    // deleting the file that declared it, and the comment claiming the symbol
    // lives somewhere else entirely.
    const root = scratch();
    unlinkSync(join(root, "src", "a.ts"));
    expect(changedSources(root, "HEAD")).toEqual(["src/a.ts"]);
  });

  test("non-TypeScript files are not listed", () => {
    // The other direction: a diff wide enough to list anything would satisfy
    // the two tests above while handing both checks files they cannot parse.
    const root = scratch();
    writeFileSync(join(root, "src", "notes.md"), "# edited\n");
    expect(changedSources(root, "HEAD")).toEqual([]);
  });

  test("a file that exists is read back", () => {
    const root = scratch();
    expect(readable(root, "src/a.ts")).toBe("export const a = 1;\n");
  });

  test("a tracked file that is not on disk yields undefined, not a throw", () => {
    // `git ls-files` lists the index, and the index outlives a deletion. An
    // uncaught ENOENT here killed the whole check on an ordinary mid-rebase
    // tree. `?? ""` at the call site then reads the absence as "declares
    // nothing", which is what a deleted file does declare.
    const root = scratch();
    unlinkSync(join(root, "src", "a.ts"));
    expect(git(root, "ls-files").split("\n")).toContain("src/a.ts");
    expect(readable(root, "src/a.ts")).toBeUndefined();
  });

  test("an intent-to-add entry whose file has gone yields undefined", () => {
    // The state the probe that found this was actually in: `git add -N` puts a
    // path in the index before the file is final, and removing it afterwards
    // leaves the index pointing at nothing.
    const root = scratch();
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    git(root, "add", "-N", "src/b.ts");
    unlinkSync(join(root, "src", "b.ts"));
    expect(readable(root, "src/b.ts")).toBeUndefined();
  });
});
