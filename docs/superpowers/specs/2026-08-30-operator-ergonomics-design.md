# Operator ergonomics: plugin update, restore preview, a version that answers, and the OAuth vendor data

## Problem

Four gaps, surfaced by one review pass, sharing a shape: the operation exists,
but only if the operator carries state the installation should be carrying.

1. **Updating a plugin means remembering how it was installed.**
   `installPlugin` (`packages/control/src/plugins.ts`) accepts a directory, a
   tarball path, an `https://` URL, or an npm name — and records none of them.
   `PluginInstallResult` reports what happened; nothing persists where the
   bytes came from. Picking up a patch release means retyping the original
   spec, and getting it slightly wrong installs a second plugin beside the
   first.

2. **`omni db restore` confirms before it informs.** The command asks `y/N`
   and only afterwards reports `result.counts` — the row counts `inspect`
   read from the snapshot (`packages/control/src/database.ts`). The operator
   judges blast radius on the snapshot's id and mtime alone, for the one CLI
   operation that is explicitly irreversible-by-confirmation.

3. **No surface names the installed version.** `omni --version` prints the
   compiled `VERSION` constant, which no release step substitutes (a defect
   being fixed separately; this spec assumes that fix). Even once it prints
   the truth, `omni doctor` — the diagnostic bundle operators actually paste
   into reports — never mentions it.

4. **Rule 16's last enumerated exception is still standing.**
   `OAUTH_PROVIDERS` in `packages/control/src/oauth/index.ts` plus five
   vendor modules (`anthropic.ts`, `grok.ts`, `kilo.ts`, `kimi.ts`,
   `openai.ts`) compile vendor URLs, scopes and client ids into core. The
   *mechanism* stopped being a violation when the five built-ins were ported
   onto the plugin contract — each is a `PluginOAuthFlow` wrapped by
   `oauthAdapter` — but the vendor data itself remains, and CLAUDE.md names
   it as the violation with no carve-out.

The first three are features; the fourth is the completion of a migration
whose hard half already shipped.

## What this adds

```
omni plugin update <id>      # reinstall from the recorded source
omni db restore <id>         # now shows a live-vs-snapshot count table first
omni db restore <id> --dry-run
omni doctor                  # first line names the CLI/gateway version
```

And `packages/control/src/oauth/` shrinks to the mechanism — flows, adapter,
requests, pending — with the five vendor modules moving to
`packages/providers/src/<provider>/oauth.ts`, where rule 2 says provider wire
detail belongs.

## Design

### 1. `omni plugin update <id>`

**Record the source at install time.** `installPlugin` writes one extra file
into the staging tree before the rename: `.omni-install.json`, holding

```json
{ "spec": "<as typed>", "installedAt": "<ISO>", "version": "<manifest.version>" }
```

On disk beside the plugin rather than in the database, deliberately. Plugins
live in `<root>/plugins/` and survive database restores that predate them —
the documented orphan-tables case is exactly a database and a plugin directory
travelling separately. A source recorded in the database would be the one
piece of the plugin that vanishes on restore. Inside the plugin's own
directory, the record participates in the atomic rename: an install that fails
halfway leaves the previous version's record serving, same as the previous
version's code.

The spec is recorded **as typed**, not as resolved. `omni plugin install
poke-dex` should update to the current release; `omni plugin install
poke-dex@1.2.0` should reinstall 1.2.0 exactly and say so. Recording the
resolved version would silently pin every install.

**The command.** `omni plugin update <id>` reads
`<root>/plugins/<id>/.omni-install.json` and re-runs `installPlugin` with the
recorded spec. Three refusals, each an error the operator can act on:

- No such plugin directory: same error `omni plugin remove` gives.
- Directory exists, no record: the plugin was hand-copied or predates this
  change. The error says both the fact and the repair — reinstall once with
  `omni plugin install <spec>` to seed the record.
- The record's manifest id disagrees with `<id>` after download:
  `installPlugin` already refuses this; the refusal passes through unchanged.

`restartRequired` stays true; update is install. The loader must ignore
`.omni-install.json`, which it already does — it reads `manifest.json` and the
entries the manifest names, nothing else. `safeParseManifest`'s `entrySchema`
cannot name a dot-prefixed path, so no manifest can claim the record as an
entry point.

**Out of scope here:** no `update --all`, no version-range policy, no
lockfile. One plugin, one recorded spec, one reinstall.

### 2. `omni db restore` preview and `--dry-run`

`restoreSnapshot` already runs `deps.store.maintenance.inspect` over the
candidate file and refuses non-databases and failed integrity checks before
any swap. The preview is that same inspection surfaced earlier, plus the same
inspection run against the live database file for the other column.

**Control.** A new `previewRestore(deps, id)` in
`packages/control/src/database.ts` performs the candidate validation
`restoreSnapshot` performs — same copy-in, same `inspect`, same refusals — and
stops where the swap would begin, returning

```ts
{ snapshot: Record<string, number>; live: Record<string, number> }
```

It reuses the existing single-flight guard: a preview racing a real restore is
the same two-writers hazard the guard exists for, and a preview that holds the
guard briefly is cheaper than one that reads a file mid-swap. Any working copy
it takes on the way in is removed before it returns — a dry run that leaves a
database-sized file behind is a dry run only in name.

