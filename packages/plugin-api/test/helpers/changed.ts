/**
 * The one git query the publish drift check is built on, extracted so it can be
 * asked of a repository this file makes.
 *
 * It was inline, and both of its bugs survived a mutation run against the real
 * repository — not because nothing tested the check, but because the check runs
 * on history that has already been repaired. Revert either fix and the answer
 * is still "no drift", which is the correct answer once the version has moved.
 * A test that can only observe the instrument through history it cannot control
 * observes it exactly when there is nothing to see.
 *
 * So the properties live here and are asked of a scratch repository holding the
 * one shape that matters: a change that exists only in the working tree, in a
 * file outside `src`.
 */

/**
 * The paths of a published package that decide what a consumer receives.
 *
 * `src` because these packages ship their sources, and `package.json` because
 * it is the part that decides what those sources *resolve* — a dependency range
 * one version behind its sibling ships an install nobody can make work, with
 * nothing in any source file to show for it.
 */
export function publishedPaths(dir: string): string[] {
  return [`${dir}/src`, `${dir}/package.json`];
}

/**
 * Files under `paths` that differ between `ref` and the **working tree**.
 *
 * One ref and no `..HEAD`. The two-dot form compares commit to commit, so it
 * cannot see the change a contributor is looking at while they run this, which
 * is every change at the moment it could still be fixed for free.
 */
export function changedSince(repo: string, ref: string, paths: readonly string[]): string[] {
  const out = Bun.spawnSync(["git", "diff", "--name-only", ref, "--", ...paths], {
    cwd: repo,
    stderr: "ignore",
  });
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .filter((file) => file.trim() !== "");
}
