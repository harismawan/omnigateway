# Remove the TypeScript gateway

Date: 2026-11-22. Status: approved scope (operator, in chat), before the `v1.0.0` tag.

## Intent

The Rust gateway (`crates/`) has replaced the TypeScript/Bun gateway on `main` (#285, #286),
and 1.0.0 ships only Rust. The TS gateway, CLI and their packages are now dead code that still
costs every contributor: CI runs ~5,000 TS tests against them, CLAUDE.md pins rules to TS files,
and Rust tests read TS sources as oracles. Delete them so the repository is the Rust gateway plus
its console. **The TS state stays readable on the `bun-checkpoint` branch** (= `main` before the
Rust merge, 6b0bd166); that is the reference from now on.

## Goals

- Delete the TS gateway and everything only it uses.
- Delete `@omnigateway/plugin-api` and `@omnigateway/dashboard-sdk`, and their publishing.
- Delete the console's plugin surface (it depended on `dashboard-sdk`; plugins are unsupported
  in 1.x).
- Rust builds and tests with no file under `apps/` other than the console's built `dist`.
- CLAUDE.md and ARCHITECTURE.md describe the Rust code, name Rust files and Rust tests.

## Non-goals

- No behaviour change to the Rust gateway, its wire formats, schema, or the npm/Docker
  distribution, beyond what removing a reader of TS files requires.
- Not rewriting history: specs and plans under `docs/superpowers/`, audits and benchmark notes
  stay as they are (they are records, and name the code as it was).
- Not removing the console. `apps/dashboard` stays a React/Bun app built into the binary/image.
- Not removing the gateway's own refusal of `/api/plugins` / `plugin-assets` routes: 1.x keeps
  answering them as it does today.

## Anti-goals

- A Rust test that silently stops testing anything because its TS oracle went away. Each such
  test is either rewritten to a self-standing assertion of the same fact or deleted with a
  stated reason.
- A Rust build that still depends on a deleted path and is only caught by CI.
- A doc that still tells a contributor to edit, run or read a deleted TS file.

## What goes

- `apps/gateway`, `apps/cli`.
- `packages/{control,coord,providers,router,ratelimit,rtk,ponytail,testkit,store,ir,plugin-api,dashboard-sdk}`
  — all of `packages/`.
- Console plugin surface: `apps/dashboard/src/features/plugins/`,
  `src/routes/_app.plugins.$pluginId.tsx`, the plugin entries in `RailNav`, `usePlugins` and
  other plugin queries, `shared/` (the federation shims and `SHARED_IMPORTS` exist only so plugin
  bundles share React), the build/tooling paths that emit them, and their tests
  (`federation.test.ts`, `pluginChannels.test.tsx`, `pluginChannel.test.tsx`, plugin parts of
  `build.test.ts`, etc.). Whatever `live.tsx` / `queries.ts` used from the SDK that is **not**
  plugin-specific (the live connection, `Cadence`, `LiveContext`) moves into the console.
- Root scripts/config only the TS gateway used: `dev`/`start` scripts, `typecheck:core`, root
  `tsconfig.json` includes for deleted dirs, `scripts/build-binary.ts` (compiles the TS gateway),
  `scripts/bench-body-artifacts.ts` (imports `packages/store`), `scripts/dead-exports.ts` and
  `scripts/stale-claims.ts` if their only subject was the TS tree (judge each; keep and retarget
  if they still check something live), `scripts/test/providerCatalogData.test.ts` (TS vs JSON —
  the JSON is now the only source), `scripts/test/dockerManifests.test.ts` (TS workspace COPY
  lines), and any other `scripts/` file or test that only exercises deleted code.
- `release.yml`: the "Publish the plugin SDKs" step.
- Docs that are procedures for deleted code: `docs/writing-a-plugin.md`, `docs/plugins.md`,
  `docs/adding-a-provider.md` (rewrite for Rust instead if short; else delete and let CLAUDE.md
  point at the Rust provider layout), `docs/bun-builtins-audit.md`. README sections about
  plugins/TS install paths that are already marked "0.x" stay only as far as the 0.x upgrade note
  needs.

