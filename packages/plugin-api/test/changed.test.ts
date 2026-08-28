/**
 * The publish drift check's own query, asked of a repository built here.
 *
 * `publishable.test.ts` reads this repository's real history, and that history
 * is repaired — so reverting either fix in `helpers/changed.ts` leaves it
 * green. Both mutants survived a run against it, which is what an instrument
 * with no instrument of its own looks like from the outside: correct today,
 * silent on the day it stops being.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, publishedPaths } from "./helpers/changed.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omni-drift-"));
  roots.push(root);
  const run = (...argv: string[]): void => {
    const out = Bun.spawnSync(argv, { cwd: root, stderr: "pipe" });
    if (out.exitCode !== 0) {
      throw new Error(`${argv.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
    }
  };
  run("git", "init", "-q", "-b", "main");
  // Identity is set locally: a machine with no global `user.email` cannot
  // commit, and this failing for that reason would read as the check breaking.
  run("git", "config", "user.email", "drift@test.invalid");
  run("git", "config", "user.name", "Drift Test");
  mkdirSync(join(root, "pkg", "src"), { recursive: true });
  writeFileSync(join(root, "pkg", "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pkg", "package.json"), '{\n  "version": "1.0.0"\n}\n');
  run("git", "add", "-A");
  run("git", "commit", "-qm", "release");
  run("git", "tag", "v1.0.0");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("what the publish drift check considers changed", () => {
  test("a released tree with nothing edited has drifted nowhere", () => {
    // The positive control. Every assertion below is "this file is reported",
    // and a query that reports everything satisfies all of them.
    const root = scratch();
    expect(changedSince(root, "v1.0.0", publishedPaths("pkg"))).toEqual([]);
  });

  test("an edit that is only in the working tree counts", () => {
    // The form the check was blind to. It asked `${tag}..HEAD`, which compares
    // commit to commit — so the diff a contributor is looking at while they run
    // the suite was invisible, and the check passed on exactly the change it
    // exists to refuse. It would have gone green until the release that could
    // no longer be repaired without a second one.
    const root = scratch();
    writeFileSync(join(root, "pkg", "src", "index.ts"), "export const a = 2;\n");
    expect(changedSince(root, "v1.0.0", publishedPaths("pkg"))).toEqual(["pkg/src/index.ts"]);
  });

  test("an edit to the manifest counts, not only one to the sources", () => {
    // `dashboard-sdk` shipped `@omnigateway/plugin-api: ^0.1.0` past that
    // package's move to `0.2.0`. Nothing under `src` moved, so a check watching
    // sources alone saw a package that did not need republishing — while every
    // `bun add` of it resolved a generation the gateway refuses.
    const root = scratch();
    writeFileSync(
      join(root, "pkg", "package.json"),
      '{\n  "version": "1.0.0",\n  "dependencies": { "x": "^2.0.0" }\n}\n',
    );
    expect(changedSince(root, "v1.0.0", publishedPaths("pkg"))).toEqual(["pkg/package.json"]);
  });

  test("a file outside the published paths does not count", () => {
    // The other direction. A query wide enough to report anything would satisfy
    // the two tests above and demand a version bump for a change no consumer
    // receives — which trains the next person to bump versions to silence it.
    const root = scratch();
    writeFileSync(join(root, "pkg", "NOTES.md"), "not shipped\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: root });
    expect(changedSince(root, "v1.0.0", publishedPaths("pkg"))).toEqual([]);
  });
});
