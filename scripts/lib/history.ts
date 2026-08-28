/**
 * Which commit the repository-hygiene checks compare against.
 *
 * One copy, because the previous arrangement was two. `stale-claims.ts` and
 * `dead-exports.ts` each carried a verbatim `requireHistory()` plus its own
 * `merge-base` call, and three separate defects turned out to be the same
 * sentence: a fix applied to one sibling and not the other. The `base..HEAD`
 * working-tree bug was repaired in `dead-exports.ts` — with a comment
 * explaining exactly why the two-dot form is wrong — and left standing in
 * `stale-claims.ts`. So was the `readable()` guard. Duplication is not the
 * risk here; duplication that *drifts under repair* is, and that is what two
 * copies of a rule reliably do.
 *
 * Both failure modes below were live in CI and neither was visible from the
 * branch this was written on.
 */

import { execFileSync } from "node:child_process";

/** How the base was arrived at, so a caller can say so and a test can assert it. */
export type BaseResolution = {
  /** The commit to diff the working tree against. */
  base: string;
  /** Which ref answered: a local `main`, `origin/main`, or the first parent. */
  via: "main" | "origin/main" | "first-parent";
};

export type HistoryFailure = {
  base?: undefined;
  /** Ready to print; already names the script and the repair. */
  message: string;
};

function run(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" });
}

function verifies(root: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd: root,
      // Inheriting stderr would print git's own `fatal:` line just above the
      // explanation the caller prints, which is the noise this replaces.
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the base commit, or explain why it cannot be.
 *
 * **`origin/main` as well as `main`, because CI has only the second.**
 * `actions/checkout` fetches `+refs/heads/*:refs/remotes/origin/*` and, on a
 * `pull_request` event, detaches at `refs/remotes/pull/N/merge`. It never
 * creates `refs/heads/main` — not even at `fetch-depth: 0`. So `rev-parse
 * --verify main` exited 128 and both checks exited 2 on every pull request,
 * while the instruction they printed ("actions/checkout@v5 with fetch-depth:
 * 0") was the configuration already in effect. An operator following it got
 * nowhere.
 *
 * **A first-parent fallback, because on the other trigger the base *is* HEAD.**
 * `push: branches: [main]` runs with `merge-base(main, HEAD) === HEAD`, so the
 * diff was empty and both checks reported success over nothing: `no stale
 * claims (0 removed symbols checked)`. Green and vacuous, which is the shape
 * that reads as coverage while being none — the same failure the CI steps were
 * added to fix, one layer up. On that trigger the change-set that just landed
 * is `HEAD^..HEAD`, and for the merge commit a PR produces, the first parent is
 * the previous tip of `main`, so `HEAD^` is exactly the right question.
 *
 * A root commit has no first parent and no earlier state to have claimed
 * anything, so there the checks genuinely have nothing to say.
 */
export function resolveBase(root: string, script: string): BaseResolution | HistoryFailure {
  if (run(root, "rev-parse", "--is-shallow-repository").trim() === "true") {
    return {
      message:
        `${script}: needs full history, and this is a shallow clone.\n` +
        "  locally:  git fetch --unshallow\n" +
        "  in CI:    actions/checkout@v5 with fetch-depth: 0",
    };
  }

  const ref = (["main", "origin/main"] as const).find((candidate) => verifies(root, candidate));
  if (ref === undefined) {
    return {
      message:
        `${script}: needs a \`main\` or \`origin/main\` ref to compare against, ` +
        "and this checkout has neither.\n" +
        "  locally:  git fetch origin main\n" +
        "  in CI:    actions/checkout@v5 with fetch-depth: 0",
    };
  }

  const base = run(root, "merge-base", ref, "HEAD").trim();
  if (base !== run(root, "rev-parse", "HEAD").trim()) return { base, via: ref };

  // Standing on the base itself: the push-to-main case.
  if (!verifies(root, "HEAD^")) {
    return {
      message: `${script}: HEAD is \`${ref}\` and has no parent, so there is no earlier state to compare against.`,
    };
  }
  return { base: run(root, "rev-parse", "HEAD^").trim(), via: "first-parent" };
}
