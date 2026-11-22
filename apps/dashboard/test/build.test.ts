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
 * `require("react")`. The console then externalised React so plugins could
 * share one instance through an import map — and an external has no module for
 * a `require` to resolve to, so the bundler emitted a stub that throws
 * "Calling `require` for react in an environment that doesn't expose the
 * `require` function". Nothing in the source said anything was wrong. The stack
 * named a hashed chunk and no file in this repository.
 *
 * Plugins and the import map are gone, React is bundled, and with it the ESM
 * shims that aliased `use-sync-external-store` away: a bundled React gives the
 * package's `require` a module to resolve to. The guards below are what keep
 * that true if anything is ever externalised again.
 *
 * Slow, because it runs a real build. That is the point: a faster test would
 * have to assert against a description of the output rather than the output, and
 * a description is exactly what stayed correct while the bundle broke.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Every emitted `.js`. */
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

  test("imports nothing bare, because there is no import map to resolve it", () => {
    // The general invariant behind that regression. With nothing externalised,
    // any bare specifier left in a chunk is one the browser has no way to
    // resolve — a blank page rather than a degraded one.
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).not.toContain("importmap");

    const bare = new Set<string>();
    let relative = 0;
    for (const file of bundles(dist)) {
      const code = readFileSync(file, "utf8");
      for (const imported of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
        const specifier = imported.path;
        // Scan actual syntax: strings that look like imports are not imports.
        if (specifier.startsWith(".") || specifier.startsWith("/")) relative += 1;
        else bare.add(specifier);
      }
    }

    expect([...bare].sort()).toEqual([]);
    // And the check is not vacuously satisfied by a build that imported nothing.
    expect(relative).toBeGreaterThan(0);
  });

  test("bundles exactly one React", () => {
    // Two React instances make every hook throw "invalid hook call", with
    // nothing pointing here. Bundled as ESM, React's module namespace is the
    // one place that exports its internals by name — a getter in the export
    // map — so exactly one such getter means exactly one React. (The assignment
    // form this used to match only exists in React's CommonJS build, and a
    // guard matching nothing passes against every bundle while proving nothing:
    // the first version of it did exactly that after React 19's renames.)
    const getters = bundles(dist).flatMap((file) => [
      ...readFileSync(file, "utf8").matchAll(
        /__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:\(\)=>/g,
      ),
    ]);
    expect(getters).toHaveLength(1);
    // And no CommonJS copy beside it, which would initialise its own.
    const commonjs = bundles(dist).filter((file) =>
      /\.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE\s*=/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(commonjs.map((f) => f.slice(dist.length + 1))).toEqual([]);
  });

  test("keeps stable public URLs, ordered theme bootstrap, hashed external fonts and clean output", () => {
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain('type="module"');
    expect(html).toContain('localStorage.getItem("omni-theme")');
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
    expect(existsSync(join(dist, "shared"))).toBe(false);
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
  });
});
