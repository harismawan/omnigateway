/**
 * The image's install layer is a pruned checkout, and bun refuses to install one
 * that is missing a workspace its survivors name.
 *
 * `COPY` lines are a hand-written list of what the gateway depends on, and the
 * dependency graph is not — so the two drift the first time a workspace edge is
 * added, and the symptom is `bun install` erroring out several minutes into a
 * build nobody runs on the way to a merge. It had drifted by seven packages.
 *
 * So this walks the closure rather than listing it, same instrument as
 * `providerTables.test.ts`: a package added tomorrow is covered the day its edge
 * is declared. Dev dependencies count — bun applies the pruned-checkout rule
 * before it considers whether `--production` would have skipped the edge, which
 * is why `@omni/testkit` needs a line despite no `src/` file importing it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Every workspace in the repository, keyed by package name. */
function workspaces(): Map<string, { dir: string; manifest: Manifest }> {
  const found = new Map<string, { dir: string; manifest: Manifest }>();
  for (const glob of ["packages", "apps"]) {
    const entries = new Bun.Glob(`${glob}/*/package.json`).scanSync({ cwd: repoRoot });
    for (const entry of entries) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, entry), "utf8")) as Manifest;
      found.set(manifest.name, { dir: entry.slice(0, -"/package.json".length), manifest });
    }
  }
  return found;
}

/** Workspace directories reachable from `root`, including `root` itself. */
function closure(root: string): string[] {
  const all = workspaces();
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    const entry = all.get(name);
    if (entry === undefined) continue;
    seen.add(name);
    const edges = { ...entry.manifest.dependencies, ...entry.manifest.devDependencies };
    for (const [dep, range] of Object.entries(edges)) {
      if (range.startsWith("workspace:")) queue.push(dep);
    }
  }
  return [...seen].flatMap((name) => {
    const entry = all.get(name);
    return entry === undefined ? [] : [entry.dir];
  });
}

describe("the Dockerfile install layer", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const reachable = closure("@omni/gateway");

  test("the closure is more than the gateway itself", () => {
    // The control. Every assertion below is "this directory is copied", and an
    // empty closure satisfies all of them at once.
    expect(reachable.length).toBeGreaterThan(1);
    expect(reachable).toContain("packages/ir");
  });

  test.each(reachable)("%s has its manifest copied before the install", (dir) => {
    expect(dockerfile).toContain(`COPY ${dir}/package.json ${dir}/`);
  });

  test("the manifests are copied before bun install reads them", () => {
    // A COPY that lands after the RUN is a line that reads as present and does
    // nothing, which is the failure this file exists for wearing a disguise.
    const install = dockerfile.indexOf("bun install --frozen-lockfile");
    expect(install).toBeGreaterThan(-1);
    for (const dir of reachable) {
      expect(dockerfile.indexOf(`COPY ${dir}/package.json`)).toBeLessThan(install);
    }
  });
});
