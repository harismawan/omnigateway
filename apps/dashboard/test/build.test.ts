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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "@babel/core";
import * as sdk from "@omnigateway/dashboard-sdk";
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
  // Also verify the no-typecheck Docker entrypoint. The build defines production
  // for browser code regardless of the test runner's own NODE_ENV.
  if (existsSync(dist)) writeFileSync(join(dist, "stale-build.txt"), "must be removed");
  const built = Bun.spawnSync(["bun", "run", "build:production"], {
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
      /in an environment that doesn't expose the `require`|Dynamic require of|Cannot require module/.test(
        readFileSync(file, "utf8"),
      ),
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
      for (const imported of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
        const specifier = imported.path;
        // Scan actual syntax: strings that look like imports are not imports.
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
    // Parse both artifact boundaries: source re-exports alone do not prove the
    // bundler preserved them for consumers outside its graph.
    const parser = new Bun.Transpiler({ loader: "js" });
    const chunks = bundles(join(dist, "assets")).map((file) => {
      const ast = parseSync(readFileSync(file, "utf8"), { configFile: false, babelrc: false });
      if (!ast) throw new Error(`Could not parse ${file}`);
      return ast.program.body;
    });
    let checked = 0;

    for (const [specifier, url] of Object.entries(SHARED_IMPORTS)) {
      const entry = join(dist, "shared", `${sharedEntryName(url)}.js`);
      const provided = new Set(parser.scan(readFileSync(entry, "utf8")).exports);
      expect(provided.size).toBeGreaterThan(0);
      const expected = parser.scan(
        readFileSync(join(root, "shared", `${sharedEntryName(url)}.ts`), "utf8"),
      ).exports;
      for (const name of expected) expect(provided).toContain(name);
      if (specifier === "@omnigateway/dashboard-sdk") {
        for (const name of Object.keys(sdk)) expect(provided).toContain(name);
      }
      const wanted = new Set<string>();
      for (const body of chunks) {
        for (const node of body) {
          if (node.type !== "ImportDeclaration" || node.source.value !== specifier) continue;
          for (const binding of node.specifiers) {
            if (binding.type === "ImportDefaultSpecifier") wanted.add("default");
            if (binding.type === "ImportSpecifier") {
              wanted.add(
                binding.imported.type === "Identifier"
                  ? binding.imported.name
                  : binding.imported.value,
              );
            }
          }
        }
      }

      checked += wanted.size;
      expect([...wanted].filter((name) => !provided.has(name)).sort()).toEqual([]);
    }

    // Positive control: parser or import shape changes must not make this vacuous.
    expect(checked).toBeGreaterThan(0);
  });

  test("keeps stable public URLs, ordered theme/import map, hashed external fonts and clean output", () => {
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain('type="importmap"');
    expect(html).toContain('type="module"');
    expect(html).toContain('localStorage.getItem("omni-theme")');
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
    expect(html.indexOf('localStorage.getItem("omni-theme")')).toBeLessThan(
      html.indexOf('type="module"'),
    );
    expect(html).toContain('href="/favicon.svg"');
    // Absolute asset URLs must also boot when the gateway serves a deep SPA route.
    expect(html).toMatch(/src="\/assets\/[^"/]+\.js"/);
    expect(html).toMatch(/href="\/assets\/[^"/]+\.css"/);
    expect(readFileSync(join(dist, "favicon.svg"))).toEqual(
      readFileSync(join(root, "public/favicon.svg")),
    );
    expect(existsSync(join(dist, "shared/favicon.svg"))).toBe(false);
    expect(existsSync(join(dist, "stale-build.txt"))).toBe(false);
    const css = readdirSync(join(dist, "assets"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(dist, "assets", name), "utf8"))
      .join("\n");
    expect(css).not.toContain("data:");
    const fonts = [...css.matchAll(/\/assets\/([^\s)"']+\.woff2)/g)].map((match) => match[1] ?? "");
    expect(fonts.length).toBeGreaterThan(0);
    for (const name of fonts) {
      const bytes = readFileSync(join(dist, "assets", name));
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
      expect(name).toEndWith(`-${hash}.woff2`);
    }
  });

  test("contains real lazy routes and representative original styled display names", () => {
    const files = bundles(join(dist, "assets"));
    const parser = new Bun.Transpiler({ loader: "js" });
    const imports = files.flatMap((file) => parser.scanImports(readFileSync(file, "utf8")));
    const lazy = imports.filter((entry) => entry.kind === "dynamic-import");
    expect(lazy.length).toBeGreaterThan(10);
    expect(lazy.some((entry) => entry.path.includes("login-"))).toBe(true);
    expect(lazy.some((entry) => entry.path.includes("_app.keys-"))).toBe(true);
    const code = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(code).toContain("Panel__");
    expect(code).toContain("login__");
    // Consumers may reference React internals, but the implementation is shared.
    const react = bundles(join(dist, "shared")).filter((file) =>
      readFileSync(file, "utf8").includes(
        "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
      ),
    );
    // React, JSX runtime and the renderer all recognize the element symbol.
    // Only the React implementation initializes the shared dispatcher object.
    expect(react.length).toBeGreaterThan(0);
    expect(
      bundles(join(dist, "shared")).filter((file) =>
        /\.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE\s*=/.test(
          readFileSync(file, "utf8"),
        ),
      ),
    ).toHaveLength(1);
    for (const file of bundles(join(dist, "shared"))) {
      for (const imported of parser.scanImports(readFileSync(file, "utf8"))) {
        expect(imported.path.startsWith(".")).toBe(true);
      }
    }
  });
});
