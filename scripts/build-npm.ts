#!/usr/bin/env bun
/**
 * Assembles the publishable `omnigateway` package.
 *
 * The workspace is private and its packages depend on each other through
 * `workspace:*`, which means nothing here can be published as-is: npm cannot
 * resolve a workspace protocol. Bundling is what turns six private packages
 * into one installable thing — the CLI and the server each become a single
 * file with their `@omni/*` imports inlined.
 *
 * Two things deliberately stay out of the bundle:
 *
 * - `@node-rs/argon2` is a native module, so it stays a real dependency and is
 *   installed by npm at the user's platform.
 * - Bun's own built-ins (`bun:sqlite`) are provided by the runtime. That is
 *   also why the published package needs Bun rather than Node: the store, the
 *   spawner, and the file APIs are all Bun's.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "npm");

/** Native modules cannot be bundled; they stay dependencies of the published package. */
const EXTERNAL = ["@node-rs/argon2"];

const RUNTIME_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@node-rs/argon2": "2.0.2",
};

/**
 * Reads the release version from the tag that triggered the build.
 *
 * The tag is the only place a version is written down, so a malformed one has
 * to stop the build rather than be coerced into something publishable.
 */
export function releaseVersion(raw: string): string {
  // Tags are written `v1.2.3`; the manifest wants `1.2.3`.
  const version = raw.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`expected a semver version, got "${raw}"`);
  }
  return version;
}

async function bundle(entry: string, outfile: string): Promise<void> {
  // No `outdir`: the artifact is written by hand so the two bundles can land
  // at the exact paths the CLI expects to find each other at.
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "bun",
    format: "esm",
    external: EXTERNAL,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`could not bundle ${entry}`);
  }

  const artifact = result.outputs[0];
  if (artifact === undefined) throw new Error(`bundling ${entry} produced nothing`);
  await Bun.write(outfile, await artifact.text());
}

export async function buildPackage(version: string): Promise<string> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "bin"), { recursive: true });

  // The CLI's bin, and the server it starts. They are siblings by contract:
  // `gatewayEntrypoint` looks for `../gateway.js` relative to the bin.
  await bundle("apps/cli/src/index.ts", join(outDir, "bin", "omni.js"));
  await bundle("apps/gateway/src/index.ts", join(outDir, "gateway.js"));

  // The console, served by that same server from `./public`.
  await cp(join(root, "apps", "dashboard", "dist"), join(outDir, "public"), { recursive: true });

  await writeFile(
    join(outDir, "package.json"),
    `${JSON.stringify(
      {
        name: "omnigateway",
        version,
        description:
          "Self-hosted AI gateway with Anthropic- and OpenAI-compatible APIs, an admin console, and a CLI",
        license: "MIT",
        author: "Harismawan <mail@harismawan.com>",
        type: "module",
        bin: { omni: "./bin/omni.js" },
        files: ["bin", "gateway.js", "public", "README.md", "LICENSE"],
        dependencies: RUNTIME_DEPENDENCIES,
        // Bun is the runtime, not just the bundler: bun:sqlite, Bun.spawn and
        // Bun.file are all load-bearing. Saying so here turns a confusing
        // `env: bun: not found` into an install-time complaint.
        engines: { bun: ">=1.4.0" },
        repository: { type: "git", url: "git+https://github.com/harismawan/omnigateway.git" },
        homepage: "https://github.com/harismawan/omnigateway#readme",
        bugs: "https://github.com/harismawan/omnigateway/issues",
        keywords: ["ai", "gateway", "proxy", "anthropic", "openai", "llm", "oauth"],
      },
      null,
      2,
    )}\n`,
  );

  await cp(join(root, "README.md"), join(outDir, "README.md"));
  await cp(join(root, "LICENSE"), join(outDir, "LICENSE"));
  await Bun.$`chmod +x ${join(outDir, "bin", "omni.js")}`.quiet();

  return outDir;
}

if (import.meta.main) {
  const version = releaseVersion(process.argv[2] ?? process.env.OMNI_RELEASE_VERSION ?? "");
  const dir = await buildPackage(version);
  console.log(`built omnigateway@${version} in ${dir}`);
}
