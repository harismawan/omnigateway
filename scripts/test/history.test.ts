/**
 * `resolveBase` asked of repositories built here.
 *
 * Every shape below is one the developing checkout cannot produce. This
 * worktree has a local `main` and a HEAD ahead of it, so it exercises exactly
 * the one arrangement that already worked — which is why both CI failures were
 * invisible from it and had to be found by reproducing the checkout shape
 * `actions/checkout` creates. That is the same lesson as
 * `packages/plugin-api/test/changed.test.ts`: an instrument that can only be
 * observed through state it cannot control is observed only where it is right.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBase } from "../lib/history.ts";

const roots: string[] = [];

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A repo with one commit on `main`, then `extra` further commits on top. */
function scratch(extra = 0): string {
  const root = mkdtempSync(join(tmpdir(), "omni-base-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  // Set locally: a machine with no global identity cannot commit, and failing
  // for that reason would read as the resolver breaking.
  git(root, "config", "user.email", "base@test.invalid");
  git(root, "config", "user.name", "Base Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  for (let i = 0; i < extra; i += 1) {
    writeFileSync(join(root, "a.txt"), `one\n${i}\n`);
    git(root, "commit", "-qam", `later ${i}`);
  }
  return root;
}

/** Rename `refs/heads/main` to `refs/remotes/origin/main` and detach, as CI has it. */
function asCheckout(root: string): void {
  const main = git(root, "rev-parse", "main").trim();
  git(root, "update-ref", "refs/remotes/origin/main", main);
  git(root, "checkout", "-q", "--detach", "HEAD"); // idempotent; may already be detached
  git(root, "branch", "-q", "-D", "main");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("which commit the hygiene checks compare against", () => {
  test("a local `main` behind HEAD answers, and is preferred", () => {
    // The developing checkout's own shape, and the only one that ever worked.
    const root = scratch(2);
    const first = git(root, "rev-parse", "HEAD~2").trim();
    // Detached before moving `main`: git refuses to force-update a branch that
    // a worktree has checked out.
    git(root, "checkout", "-q", "--detach", "HEAD");
    git(root, "branch", "-qf", "main", first);
    expect(resolveBase(root, "check")).toEqual({ base: first, via: "main" });
  });

  test("`origin/main` answers when there is no local `main`", () => {
    // What `actions/checkout` produces on a `pull_request` event. Before this,
    // `rev-parse --verify main` exited 128 here and the check exited 2 on every
    // pull request — while printing an instruction that was already in effect.
    const root = scratch(2);
    const first = git(root, "rev-parse", "HEAD~2").trim();
    git(root, "checkout", "-q", "--detach", "HEAD");
    git(root, "branch", "-qf", "main", first);
    asCheckout(root);
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/heads/").trim()).toBe("");
    expect(resolveBase(root, "check")).toEqual({ base: first, via: "origin/main" });
  });

  test("standing on the base falls back to the first parent", () => {
    // The `push: branches: [main]` trigger. `merge-base(main, HEAD) === HEAD`,
    // so the diff was empty and the check reported success over nothing — the
    // vacuous-green shape the CI steps exist to prevent, in the CI steps.
    const root = scratch(2);
    const parent = git(root, "rev-parse", "HEAD^").trim();
    expect(resolveBase(root, "check")).toEqual({ base: parent, via: "first-parent" });
  });

  test("the first-parent fallback takes the merge's parent, not the merged branch", () => {
    // `main` advances by merge commits, so the fallback above lands on one. Its
    // first parent is the previous tip of `main`; its second is the work that
    // landed. Taking the second would diff the change-set against itself and
    // report nothing, which is the bug being fixed wearing a different hat.
    const root = scratch(1);
    const beforeMerge = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-qb", "topic");
    writeFileSync(join(root, "b.txt"), "topic\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "topic work");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "Merge topic", "topic");

    const resolved = resolveBase(root, "check");
    expect(resolved).toEqual({ base: beforeMerge, via: "first-parent" });
    // Named explicitly: the second parent is a different commit, and asserting
    // only `via` would pass if the resolver picked it.
    expect(git(root, "rev-parse", "HEAD^2").trim()).not.toBe(beforeMerge);
  });

  test("a root commit is refused with an explanation, not a stack", () => {
    const root = scratch(0);
    const out = resolveBase(root, "check:example");
    // Throws rather than `expect(...).toBeUndefined()`: that asserts without
    // narrowing, so `out.message` below does not typecheck.
    if (out.base !== undefined) throw new Error(`expected a refusal, got base ${out.base}`);
    expect(out.message).toContain("check:example");
    expect(out.message).toContain("no parent");
  });

  test("no `main` and no `origin/main` is refused, naming both", () => {
    // The message has to name the ref it actually looked for. The old one said
    // "needs full history and a `main` ref" on a full-history checkout, which
    // sent the reader to fix the thing that was already right.
    const root = scratch(1);
    git(root, "checkout", "-q", "--detach", "HEAD");
    git(root, "branch", "-q", "-D", "main");
    const out = resolveBase(root, "check:example");
    // Throws rather than `expect(...).toBeUndefined()`: that asserts without
    // narrowing, so `out.message` below does not typecheck.
    if (out.base !== undefined) throw new Error(`expected a refusal, got base ${out.base}`);
    expect(out.message).toContain("origin/main");
    expect(out.message).not.toContain("shallow");
  });

  test("a shallow clone is refused before anything else is asked", () => {
    // Distinct from the missing-ref case: the repair is different, and the old
    // message merged them into one sentence offering both cures for either.
    const source = scratch(3);
    const root = mkdtempSync(join(tmpdir(), "omni-base-shallow-"));
    roots.push(root);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source}`, root], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const out = resolveBase(root, "check:example");
    // Throws rather than `expect(...).toBeUndefined()`: that asserts without
    // narrowing, so `out.message` below does not typecheck.
    if (out.base !== undefined) throw new Error(`expected a refusal, got base ${out.base}`);
    expect(out.message).toContain("shallow");
  });
});
