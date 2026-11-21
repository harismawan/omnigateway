#!/usr/bin/env bun
/**
 * Assembles the publishable npm packages for the Rust gateway.
 *
 * Nothing is compiled here. The `rust-binaries` release job already built and
 * verified one archive per target; this unpacks each into its platform package
 * (`@omnigateway/<os>-<cpu>`) so npm ships the same bytes as the GitHub release,
 * and writes the main `omnigateway` package: a Node launcher, the postinstall
 * that links straight to the binary and migrates a 0.x service, and the
 * `gateway.js` bridge that every 0.x systemd unit points at.
 *
 * Design: docs/superpowers/specs/2026-11-21-rust-npm-distribution-design.md.
 */
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** One release archive target, and the npm package it becomes. */
export const PLATFORMS = [
  { target: "x86_64-unknown-linux-musl", npm: "@omnigateway/linux-x64", os: "linux", cpu: "x64" },
  {
    target: "aarch64-unknown-linux-musl",
    npm: "@omnigateway/linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
  { target: "x86_64-apple-darwin", npm: "@omnigateway/darwin-x64", os: "darwin", cpu: "x64" },
  { target: "aarch64-apple-darwin", npm: "@omnigateway/darwin-arm64", os: "darwin", cpu: "arm64" },
] as const;

const COMMON = {
  license: "MIT",
  author: "Harismawan <mail@harismawan.com>",
  repository: { type: "git", url: "git+https://github.com/harismawan/omnigateway.git" },
  homepage: "https://github.com/harismawan/omnigateway#readme",
  bugs: "https://github.com/harismawan/omnigateway/issues",
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

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function unpack(archive: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`could not unpack ${archive}: ${tar.stderr}`);
  // npm drops symlinks from tarballs; the main package's bin links `omni`.
  await rm(join(dir, "omni"), { force: true });
}

/**
 * Writes `<out>/<os>-<cpu>/` for every platform and `<out>/omnigateway/`.
 * Every archive must exist for this exact tag: a partial set would publish a
 * main package whose optional dependency for some host never arrives.
 */
export async function buildPackages(options: {
  version: string;
  assets: string;
  out: string;
}): Promise<string[]> {
  const { version, assets, out } = options;
  const tag = `v${version}`;
  const present = new Set(await readdir(assets));
  const missing = PLATFORMS.map(({ target }) => `omnigateway-${tag}-${target}.tar.gz`).filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`release archives missing for ${tag}: ${missing.join(", ")}`);
  }
  await rm(out, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const { target, npm, os, cpu } of PLATFORMS) {
    const dir = join(out, npm.replace("@omnigateway/", ""));
    await unpack(join(assets, `omnigateway-${tag}-${target}.tar.gz`), dir);
    await chmod(join(dir, "omnigateway"), 0o755);
    await json(join(dir, "package.json"), {
      name: npm,
      version,
      description: `The OmniGateway ${os}-${cpu} binary, installed by the omnigateway package`,
      ...COMMON,
      os: [os],
      cpu: [cpu],
      files: ["omnigateway", "public", "LICENSE"],
      preferUnplugged: true,
    });
    dirs.push(dir);
  }

  const main = join(out, "omnigateway");
  await cp(join(root, "packaging", "npm"), main, { recursive: true });
  for (const bin of ["omni", "omnigateway"]) await chmod(join(main, "bin", bin), 0o755);
  await cp(join(root, "README.md"), join(main, "README.md"));
  await cp(join(root, "LICENSE"), join(main, "LICENSE"));
  await json(join(main, "package.json"), {
    name: "omnigateway",
    version,
    description:
      "Self-hosted AI gateway with Anthropic- and OpenAI-compatible APIs, an admin console, and a CLI",
    ...COMMON,
    type: "commonjs",
    bin: { omni: "bin/omni", omnigateway: "bin/omnigateway" },
    files: ["bin", "lib", "gateway.js", "postinstall.js", "README.md", "LICENSE"],
    scripts: { postinstall: "node postinstall.js" },
    // Hosts with no native build refuse the update (EBADPLATFORM) and keep
    // the TS release they already run.
    os: ["linux", "darwin"],
    cpu: ["x64", "arm64"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(PLATFORMS.map(({ npm }) => [npm, version])),
    keywords: ["ai", "gateway", "proxy", "anthropic", "openai", "llm", "oauth"],
  });
  dirs.push(main);
  return dirs;
}

if (import.meta.main) {
  const version = releaseVersion(process.argv[2] ?? process.env.OMNI_RELEASE_VERSION ?? "");
  const assets = process.argv[3] ?? join(root, "release-assets");
  const out = join(root, "dist", "npm");
  // Platforms first: publish order is the order printed.
  for (const dir of await buildPackages({ version, assets, out })) console.log(dir);
}