**CLI.** `omni db restore <id>` prints the two-column count table (tables
union'd from both sides, absent rendered as `—`) *before* the `y/N` prompt,
so the confirmation is informed in the default flow, not only under a flag.
`--dry-run` prints the same table and exits 0 without prompting; `--yes`
continues to answer the prompt, unchanged. The refusal while a gateway is
running stays exactly as it is and applies to `--dry-run` too: the check is
about who may open the file, not about what happens after, and a preview that
sometimes lies about openability is worse than one that makes the operator
stop the gateway first.

### 3. Version in `omni doctor`

Gated on the `--version` fix landing (build-time injection of the release
version into the CLI bundle). Once `run.ts` resolves a real version, `doctor`
prints it as its first line:

```
omni <version>
```

Same resolved value, one copy — `doctor` imports whatever `run.ts` exports,
never re-derives it. The gateway's own version is the same number by
construction (one tag builds both), so no second line claims otherwise.
`omni doctor --json` carries it as `version`, because the JSON form is what
ends up in scripts and issue templates.

### 4. The OAuth vendor data leaves core

**What moves.** Each of the five vendor modules in
`packages/control/src/oauth/` becomes
`packages/providers/src/<provider>/oauth.ts`, exporting the same
`PluginOAuthFlow` it exports today. Vendor URLs, scopes and client ids land in
the one package rule 2 already designates for provider wire detail. Each
module moves into its own provider's directory — never a shared oauth
helper directory — because rule 2's no-cross-import clause is what lets a
provider become a standalone plugin later, and OAuth endpoints are as much
that provider's wire surface as its SSE framing.

**How they register.** `OAUTH_PROVIDERS` stops being a five-key literal and
becomes an empty null-prototype registry that `registerOAuthProvider` fills.
The built-ins are seeded by one function, `builtinOAuthFlows()` in
`@omni/providers`, returning the five `(id, flow)` pairs; the gateway seeds at
boot in `apps/gateway/src/index.ts` before `loadPlugins`, and the CLI seeds in
its context construction, because `omni connect` runs without a gateway. One
seed function, two callers, zero copies of the list.

Two traps, both with prior incidents on file:

- **No module-scope snapshot of the registry.** Six sites have now been wrong
  by walking a provider table at import time. `oauthProviderIds()` already
  answers at call time; nothing in this migration may reintroduce an
  `Object.keys` at module scope, including in the seed path.
- **`trusted` stays true for the five.** `oauthAdapter` sets
  `gatewayAuthored` only for trusted flows. The built-ins remain
  repository-authored after the move — their text is still ours — so they
  keep `trusted: true`. A plugin-declared flow keeps `trusted: false`. The
  flag follows authorship, not packaging.

**What does not change.** The flows themselves — the move is `git mv` plus
import paths. Each provider's OAuth test file moves alongside and stays
otherwise unchanged, which is the same proof the original port used: the
mutants those tests kill (dropped `client_id`, dropped beta header, state
check off, kilo's second request unauthenticated, and the rest) must still
die from the new location. `pluginFlow.ts`, `requests.ts`, `pending.ts`,
`refresh.ts` stay in `packages/control` — they are mechanism, not vendor data,
and control importing `@omni/providers` for the seed follows the precedent
`catalog.ts` set with `PROVIDER_ID_PATTERN`.

**What this closes.** After the move, rule 16's paragraph about
`control/src/oauth/` reduces to its two `=== "custom"` branches and the
`schemas.ts` rule — the "per-provider OAuth subsystem" clause deletes. The
CLAUDE.md edit lands in the same change, because a rule describing a violation
that no longer exists is the inverse of the mistake that section warns about,
and both mislead.

## Sequencing

Independent except where stated: 1 and 2 in any order; 3 after the
`--version` fix; 4 alone and last, since it touches the release surface
(`@omni/providers` is not published, so no package version moves, but the
seeding order in `index.ts` sits beside the channel-registry-before-
`loadPlugins` rule and deserves the same care).

## Testing

- **Plugin update.** Injected `PluginDeps` throughout, per rule 11 — no test
  starts a process or touches a real registry. Install writes the record;
  update from an npm spec re-resolves; update from an exact spec reinstalls
  that version; missing record refuses with the reinstall hint; a failed
  update leaves the previous tree and its record intact (the staging-rename
  invariant, asserted again from the update path).
- **Restore preview.** Snapshot and live counts disagree in the fixture — a
  preview asserted on identical counts passes with the columns swapped.
  `--dry-run` leaves no working copy behind (assert the directory listing,
  not the happy-path return). Preview under the single-flight guard refuses
  concurrent restore, same as two restores refuse each other.
- **Doctor version.** The bundled artifact's `doctor --json` reports the tag
  passed to `build-npm.ts`, alongside the equivalent `--version` assertion —
  drift-detection shape, like `publishable.test.ts`.
- **OAuth move.** The five provider test files pass unmoved-in-substance from
  their new homes. One new test: a gateway booted with the seed and a CLI
  context built with the seed answer the same `oauthProviderIds()`, because
  two callers of one seed is still a pair that can drift in wiring. The
  existing `providerTables.test.ts` walk discovers the registry in its new
  shape or fails — do not exempt it.

## Out of scope

- **No plugin auto-update or update-on-boot.** Update runs when the operator
  runs it; the gateway never mutates its own plugins directory.
- **No registry metadata beyond the typed spec.** No etags, no digests of
  the previous install, no channel/tag tracking. The record answers "what
  would I retype" and nothing else.
- **No restore-while-running for the CLI**, dry-run included, as above.
- **No plugin-supplied redaction, origins widening, or other rule 15/16
  loosening** riding along with the OAuth move. The migration relocates
  bytes; every boundary check (`origins` allowlist, yield caps, return-shape
  validation) is untouched.
