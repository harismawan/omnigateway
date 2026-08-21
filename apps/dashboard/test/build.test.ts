/**
 * Properties of the console that is actually shipped.
 *
 * Every other test in this directory runs against source. This one builds the
 * thing and reads the output, because the failure it exists to catch lived
 * entirely in the artifact and was invisible from source: `bun test`,
 * `typecheck` and `lint` were all green in 0.4.0 and 0.4.1 while the console
 * threw on load and showed an empty page.
 *
 * What happened: `use-sync-external-store` ships CommonJS and calls
 * `require("react")`. The console externalises React so it and every plugin
 * share one instance through the import map — and an external has no module for
 * a `require` to resolve to, so rolldown emitted a stub that throws
 * "Calling `require` for react in an environment that doesn't expose the
 * `require` function". Nothing in the source said anything was wrong. The stack
 * named a hashed chunk and no file in this repository.
 *
 * Slow, because it runs a real build. That is the point: a faster test would
 * have to assert against a description of the output rather than the output, and
 * a description is exactly what stayed correct while the bundle broke.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_IMPORTS, sharedEntryName } from "../shared/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Every emitted `.js`, console chunks and shared runtime alike. */
function bundles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundles(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

beforeAll(() => {
  // Built here rather than trusting whatever `dist` happens to hold: a stale
  // directory from an earlier good build would make every assertion below pass
  // while the current source produces a broken one.
  // `NODE_ENV=production` explicitly, because `bun test` sets it to `test` and a
  // child build inherits that. It is not cosmetic: under `test`, the CommonJS
  // shims' `process.env.NODE_ENV === "production"` branch is not statically
  // resolved and a require stub reappears. Releases build with it unset, which
  // vite treats as production — so this makes the test build the artifact that
  // actually ships rather than a variant nothing else produces.
  const built = Bun.spawnSync(["bun", "run", "build"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (built.exitCode !== 0) {
    throw new Error(`console build failed:\n${built.stderr.toString()}`);
  }
  // Bun's default hook timeout is five seconds, which a warm local build fits
  // inside and a cold CI one does not. When it trips, the whole file fails as a
  // single unnamed test — none of the assertions below run and the output names
  // neither them nor the build — so the generous ceiling here is about the
  // failure being legible, not about the build being slow.
}, 300_000);

describe("the built console", () => {
  test("contains no require stub, which throws the moment it is reached", () => {
    // The exact regression. A CommonJS dependency that requires an externalised
    // module leaves this behind, and it is fatal rather than degraded: the
    // console renders nothing at all.
    const offenders = bundles(dist).filter((file) =>
      readFileSync(file, "utf8").includes("in an environment that doesn't expose the `require`"),
    );
    expect(offenders.map((f) => f.slice(dist.length + 1))).toEqual([]);
  });

  test("imports nothing bare that the import map cannot resolve", () => {
    // The general invariant behind that regression, and the one worth keeping:
    // anything externalised has to be in the map, or the browser is handed a
    // bare specifier it has no way to resolve. Deriving the expected set from
    // the map rather than listing it means a new external is caught by this test
    // instead of by a blank page.
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const found = /type="importmap">({.*?})<\/script>/s.exec(html);
    expect(found).not.toBeNull();
    const mapped = new Set(
      Object.keys((JSON.parse(found?.[1] ?? "{}") as { imports: Record<string, string> }).imports),
    );

    const bare = new Set<string>();
    for (const file of bundles(join(dist, "assets"))) {
      const code = readFileSync(file, "utf8");
      for (const match of code.matchAll(/\bfrom"([^"]+)"/g)) {
        const specifier = match[1] ?? "";
        // Relative and absolute paths resolve on their own; only bare
        // specifiers need the map. `${` filters out matches inside template
        // literals — minified code contains strings that read like imports and
        // are not, and one of them (`"${e.from}"`) failed this test before the
        // filter existed.
        if (specifier.includes("${")) continue;
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) bare.add(specifier);
      }
    }

    expect([...bare].filter((s) => !mapped.has(s)).sort()).toEqual([]);
    // And the map is not vacuously satisfied by a build that imported nothing.
    expect(bare.size).toBeGreaterThan(0);
  });

  test("keeps React out of its own chunks, so there is exactly one copy", () => {
    // The reason any of this externalising exists. Two React instances make
    // every plugin hook throw "invalid hook call", with nothing pointing here.
    const inlined = bundles(join(dist, "assets")).filter((file) =>
      /__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE|react\.transitional\.element/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(inlined.map((f) => f.slice(dist.length + 1))).toEqual([]);

    // Present in the shared runtime, which is where it belongs — so the check
    // above is discriminating rather than matching a fingerprint nothing has.
    // That guard earned itself immediately: the first version of this test used
    // `__SECRET_INTERNALS` and `ReactCurrentDispatcher`, both of which React 19
    // renamed, so the absence check passed against every bundle in the tree
    // while proving nothing at all.
    const shared = bundles(join(dist, "shared")).some((file) =>
      /__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE|react\.transitional\.element/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(shared).toBe(true);
  });

  test("provides every binding the console imports from a shared entry", () => {
    // `imports nothing bare that the import map cannot resolve` above checks
    // that each bare specifier is *mapped*. It never asks whether the module at
    // the other end actually provides the names being imported, and the gap
    // between those two is a console that does not boot: an ES import of a
    // binding a module does not export is a load-time SyntaxError, not an
    // `undefined`.
    //
    // Checked against the artifact rather than the shim source, because the
    // failure this catches includes ones the source cannot show — dropping
    // `preserveEntrySignatures` in `vite.shared.config.ts` tree-shakes these
    // entries to nothing while every source file still reads correctly.
    // Both sides are brace lists of `a as b`, and the halves mean opposite
    // things: in `export { i as useLive }` the module provides `useLive`, and
    // in `import { useLive as fe }` the module is asked for `useLive`. So both
    // want the half facing the module boundary — last for exports, first for
    // imports.
    const names = (source: string, pattern: RegExp, half: "first" | "last"): Set<string> => {
      const out = new Set<string>();
      for (const match of source.matchAll(pattern)) {
        for (const part of (match[1] ?? "").split(",")) {
          const sides = part.trim().split(/\s+as\s+/);
          const name = (half === "first" ? sides[0] : sides[sides.length - 1])?.trim();
          if (name !== undefined && name !== "") out.add(name);
        }
      }
      return out;
    };

    const chunks = bundles(join(dist, "assets")).map((file) => readFileSync(file, "utf8"));
    let checked = 0;

    for (const [specifier, url] of Object.entries(SHARED_IMPORTS)) {
      const entry = join(dist, "shared", `${sharedEntryName(url)}.js`);
      const provided = names(readFileSync(entry, "utf8"), /export\s*\{([^}]*)\}/g, "last");

      const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const imported = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${escaped}"`, "g");
      const wanted = new Set<string>();
      for (const source of chunks) {
        for (const name of names(source, imported, "first")) wanted.add(name);
      }

      checked += wanted.size;
      expect([...wanted].filter((name) => !provided.has(name)).sort()).toEqual([]);
    }

    // Without this the whole loop is vacuous the moment the regexes stop
    // matching — a bundler that emits `import{a}from'react'` with single quotes
    // would leave every `wanted` empty and every assertion trivially true.
    expect(checked).toBeGreaterThan(0);
  });
});
