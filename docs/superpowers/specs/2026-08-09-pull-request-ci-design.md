# Pull-Request and Default-Branch CI Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Run repository verification before changes reach release tags. Pull requests and pushes to `main`
must run root tests, dashboard tests, typechecking, and linting without gaining publishing
permissions.

## Root scripts

Add two discoverable scripts to the root `package.json`:

- `test:dashboard` runs the dashboard DOM test suite from its workspace.
- `test:all` runs the existing root test suite, then `test:dashboard`.

Keep `test` unchanged as `bun test`. The root suite deliberately excludes dashboard tests, so callers
that require complete coverage must use `test:all`.

## Continuous-integration workflow

Add `.github/workflows/ci.yml` with these triggers:

- every pull request;
- every push to `main`.

The workflow has one Ubuntu job with read-only repository permissions. It checks out the repository,
installs Bun canary to support the current lockfile format, installs dependencies with the frozen
lockfile, then runs:

1. `bun run test:all`;
2. `bun run typecheck`;
3. `bun run lint`.

The workflow does not build or publish release artifacts. It has no OIDC permission, package-registry
credential, matrix, cache, or conditional release path.

## Release workflow reuse

Replace the release workflow's separate root and dashboard test steps with one
`bun run test:all` step. Typechecking, linting, builds, OIDC setup, and publishing remain unchanged.
This keeps test coverage identical between ordinary CI and tag releases while preserving the release
workflow's tag-only publishing boundary.

## Failure behavior

Commands run sequentially within each job. Any failed install, test, typecheck, or lint command fails
the job and prevents later steps. Release publishing remains unreachable unless all verification and
build steps pass.

## Verification

After implementation:

- run `bun run test:all`;
- run `bun run typecheck`;
- run `bun run lint`;
- inspect both workflow files for correct triggers and least-privilege permissions;
- confirm the working tree contains only the intended script and workflow changes plus this design.
