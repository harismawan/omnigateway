# Handoff — plugin host and the Pokémon companion

For the orchestrator picking this up. Written because the originating session ran
short of context, not because the work stalled.

**Branch:** `feat/plugin-host` · **PR:** [#78](https://github.com/harismawan/omnigateway/pull/78)
· 37 commits.

**Green as of this writing:** `bun run test:all` → 2493 core + 391 dashboard + 37
plugin UI, `bun run typecheck` clean, `bun run lint` clean. Run all three before
believing anything below.

**One unexplained failure, once.** A single core test failed in one run and has
not reproduced in ten since, and the run scrolled before the name was captured.
It is recorded rather than dismissed: if you see a core failure that vanishes on
re-run, it is probably this one and it is worth naming, not re-running until it
is green.

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

## Install from a URL or an npm name — landed

`omni plugin install` now takes a directory, a local tarball, an `https://` URL,
or a package name, tried in that order. Filesystem-first is the safe order: a
published package must never shadow the directory an operator is standing in.

Three refusals carry it, all before the bytes are fetched — the tarball host is
pinned to the registry's (port included), integrity is required rather than
preferred, and only exact versions or `dist-tags.latest` resolve. Nothing
executes: two fetches, a digest, and the tar reader that already existed.

Verified independently of the subagent that wrote it, because its own mutation
list is the thing under test: three mutations it did *not* enumerate — stripping
the port from the host pin, decoding SRI as hex instead of base64, and comparing
digests by length instead of value — each turned the suite red, and the file
restored to its original `sha256`.

---

## Next, in order

### 1. ~~Rename the two SDK packages~~ — done

`@omni/plugins` → `@omnigateway/plugin-api` (directory `packages/plugins` →
`packages/plugin-api` too, because a directory named `plugins` beside the
top-level `plugins/` of *installed* plugins was a coin-flip for a reader), and
`@omni/dashboard-sdk` → `@omnigateway/dashboard-sdk`. 35 files, done in the
workspace rather than at packaging time so `plugins/pokemon` imports exactly what
an external plugin will. All four subpaths survive and are in use:
`@omnigateway/plugin-api`, `/define`, `/manifest`, `/version`.

### 2. ~~Make them publishable~~ — done in the repo, blocked on an account

Both carry real versions, metadata and READMEs, and `release.yml` publishes each
if its version is not already on npm. `npm pack --dry-run` gives 9.8 KB and
9.1 KB — sources, README, LICENSE, nothing else.

The versions are `PLUGIN_API_VERSION` and `DASHBOARD_SDK_VERSION`, not the
gateway's tag, and `packages/plugin-api/test/publishable.test.ts` pins them there
along with the rule that broke this once: a published package may name no
unpublished one, checked in its dependencies *and* in its source, because a
type-only import needs no dependency entry and ships a specifier nobody can
resolve.

**Two things remain and neither is a code change.** They are the reason nothing
is published yet.

- **The `@omnigateway` scope does not exist.** Both names are unpublished (404),
  `scope:omnigateway` returns zero packages, and `omnigateway` itself is
  maintained by **`harismawan`** — so the scope is not that account's own.
  Publishing needs an npm **org** of that name, free for public packages, with
  `harismawan` as a member.
- **Trusted publishing is configured per package.** The workflow publishes with
  no token, via OIDC against a policy set on npmjs.com. A brand-new package name
  has no policy, so each of these needs one created before its first publish or
  the step fails on permissions without saying why.

Until both are done, tagging a release runs the new step, finds nothing published,
attempts a publish, and fails. Do the account work first or expect a red release.

### 3. Then extract the companion (agreed sequencing, not yet started)

Move `plugins/pokemon` to its own repository with its own CI and npm package,
**after** step 2 makes that possible. Keeping it in-repo one more cycle was
deliberate: the in-repo integration test caught a real design bug (see the candy
grants note below) while the host was still settling.

The companion no longer depends on anything internal — `plugins/pokemon`'s only
dependency is `@omnigateway/plugin-api`. That was not true a few commits ago and
it is what makes extraction a move rather than a rewrite.

What it took is worth reading before the move, because the same trap is waiting
for anyone who writes the next plugin. `grants.ts` imported `WINDOW_MS` from
`@omni/ratelimit/catalog`, whose first line is `import { z } from "zod"`. One
three-entry duration table put **564 KB** and 550 occurrences of zod into the
companion's server bundle, defeating the entire reason the `/define` split
exists, and nothing failed — it typechecked, the suite was green, and a doc went
on claiming a 31 KB bundle for as long as it was false. Removing the import takes
the same build to **36 KB**. Both numbers are measured, not reasoned.

The plugin API now declares the limit vocabulary itself. The rate limiter stays
the source of truth (`DIMENSIONS` and `WINDOWS` are the JSON keys of
`api_keys.limits`), the API mirrors it, and two things keep the mirror honest:
the host's emit site fails to compile if a window is added to one and not the
other, and `apps/gateway/test/plugins/limitVocabulary.test.ts` pins the durations,
which no type can see.

---

## Open review findings, deliberately deferred

Two review passes ran (host, then companion) and found four Criticals between
them, all fixed. `PASSIVE_ITEMS` and `MAX_TRANSITIONS_PER_ADVANCE` are now dealt
with — the first deleted after a test pinned the allowlist that was doing its
job, the second covered by a test that feeds `advance` a corrupt 500-stage path.
These remain, both Minor:

- The plugin has **no capability to enumerate API keys**, so the panel takes a key
  id as free text. This is the last real gap in the companion's UI and it is
  probably a host gap rather than a UI task: a `keys:read` capability is a
  widening of the plugin contract and wants a spec amendment before code.
- Plugin UI federation is exercised in a built console, never in `vite dev`.

The bag, the Dex rarity filter and the activity state are done. `focus` — one of
the six states the spec names — is deliberately not implemented: it can only mean
a burst of recent requests, and the plugin stores one instant per key and no
per-request history, so it would either never fire or fire arbitrarily. If you
want it, that is a storage change, not a UI one.

---

## Things this session learned the hard way

Read these before writing tests here. Ten tests were found that passed against
broken code, several written in this branch.

**Three shapes recur.** An assertion broad enough to be true whether or not the
behaviour is right (`expect(status).not.toBe(200)` was true of a 500-instead-of-401
bug). Two fixture values that happen to be equal, so swapping which one the code
reads is invisible — this appeared three separate times: `eggUsage` and
`progress`, a graduation `nature` equal to the parser's fallback, and incubated
tokens equal to earned tokens.

And the one that is hardest to see, because every individual test looks careful:
**a fixture that never holds the two values whose confusion is the bug.** The Dex
filter's predicate was `e.rarity === filter`; mutating it to `.includes(filter)`
passed all 36 UI tests. `"uncommon".includes("common")` is true, so filtering to
`common` would have shown every uncommon graduate — but the shared fixture had no
`uncommon` entry, and no test ever filtered to `common`. Four tests covered that
filter and none of them could fail. When a value is compared against a set, ask
which *pair* in that set could be confused, and put both in one fixture.

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
