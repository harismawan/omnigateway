# Release Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Minify the portable npm package and ship a compiled standalone gateway in the container image.

**Architecture:** Keep npm's existing CLI/server JS layout and Bun runtime requirement. Add a dedicated binary build script using the requested Bun build settings; compile inside the image builder and copy only the executable and dashboard assets into an Alpine runtime. Keep version, non-root execution, persistent data, plugins and health checks working.

**Tech Stack:** Bun 1.4.3, TypeScript, Docker, Alpine, bun:test.

**Spec:** Approved conversation: npm stays JS ESM (`target: "bun"`, `format: "esm"`, `minify: true`, without compile/bytecode); image uses a standalone binary with the user's exact options.

## Global Constraints

- Binary: `root`, absolute `entrypoints`, `target: "bun"`, `format: "esm"`, `bytecode: true`, `minify: true`, `compile: { outfile, autoloadDotenv: false, autoloadBunfig: false }`.
- npm remains OS/architecture independent, with existing paths and version injection unchanged.
- Runtime image must not ship Bun separately, source or node_modules.
- Preserve externally supplied configuration, `/data`, UID 1000 non-root execution and port 9000.
- No publishing, tagging, pushing or automatic commits.

## Review Focus

- Compiled virtual source paths: explicitly point the image at `/app/public` via `OMNI_STATIC_DIR`; verify HTTP dashboard response.
- Native musl runtime compatibility: build and run the real Docker image, not only a host binary.
- Configuration isolation: a fixture executable must ignore working-directory `.env` and `bunfig.toml`.
- Dynamic plugins: smoke-test an on-disk plugin in the compiled gateway.
- Release metadata and CLI spawning: preserve npm's version/doctor tests and verify image version stays supplied via `OMNI_VERSION`.

---

### Task 1: Minify npm bundles without changing distribution

**Files:** Modify `scripts/build-npm.ts`, `scripts/test/build-npm.test.ts`.

**Interfaces:** Preserve `bundle(entry: string, outfile: string, version: string): Promise<void>` and `buildPackage(version: string): Promise<string>`.

- [x] Add a regression test that builds a tiny temporary entrypoint through `bundle`, verifies compact executable JS output and comment removal; retain version and doctor coverage.
- [x] Run `bun test scripts/test/build-npm.test.ts` and confirm the new assertion fails before implementation.
- [x] Add explicit `root` and `minify: true` to npm's Bun.build; keep ESM, version define and JS output handling unchanged.
- [x] Run the npm build tests and confirm all pass.

### Task 2: Compile the gateway and replace the image runtime

**Files:** Create `scripts/build-binary.ts`, `scripts/test/build-binary.test.ts`; modify `package.json`, `Dockerfile`, `scripts/test/dockerManifests.test.ts` as needed.

**Interfaces:** Export `buildBinary(entrypoints: string[], outfile: string, root: string): Promise<void>`. Main execution defaults to the repository root, `apps/gateway/src/index.ts`, and `dist/omnigateway`; allow an output-path argument for tests. Add `build:binary` script.

- [x] Add a fixture compile test that calls `buildBinary` in a child Bun process, executes the result directly, and asserts its behavior without an installed runtime; place conflicting `.env` and `bunfig.toml` beside execution to verify autoload is disabled. Add a missing-entry build failure assertion.
- [x] Verify image behavior with an actual Docker build/smoke instead of adding Dockerfile substring assertions (existing manifest tests retained).
- [x] Run `bun test scripts/test/build-binary.test.ts scripts/test/dockerManifests.test.ts` and confirm new binary execution test fails before implementation.
- [x] Implement the binary builder with the exact required options, absolute entrypoints via `resolve`, output-directory creation and meaningful build failure reporting. Do not rewrite executable output as text.
- [x] Pin the builder to `oven/bun:1.4.3-alpine`, copy the binary build script and compile the gateway after dashboard build. Use `alpine:3.22` runner with CA certificates, libgcc and libstdc++; create UID/GID 1000 `bun`, preserve `/data` ownership and existing environment defaults/version, copy binary to `/app/omnigateway` and dashboard to `/app/public`, set `OMNI_STATIC_DIR=/app/public`, use BusyBox wget for healthcheck and `CMD ["/app/omnigateway"]`.
- [x] Run focused tests, `bun run lint` and `bun run typecheck`; fix only issues introduced by this work.
- [x] Build dashboard and npm with a local test version; inspect `npm pack --dry-run` without publishing.
- [x] Build a local image with a test version, start it with a throwaway data directory and encryption key, and verify `/health`, dashboard, release metadata and a tiny external plugin. Verify runtime is non-root with no separate bun or node_modules. Stop/remove only these test containers.
- [x] Run broader relevant tests, inspect the diff, and record exact results and any blocked checks here before reporting completion.

## Verification results

- `bun run test:all`: 4,618 core + 726 dashboard tests pass, 15 skipped, 0 failures. Dashboard error-boundary fixtures emit expected diagnostic output.
- `bun run typecheck` and `bun run lint`: pass.
- Dashboard build and `bun run build:npm 0.0.0-build-test`: pass; npm dry-run archive ~1.1 MB, no publishing.
- `docker build --build-arg OMNI_VERSION=0.0.0-build-test -t omnigateway:binary-build-test .`: pass, image 153,536,761 bytes.
- Actual image smoke: health HTTP 200, dashboard HTML, dynamic external plugin, version environment, UID 1000, no separate Bun/source/node_modules, wget health command pass. Test container and anonymous volume removed.
- Fresh reviewer: no blocking findings. No commits or pushes.
