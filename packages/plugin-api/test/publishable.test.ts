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
        for await (const file of new Glob("src/**/*.ts").scan(join(REPO, dir))) {
          const source = readFileSync(join(REPO, dir, file), "utf8");
          if (/from\s+["']@omni\//.test(source)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
      });
    });
  }

  test("the API package's major is the API version the host enforces", () => {
    // A manifest declares `api: 1` and the host skips a plugin on mismatch. If
    // the npm major and that number disagree, `npm install @omnigateway/plugin-api@2`
    // gives a plugin that the host refuses to load for reasons no error explains.
    const major = Number(manifest("packages/plugin-api").version.split(".")[0]);
    expect(major).toBe(PLUGIN_API_VERSION);
  });

  test("the SDK package's version is the one manifest ranges are matched against", () => {
    // Exactly, not by major: `sdk` in a manifest is a range like "^1.2.0" and
    // the host compares it to DASHBOARD_SDK_VERSION. If npm ships 1.3.0 while
    // the console reports 1.2.0, a plugin built against what it installed is
    // disabled at load with its range looking correct.
    expect(manifest("packages/dashboard-sdk").version).toBe(DASHBOARD_SDK_VERSION);
  });
});