## What stays and moves

Rust files that read TS paths today, and what each becomes:

| Today | Becomes |
|---|---|
| `crates/omni-store/src/migrate.rs` `include_str!(…/packages/store/src/sqlite/migrations/…)` | SQL moved to `crates/omni-store/migrations/sqlite/`, same bytes, same file names |
| `crates/omni-store/src/pg/migrate.rs` (`…/postgres/migrations/…`) | `crates/omni-store/migrations/postgres/`, same bytes |
| `crates/omni-providers/tests/antigravity_codec.rs`, `openai_fingerprint_literals.rs` read `packages/providers/test/fixtures/*.json` | fixtures moved to `crates/omni-providers/tests/fixtures/`, same bytes |
| `crates/omni-coord/src/redis/scripts.rs` test reads `apps/gateway/src/coord/redis.ts` | assert the Lua scripts against a checked-in copy or a content hash, or delete the test if it only proved TS==Rust |
| `crates/omni-cli/src/context.rs` treats `apps/gateway/src/index.ts` in cwd as "this is an install root" | drop that marker (`.env` / `omnigateway.db` remain) |
| `crates/omni-gateway/src/lib.rs` looks for `../../apps/dashboard/dist` | unchanged — the console stays |
| `crates/omni-control/src/catalog.rs` header points at the TS registry | the JSON is the source; header says so |

Migration SQL must keep identical bytes: installed databases record applied migrations, and a
changed file is a different migration. Moving them is a path change only.

Also grep `crates/` for any other `include_str!`/`include_bytes!`/`read_to_string`/
`CARGO_MANIFEST_DIR` path into `apps/` or `packages/`, and for doc comments that *direct* a
reader to a TS file as the authority ("frozen TS", "mirrors packages/…"). Comments that only
record where a rule came from may name `bun-checkpoint`; comments that tell a reader to check a
TS file must change.

The console keeps importing nothing from `@omni/*`: the types and the small pure helpers it
imports today (`@omni/ir` `ProviderId`, `ErrorCode`, `LEVELS`; `@omni/store/types` `keyUsable`,
`servesTarget`, `quotaRolledOver`, `durationFor`, `quotaVerdict`, `sameWindow`,
`SAME_WINDOW_TOLERANCE_MS`, `GUARDRAIL_POLICY_MAX_CHARS`, `DEFAULT_SMART_ROUTER_POLICY`, …) are
copied into `apps/dashboard/src/` (wire types into `api/types.ts`, helpers into `lib/`), same
behaviour, with their tests. These helpers are single-copy rules in CLAUDE.md; after this the
console copy and the Rust copy are the two, and CLAUDE.md says which Rust function each mirrors.

