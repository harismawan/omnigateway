/**
 * The two packages that leave this repository.
 *
 * Everything else in `packages/` is internal and stays `private` at `0.0.0`, with
 * the gateway's git tag as the only version anywhere. These two are different:
 * a plugin author `npm install`s them, so they carry real versions, and those
 * versions have to mean what the code says they mean.
 *
 * The rule with teeth is the last one. A published package may not name an
 * unpublished one — not in its dependencies, and not in its source. Inside this
 * workspace such an import resolves, typechecks and tests green; on a stranger's
 * machine it is an unresolvable `workspace:*` or a module that does not exist.
 * That is not hypothetical. `@omnigateway/plugin-api` shipped a dependency on
 * `@omni/ratelimit` for exactly as long as nobody tried to install it, and the
 * same import quietly put half a megabyte of zod into every plugin's bundle.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { DASHBOARD_SDK_VERSION, PLUGIN_API_VERSION } from "../src/version.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

const PUBLISHED = ["packages/plugin-api", "packages/dashboard-sdk"] as const;

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as Manifest;
}

describe("the packages a plugin author installs", () => {
  for (const dir of PUBLISHED) {
    describe(dir, () => {
      test("is not private, and publishes publicly", () => {
        const pkg = manifest(dir);
        // A scoped package defaults to restricted. Publishing one without this
        // fails on a free account rather than shipping something private, but
        // the failure arrives after the tests, the build and the tag.
        expect(pkg.private).toBeUndefined();
        expect(pkg.publishConfig?.access).toBe("public");
      });

      test("ships its sources, which are what it exports", () => {
        // The exports map points at `./src/*.ts`. Bun imports TypeScript
        // directly, so there is no build step and no dual-package hazard — but
        // it does mean an npm package with nothing in it if `files` forgets src.
        expect(manifest(dir).files).toContain("src");
      });

      test("depends on nothing that is not itself published", () => {
        const pkg = manifest(dir);
        const declared = Object.entries({
          ...pkg.dependencies,
          ...pkg.peerDependencies,
        });

        for (const [name, range] of declared) {
          // `@omni/*` is the internal scope. `@omnigateway/*` is the published
          // one, and the two differ by five characters, which is the entire
          // reason this assertion is worth writing down.
          expect(name.startsWith("@omni/")).toBe(false);
          // `workspace:` resolves only inside this repository. npm rewrites it
          // on publish for some layouts and not others; not relying on that is
          // cheaper than knowing which.
          expect(range.startsWith("workspace:")).toBe(false);
        }
      });

      test("imports nothing that is not itself published", async () => {
        // The manifest check above is not enough on its own: a type-only import
        // needs no dependency entry, resolves inside the workspace, and lands in
        // the published `.d.ts` — or here, in the published `.ts` — as a
        // specifier a consumer cannot resolve.
        const offenders: string[] = [];
        let scanned = 0;
        // `*.{ts,tsx}` and not `*.ts`: these packages ship their sources, so a
        // `.tsx` is as publishable as a `.ts` and `src/**/*.ts` does not match
        // one. The SDK is the package likeliest to grow a `.tsx` now that it
        // holds React code, and this is the guard standing between a
        // `workspace:*` specifier and a stranger's `npm install`.
        for await (const file of new Glob("src/**/*.{ts,tsx}").scan(join(REPO, dir))) {
          scanned += 1;
          const source = readFileSync(join(REPO, dir, file), "utf8");
          if (/from\s+["']@omni\//.test(source)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
        // A glob that matches nothing reports no offenders, which is the same
        // answer as a clean package.
        expect(scanned).toBeGreaterThan(0);
      });
    });
  }

  test("the API package's generation is a counter, not its npm major", () => {
    // These were pinned to each other, and the pin was wrong. `PLUGIN_API_VERSION`
    // is a compatibility generation that only ever increases; an npm major is
    // semver, and semver resets a stabilising package from `0.x` to `1.0.0`. Any
    // rule mapping one to the other has to make the generation go backwards on
    // exactly that day, which is the one thing it may never do.
    //
    // What is asserted instead is the property that made the pin attractive:
    // both are visible, both are integers a human compares, and the generation
    // is a positive whole number rather than whatever a version string happens
    // to start with. Which one gates loading is not in doubt — only this one is.
    expect(Number.isInteger(PLUGIN_API_VERSION)).toBe(true);
    expect(PLUGIN_API_VERSION).toBeGreaterThan(0);

    // And the npm version is semver, so a range in a manifest means something.
    expect(manifest("packages/plugin-api").version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a published package whose sources moved has moved its version", () => {
    // The guard the one above is a special case of, and the one that was
    // missing when it mattered.
    //
    // `PLUGIN_API_VERSION` went 1 → 2 for the removal of `ctx.provider.register`
    // — a breaking change to a *published* type surface — and
    // `packages/plugin-api/package.json` stayed at a version already on npm. The
    // release step skips a package whose version already exists, so the next tag
    // would have published nothing: every author running `bun add
    // @omnigateway/plugin-api` keeps an artifact whose `PluginContext` still
    // types `provider` and whose `PLUGIN_API_VERSION` is `1`, while the shipped
    // gateway refuses `api: 1`. No published version would produce a loadable
    // manifest.
    //
    // The test above catches exactly one shape of this — the API package
    // trailing the SDK — and both were `0.1.2`, so it passed and said nothing.
    // This asks the general question of every published package: did its source
    // change since the last release, and if so did its version move?
    //
    // Skips rather than fails when there is no tag to compare against: a shallow
    // CI clone has none, and a check that fails for lack of history teaches
    // people to disable it.
    const tags = Bun.spawnSync(["git", "tag", "--list", "v*", "--sort=-v:refname"], {
      cwd: REPO,
    });
    const latest = new TextDecoder().decode(tags.stdout).split("\n")[0]?.trim();
    if (latest === undefined || latest === "") return;

    // Comments stripped before comparing. A published artifact is its code; a
    // docblock that gained a paragraph is not a reason to make every plugin
    // author take an update, and flagging it would train the next person to
    // bump the version to silence this rather than because anything shipped.
    //
    // Found by the instrument itself on its first run: `dashboard-sdk/src`
    // showed as drifted since `v0.5.0`, and the whole diff was fifteen lines of
    // comment in `theme.ts`.
    // Blank lines dropped after stripping, not merely blanked: a removed comment
    // leaves whitespace behind, and comparing line-for-line then reports every
    // file whose comments moved as a file whose code moved.
    const code = (raw: string): string =>
      raw
        .replace(/\/\*[\s\S]*?\*\//g, "\n")
        .replace(/^\s*\/\/.*$/gm, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("\n");

    const stale: string[] = [];
    for (const dir of PUBLISHED) {
      const changed = Bun.spawnSync(
        ["git", "diff", "--name-only", `${latest}..HEAD`, "--", `${dir}/src`],
        { cwd: REPO },
      );
      const touched = new TextDecoder()
        .decode(changed.stdout)
        .split("\n")
        .filter((file) => file.trim() !== "");
      const behaviourMoved = touched.some((file) => {
        const at = Bun.spawnSync(["git", "show", `${latest}:${file}`], {
          cwd: REPO,
          stderr: "ignore",
        });
        const before = new TextDecoder().decode(at.stdout);
        let after = "";
        try {
          after = readFileSync(join(REPO, file), "utf8");
        } catch {
          return true; // deleted outright
        }
        return code(before) !== code(after);
      });
      if (!behaviourMoved) continue;

      const released = Bun.spawnSync(["git", "show", `${latest}:${dir}/package.json`], {
        cwd: REPO,
        stderr: "ignore",
      });
      const before = new TextDecoder().decode(released.stdout);
      if (before.trim() === "") continue; // the package did not exist at that tag

      const was = (JSON.parse(before) as Manifest).version;
      const now = manifest(dir).version;
      if (Bun.semver.order(now, was) <= 0) {
        stale.push(`${dir}: sources changed since ${latest} but version is still ${now}`);
      }
    }

    expect(stale).toEqual([]);
  });

  test("the API package is never published behind the SDK it announces", () => {
    // `DASHBOARD_SDK_VERSION` is exported from `packages/plugin-api`, and the
    // SDK's own package version is pinned equal to it by the test below. So
    // raising the SDK always edits a source file in *this* package — and the
    // release step skips a package whose version has not moved.
    //
    // That combination shipped exactly once. `v0.4.8` published
    // `dashboard-sdk@0.1.1` while `plugin-api@0.1.0` was skipped and went on
    // exporting `"0.1.0"` to every plugin author who installed it. The gateway
    // was unaffected, because it reads the workspace source rather than the
    // registry, so nothing here failed: the divergence was only visible from
    // outside the repository, which is the one place no test was looking.
    //
    // Compared rather than pinned equal, because the two are genuinely
    // independent — this package may bump alone for a manifest change, and
    // often should. What may never happen is this package trailing, since the
    // constant it carries would then describe an SDK newer than itself.
    const api = manifest("packages/plugin-api").version;
    const sdk = manifest("packages/dashboard-sdk").version;
    expect(Bun.semver.order(api, sdk)).toBeGreaterThanOrEqual(0);
  });

  test("the SDK package's version is the one manifest ranges are matched against", () => {
    // Exactly, not by major: `sdk` in a manifest is a range like "^1.2.0" and
    // the host compares it to DASHBOARD_SDK_VERSION. If npm ships 1.3.0 while
    // the console reports 1.2.0, a plugin built against what it installed is
    // disabled at load with its range looking correct.
    expect(manifest("packages/dashboard-sdk").version).toBe(DASHBOARD_SDK_VERSION);
  });
});
