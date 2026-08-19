# Handoff — plugin host and the Pokémon companion

For the orchestrator picking this up. Written because the originating session ran
short of context, not because the work stalled.

**Branch:** `feat/plugin-host` · **PR:** [#78](https://github.com/harismawan/omnigateway/pull/78)
· 31 commits, 112 files, ~15.7k insertions.

**Green as of this writing:** `bun run test:all` → 2433 core + 391 dashboard + 14
plugin UI, `bun run typecheck` clean, `bun run lint` clean. Run all three before
believing anything below.

Delete this file when the work it describes is merged. It is a baton, not
documentation.

---

## What exists

A plugin host, and the companion as its first consumer. Both specs are in the
branch and are the authority over this file:

- `docs/superpowers/specs/2026-08-19-plugin-host-design.md`
- `docs/superpowers/specs/2026-08-19-pokemon-companion-plugin-design.md`

Shipped: manifest schema, boot loader, capability context
(`storage`/`files`/`net:outbound`/events), namespaced storage on its own
migration track, a bounded at-most-once event bus emitted from `finishLog`,
admin-gated route mounting, plugin UI served at `/plugin-assets/<id>/`, CLI
(`list`/`verify`/`install`/`remove --purge`) plus `doctor`, ESM federation of a
shared React runtime, console nav with lazy mount and an error boundary, and the
companion itself (pure game core, three tables, shop, grants, PokéAPI proxy, and
a console panel).

Docs are in four places on purpose: `CLAUDE.md` boundary 15 + traps,
`ARCHITECTURE.md#plugins`, `README.md#plugins` for operators, and
`docs/writing-a-plugin.md` for authors.

---

## In flight when this was written

**A subagent is adding install-from-URL and install-from-npm-name.** Check
`git status` first — if `packages/control/src/plugins.ts` and
`apps/cli/src/commands/plugins.ts` are dirty, it is unfinished or was
interrupted.

Its brief: `https://` tarball install (the `fetchBytes` dep and the `http://`
refusal already existed; the CLI injected no fetcher), plus `<name>` and
`<name>@<version>` resolved through the npm registry. Requirements it was given —
verify these hold before trusting it:

- Integrity verified against the packument's `dist.integrity`, refusing a
  mismatch **and** refusing when neither integrity nor shasum is present.
- `https://` only, including the resolved tarball URL.
- Registry injected, defaulting to `https://registry.npmjs.org`.
- A semver *range* is refused; exact version or `dist-tags.latest` only.
- Scoped names work — the leading `@` and the version `@` are different things.
- Nothing executes: no `npm` subprocess, no install scripts.

If it did not finish, its work is self-contained enough to redo from that list.

---

## Next, in order

### 1. Rename the two SDK packages to their public names

**Decided:** `@omni/plugins` → `@omnigateway/plugin-api`, and
`@omni/dashboard-sdk` → `@omnigateway/dashboard-sdk`.

Do this **after** the install subagent lands — 31 files reference these names and
two of them are files that subagent owns.

```bash
grep -rl "@omni/plugins\|@omni/dashboard-sdk" --include=*.ts --include=*.tsx --include=*.json . \
  | grep -v node_modules | grep -v graphify-out
```

Rename **in the workspace**, not at packaging time. The point is that
`plugins/pokemon` imports exactly what an external plugin imports; rewriting
names during the build would leave the companion on the internal name and hide
contract gaps — which has already happened once, see `WINDOW_MS` below.

Subpaths must survive: `@omnigateway/plugin-api/define`,
`/manifest`, `/version`. The `/define` split exists because importing the package
root pulls the manifest schema and with it zod — half a megabyte of validator into
a plugin bundle. There is a test and a doc line about this; keep both true.

### 2. Make them publishable

Both are `private: true` at version `0.0.0`, and `scripts/build-npm.ts` does not
ship them. **Until this is done no external plugin can be built at all** — the
companion only compiles because it is a workspace sibling.

- Drop `private`, set both to `1.0.0` — matching `PLUGIN_API_VERSION = 1` and
  `DASHBOARD_SDK_VERSION = "1.0.0"`. Deliberately *not* the gateway's `0.3.x`: a
  package whose npm version disagrees with the compatibility number it exports is
  two numbers for one thing.
- Publish from `.github/workflows/release.yml`, skipping a version already on npm
  so re-tagging the gateway does not try to republish an unchanged SDK.
- **`@omnigateway` is not a personal scope and does not exist yet.** Checked
  against the registry: both names are unpublished (404), `scope:omnigateway`
  returns zero packages, and `omnigateway` itself is maintained by **`harismawan`**
  — so the scope is not that account's own. Publishing under it needs an npm **org**
  named `omnigateway`, free for public packages, with `harismawan` as a member.
  That is an account action for a human, not a release-workflow change; nothing in
  CI can create it.
- **Trusted publishing is per package.** The workflow publishes with no token via
  OIDC, resolved from a policy configured on npmjs.com. A brand-new package name
  has no policy, so the first publish of each needs one created up front or a
  one-off granular token. This is the most likely thing to break the release.

### 3. Then extract the companion (agreed sequencing, not yet started)

Move `plugins/pokemon` to its own repository with its own CI and npm package,
**after** step 2 makes that possible. Keeping it in-repo one more cycle was
deliberate: the in-repo integration test caught a real design bug (see the candy
grants note below) while the host was still settling.

The evidence that extraction matters: `plugins/pokemon/src/grants.ts` imports
`WINDOW_MS` from `@omni/ratelimit/catalog` — a core package the host does **not**
re-export through the plugin API. It only compiles because workspace resolution
makes every internal package reachable. An external plugin could not do this. Fix
by re-exporting the rate-limit vocabulary through the plugin API, or by
amending the host spec to say plugins may depend on `@omni/ratelimit/catalog`
directly.

---

## Open review findings, deliberately deferred

Two review passes ran (host, then companion) and found four Criticals between
them, all fixed. These remain, all Minor:

- `PASSIVE_ITEMS` in `plugins/pokemon/src/balance.ts:146` is exported and unused.
- `MAX_TRANSITIONS_PER_ADVANCE` in `advance.ts` is unreachable by any test — every
  break path leaves no carry.
- The companion's UI implements roughly a third of its spec section: no rarity
  filter, no bag, no activity states. The plugin also has **no capability to
  enumerate API keys**, so the panel takes a key id as free text. That may be a
  genuine host gap worth a spec amendment rather than a UI task.
- Plugin UI federation is exercised in a built console, never in `vite dev`.

---

## Things this session learned the hard way

Read these before writing tests here. Ten tests were found that passed against
broken code, several written in this branch.

**Two shapes recur.** An assertion broad enough to be true whether or not the
behaviour is right (`expect(status).not.toBe(200)` was true of a 500-instead-of-401
bug). And two fixture values that happen to be equal, so swapping which one the
code reads is invisible — this appeared three separate times: `eggUsage` and
`progress`, a graduation `nature` equal to the parser's fallback, and incubated
tokens equal to earned tokens.

**Mutate before believing a test.** Every guard in this branch was checked by
breaking it and watching something go red. Guards that survived mutation were
**deleted**, not kept: a purchase transaction that could not protect against
anything, and two path checks `realpath` already decided. Decoration in a security
path invites the belief that something is being done.

**A literal `../` never reaches a route handler** — `URL` normalises it before
routing, so a 404 for that input proves nothing about your guard. Only
percent-encoded forms get there, and they arrive undecoded.

**Run the thing.** Four defects were found by curling a live gateway or building
a bundle, not by reading: plugin UI 404'd end to end for every spec-shaped
manifest; the catalog answered 500 instead of 401; `omni plugin install ./dist`
was refused because the installer takes the directory name from the source; and a
`:ro` Docker mount fails plugin *reads* as well as writes, because the files
capability calls `mkdir` on every call.

**Restoring after a mutation:** `cp` is aliased to `cp -i` in this environment and
silently prompts instead of overwriting, which stacks mutations and makes every
later result meaningless. Use `\cp -f` and verify with `sha256sum`. Never
`git checkout` — it destroys uncommitted work.

---

## Release state

`v0.3.0` was tagged from `main` **before** this PR and is published —
`omnigateway@0.3.0` on npm. It carries per-key rate limiting and does not contain
any of this branch. The tag message says so.

Note for whoever cuts the next one: `npm publish` in the release workflow passes
no `--tag`, so **any** version becomes `latest`, including a prerelease like
`v0.4.0-rc.1`. If you want to smoke-test a release from a branch, that needs
`--tag next` in the workflow first.
