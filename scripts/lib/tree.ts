/**
 * Reading the working tree, for the checks that must see uncommitted work.
 *
 * The second half of the split `scripts/lib/history.ts` describes. Both of
 * these were written once, in `dead-exports.ts`, with a docblock explaining
 * exactly why — and both were left out of `stale-claims.ts`, which went on
 * comparing commits and crashing on a tracked-but-missing file. Two scripts
 * that ask the same question should not be able to answer it differently, and
 * the way to make that true is for there to be one answer.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TypeScript sources that differ between `base` and the **working tree**.
 *
 * `base` alone, never `base..HEAD`. The two-dot form compares commit to commit,
 * so a file edited and not yet committed is absent — which made the check
 * answer "nothing changed" for exactly the work a contributor is looking at
 * while they run it, and made every probe of it silently vacuous. That is how
 * this was found in the first script; the second kept the bug for another two
 * commits because the fix was written as an edit rather than as a rule.
 */
export function changedSources(root: string, base: string): string[] {
  return execFileSync("git", ["diff", "--name-only", base], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
}

/**
 * A tracked file that is not on disk is skipped, not fatal.
 *
 * `git ls-files` lists the index, and the index outlives a deletion: mid-rebase,
 * after a manual `rm`, or with an intent-to-add entry whose file has gone, the
 * read throws and the whole check dies with a stack. Found by a probe that hit
 * exactly that state — and a check that crashes on an ordinary working-tree
 * condition is one that gets removed rather than fixed.
 */
export function readable(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return undefined;
  }
}