**Mirror check (operator's decision).** Four TS tests hold the console's copies to the server
today — `apps/gateway/test/routes/{passwordPolicyMirror,providerIdMirror,
modelOverrideBoundsMirror,clientLogShape}.test.ts` — with `apps/dashboard/test/api/mirrors.test.ts`
as the console half. They are replaced by **one test on the console side that reads the Rust
source** (constants from the owning crate files and `crates/omni-control/data/
provider-catalog.json`) and compares each console copy: at least the four facts those tests pin
(minimum password length, provider-id pattern, per-model override bounds, client log row shape)
plus every constant newly copied by this work (e.g. `GUARDRAIL_POLICY_MAX_CHARS`,
`SAME_WINDOW_TOLERANCE_MS`, `DEFAULT_SMART_ROUTER_POLICY`, log `LEVELS`). Pure helpers with
logic (`keyUsable`, `quotaRolledOver`, `servesTarget`, …) are pinned by their console tests on
the same cases the Rust tests use; the check names the Rust test each mirrors. It runs in the
`verify` job. Reading Rust source from a console test is allowed; the reverse is not.

## Tooling after

- Root `package.json`: workspaces `["apps/dashboard"]` (or the console becomes the only package);
  scripts keep `build:dashboard`, `dev:dashboard`, `test` (console), `lint`, `fmt`, `typecheck`
  (console), `build:npm`; `bun.lock` regenerated by `bun install` — **this is the one change where
  `bun.lock` is staged**, regenerated from a clean install, never the stray local edit.
- `ci.yml` `verify` job: install, console tests, console typecheck, lint, the remaining `scripts/`
  tests. The `rust` job is unchanged.
- `Dockerfile`: the `base`/`build` stages copy only the console's manifest and sources; the
  `rust-build` stage copies the moved migration dirs (now inside `crates/`, so no extra COPY).
- `biome.json`, `tsconfig.base.json`, `.gitignore` entries for deleted paths cleaned up.

## Docs after

- **CLAUDE.md** is rewritten against the Rust tree: Scope lists the crates and the console;
  Commands are `cargo`/console commands; every architectural boundary, single-copy rule,
  invariant and "Pin:" names the Rust module and Rust test that holds it. A rule whose only pin
  was a deleted TS test either gets a Rust pin (find the Rust test that already holds it) or is
  rewritten as unpinned with that stated — never left naming a deleted file. Rules that only
  governed deleted code (plugin loader, plugin-api mirror, dashboard-sdk, TS-only traps such as
  Bun preload, `bun:sqlite` timeouts, Elysia) are removed. Keep its existing terse style and the
  "lean" rule at the top. Add one line: TS reference is `bun-checkpoint`.
- **ARCHITECTURE.md** is rewritten the same way: how the Rust crates fit together, request path,
  routing, dispatch, providers, storage, loops, push transport, console, clustering — naming Rust
  modules. Sections about plugins become a short "not supported in 1.x" note.
- `README.md`: remove contributor instructions that run TS (`bun run dev`, `bun apps/cli/…`);
  operator content unchanged.

## Verification

- `cargo build`, `cargo test --workspace` with PG17 + Valkey + fault server, `cargo clippy -D
  warnings`, `cargo fmt --check` — same pass count as before minus tests deliberately deleted
  (each listed with reason).
- Console: `bun run --cwd apps/dashboard test`, typecheck, production build; the built console
  served by the Rust gateway loads and has no plugin nav.
- `docker build .` succeeds and the image reaches `healthy`.
- `bun run build:npm` (or its test) still produces the four platform packages + main package.
- `git grep -n -E '(apps/(gateway|cli)|packages/)'` over CLAUDE.md, ARCHITECTURE.md,
  README.md, `.github/`, `Dockerfile`, `scripts/`, `apps/dashboard/` returns only intentional
  history references (e.g. "see `bun-checkpoint`"); over `crates/` the same grep on non-comment
  lines returns nothing (provenance comments stay, see below).
- Every deleted Rust test and every CLAUDE.md rule dropped or found divergent is listed in the
  final report with its reason.
- CI green on the PR.

## Calls made in writing this (controller's, not the operator's)

- **A CLAUDE.md/ARCHITECTURE.md rule Rust does not hold as written:** document what the Rust
  code actually does; never change Rust behaviour in this work (non-goal). Every such divergence
  goes in a "Divergences found" list in the final report, for the operator to decide on later.
- **`bun.lock`:** keep the existing lockfile and let `bun install` prune the deleted workspaces;
  console dependency versions must not move. No re-resolution.
- **`docs/plugins.md`:** deleted with the other plugin docs; README's `## Plugins` section and
  its `omni plugin …` row shrink to one note ("not supported in 1.x; the 0.x guide is on
  `bun-checkpoint`"), and the README links to it are removed.
- **Provenance comments in `crates/`** (~120 lines like "`oldestSince` in
  `packages/store/src/sqlite/usage.ts`") stay as they are: they record origin, and CLAUDE.md
  states once that a TS path in a crate comment refers to `bun-checkpoint`. Only comments that
  *direct* a reader to check a TS file change. The verification grep over `crates/` therefore
  applies to non-comment lines (paths in code, `include_str!`, `concat!`, `read_to_string`).

## Left to the builder

- Exact file layout inside `apps/dashboard/src/` for the copied helpers.
- Whether `stale-claims.ts` / `dead-exports.ts` survive retargeted at the console + scripts, or go.
- Order of the work and how it splits into commits/tasks.
