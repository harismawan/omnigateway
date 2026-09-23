# Ponytail prompt injection

Date: 2026-08-29
Status: implemented

Corrections applied after review, recorded rather than rewritten away — the wrong
version of each was load-bearing enough that someone will meet it again:

- **The pin was wrong.** This document said upstream **v4.8.2**, taken from a
  release page rather than the repository. The vendored text is byte-identical
  to **v4.9.0** (blob `a3e4d94b…`); v4.8.2 carries a different blob. The header
  in `text.ts` now pins the blob, which is checkable, and treats the tag as the
  weaker human-readable claim.
- **The cost was understated.** "≈1,100 tokens" measured the body before the
  level directive was appended. Measured through `estimateInputTokens`: 1,229
  (lite), 1,232 (full), 1,243 (ultra).
- **`settingsSchema` is not top-level `.strict()`** — only `weights`, the
  retention schema and the key schemas are. The conclusion below is unchanged
  (the field is required like its neighbours), but the reason given for it was
  not the real one.
- **A case was missing entirely**: a breakpoint on a system block that is *not*
  the last one. See *Placement*.

## What this is

[Ponytail](https://github.com/DietrichGebert/ponytail) is not a service. It is a prompt
artifact: one ruleset telling a coding agent to behave like a lazy senior developer — a
seven-rung ladder from "does this need to exist at all" down to "the minimum code that
works" — plus three intensities and a set of per-tool wrappers (a Claude skill, a Cursor
rule, a Kiro steering file, an OpenCode plugin) that all inject the same text into the
system prompt.

Installing it means installing it once per tool, per machine, per developer. OmniGateway
sits on the one path every client's traffic already takes, so it can apply the ruleset for
all of them at once. This design does that: the gateway appends the ponytail ruleset to the
system prompt of requests passing through it, at an intensity the operator sets for the
installation.

The unit of work is one pure package and one dispatch call site. Everything else is the
configuration and observability those two need.

## Scope

In scope:

- A pure `@omni/ponytail` package holding the vendored ruleset and a pure injection function.
- One call site in `apps/gateway/src/dispatch/index.ts`, and one in the `count_tokens` route.
- One install-wide setting, reachable from the dashboard and the CLI.
- Per-request record of what was applied, on the existing `degradations` column.

Out of scope, and deliberately so:

- **Per-API-key control.** Global only. Adding it later means a third editable field on
  `api_keys`, which today carries exactly two (`limits`, `modelAllowlist`).
- **In-conversation switching.** Upstream's `/ponytail lite|full|ultra` and its
  "stop ponytail" escape hatch cannot work server-side; see *The text* for what replaces them.
- **Upstream's `audit` / `debt` / `gain` / `review` commands.** The gateway has no command
  channel to a coding agent.
- **Tracking upstream automatically.** The text is pinned and vendored.

This changes what the model is *told*. It is a guardrail, not a sandbox: a client that ships
its own conflicting rules ends up holding two rulesets unless the dedupe marker catches it.

## Why a pure package and not the adapter

Three shapes were considered.

**A pure package plus one dispatch call site** — chosen. It mirrors `packages/rtk`, which is
the same kind of thing: a pure request transform applied once in dispatch before routing.
Appending a `TextBlock` to `ChatRequest.system` and moving a `ContentBlock.cacheControl` are
both things the IR already expresses, so no provider branch enters a core module and the
OpenAI surface gets the feature for free.

**Folded into `packages/rtk`** — rejected. The wiring and report plumbing already exist
there, so it is less code, but rtk is tool-result filters; a system-prompt injector inside it
makes the package name false, and `RTK_FILTER_IDS` is a persisted storage contract this would
have to squat in.

**In the Anthropic adapter at wire time** — rejected. It would sit next to the auto-cache
logic it has to cooperate with, which is the one genuinely tricky interaction, but it is
provider-specific by construction: the OpenAI surface would silently not get it, and rule 16
forbids the branch. The cooperation turns out not to need it — see *Interaction with
auto-cache*.

## Package

```
packages/ponytail/
  src/catalog.ts   # leaf: PONYTAIL_MODES, PonytailMode, isPonytailMode
  src/text.ts      # vendored ruleset body, per-level directives, PONYTAIL_MARKER
  src/index.ts     # injectPonytail(request, { mode }) -> { request, report }
                   # ponytailNotes(report) -> readonly string[]   (degradation constants)
  test/inject.test.ts
```

`catalog.ts` imports nothing, so `@omni/store` imports that subpath alone — the arrangement
`@omni/rtk/catalog` and `@omni/ratelimit/catalog` already have, and for the same reason: the
mode string becomes a persisted settings value, so its union is a storage contract.
`index.ts` imports types from `@omni/ir` and nothing else. No I/O, no clock, no randomness,
like `ir`, `router`, `rtk` and `ratelimit`.

```ts
export const PONYTAIL_MODES = ["off", "lite", "full", "ultra"] as const;
export type PonytailMode = (typeof PONYTAIL_MODES)[number];

export type PonytailReport = {
  mode: PonytailMode;
  applied: boolean;
  cacheMarkerMoved: boolean;
  reason?: "disabled" | "already-present";
};

/** Keyed on the three levels that inject; "off" reaches no text. */
export const LEVEL: Record<Exclude<PonytailMode, "off">, string>;

/** Degradation entries for a report. Constants only; never interpolates request data. */
export function ponytailNotes(report: PonytailReport): readonly string[];

export function injectPonytail(
  request: ChatRequest,
  opts: { mode: PonytailMode },
): { request: ChatRequest; report: PonytailReport };
```

## Algorithm

1. `mode === "off"` → return the same object, `applied: false`, `reason: "disabled"`.
2. **Dedupe.** If any `system` block's text, or any `system`-role turn's text, contains
   `PONYTAIL_MARKER` → return unchanged, `reason: "already-present"`. The marker is
   `"You are a lazy senior developer."`, the opening line of every upstream wrapper, so one
   string catches the skill, the rule, the `.mdc` and the steering file alike.
3. Build one `TextBlock` holding `BODY + LEVEL[mode]` and append it, creating `system` if absent.
4. **Cache-marker move.** If the previously-last `system` block carried `cacheControl`, remove
   it from that block's copy and put the identical value — same `type`, same `ttl` — on the
   appended block. Read the breakpoint with `cacheControlOf` from `@omni/ir`, which is already
   the single site answering "what marker does this block carry"; a local union-narrowing helper
   would be a second copy that diverges the day a block type stops carrying one.
5. Report, including `cacheMarkerNotLast` — see below.

The injected block itself opens with the marker, so a request that somehow arrives carrying a
previous injection is treated as already-present. That is the wanted behaviour, and it makes the
function idempotent rather than merely once-per-request safe.

`ponytail:` ceiling on step 2: it scans `system` blocks and system-role turns, not user
turns, and a locally reworded copy will miss. Widen it to user turns if a client is found
that puts its rules there; the cost is a scan of the whole conversation per request.

### Placement, and why the marker moves

The block is appended after the client's own system blocks, so the ruleset has recency —
which is what its own "active every response, no drift" framing wants — and the client's
stable prefix stays byte-identical ahead of it.

Appending alone would leave it *outside* the cached prefix whenever the client marked its own
system prompt, which Claude Code, the primary client, does. At roughly 1,100 tokens that is
full-price input on every request from exactly the clients most likely to want the feature.
So the marker moves with the boundary.

**Only a marker on the *final* system block moves, and the other shape is reported, not repaired.**
If the client marked an earlier block, relocating that marker would enlarge what the caller chose
to cache by their own trailing blocks and not merely by our constant — so it stays where it is,
the ruleset lands outside the cached prefix, and roughly 1,240 tokens are billed fresh every
request. That reads identically to the cheap case from the outside, which is why it emits
`ponytail:cache-marker-not-last` rather than being absorbed silently. Repairing it would mean a
second breakpoint, which costs one of Anthropic's four.

**This is a named exception to "never second-guess a client's cache placement", and the second
one in this repo after `autoCacheEnabled`.** It is narrower than that one. The invariant is:
*the marker meant "cache through the end of system", and after injection it still does.* The
count of breakpoints does not change, the TTL does not change, no marker is invented where
there was none, and the content newly inside the prefix is a constant, so cache hit rate is
unchanged and the prefix strictly grows.

### Purity and failover

`injectPonytail` returns a new request. `system` is a fresh array and the block whose marker
moves is replaced by a copy, never mutated in place. This is the rule auto-cache learned by
breaking it: the IR object is shared across attempts, so anything written into it follows
failover into the next provider. The test pins it with a deep-frozen module fixture rather
than clone-and-diff — a fixture already handed to an earlier call is polluted before the diff
runs, which is how that assertion passed while comparing polluted to polluted.

### Interaction with auto-cache

Two cases, and the second is the one that could go wrong quietly.

- **Client marked nothing.** We move nothing. Anthropic's auto-cache pass runs later at wire
  time and marks the last system block, which is now ours. The ruleset lands inside the cached
  prefix with no extra code, and the added block is ~1,100 tokens, far past the 1024 minimum
  the system tier is gated on.
- **Client marked its own prompt.** We move that marker. `estimateCachedInputTokens` stays
  non-zero, so auto-cache still declines to fire. Moving a marker must never become a way to
  switch auto-cache on for a request that had its own placement.

## Call sites

`apps/gateway/src/dispatch/index.ts`, immediately after the existing `transformRequest` block:

```ts
const lazy = injectPonytail(transformed.request, { mode: snapshot.settings.ponytailMode });
dispatchRequest = lazy.request;
noteDegradations(ponytailNotes(lazy.report));
```

Once per request, before `resolveModel` and before ranking, so every attempt of a failover
reads the same prompt. Order against RTK does not matter behaviourally — RTK rewrites
`toolResult` content, ponytail touches `system` — and is fixed as RTK-then-ponytail only to be
deterministic.

`POST /v1/messages/count_tokens` (`apps/gateway/src/routes/proxy.ts`) estimates locally and
never dispatches, so with ponytail on it would under-report by the whole ruleset on every call
while the real request pays for it. The same pure function runs there before estimating, reading
the same `settings.ponytailMode` off the snapshot the route already holds. It writes no
degradations: that route creates no request-log row.

## Configuration

`Settings.ponytailMode: PonytailMode`, default `"off"` — the third request-rewriting flag,
beside `rtkEnabled` and `autoCacheEnabled`.

**Read boundary** (`packages/store/src/sqlite/config.ts`):

```ts
ponytailMode: isPonytailMode(stored.ponytailMode) ? stored.ponytailMode : "off",
```

This deliberately does not follow the fail-closed-by-throwing rule that `DIMENSIONS` and
`WINDOWS` follow. Those decide whether a request is *refused*, so a malformed value must not be
guessed at. This decides only whether the gateway rewrites a prompt, and every neighbouring
rewrite flag answers a malformed value with off: returning the installation to its pre-feature
behaviour costs an operator nothing they did not already have.

**Control** (`packages/control/src/schemas.ts`): `ponytailMode: z.enum(PONYTAIL_MODES)`,
required like `rtkEnabled` and `autoCacheEnabled` rather than optional like the retention pair.
An older caller omitting it therefore gets a loud `BAD_REQUEST` instead of a silent reset to
`off` — the same reasoning the retention comment already works through. A restored older
database has no such problem: it reads `off` through the config boundary, which is tested. `@omni/store/types` re-exports `PonytailMode` so the dashboard imports it from
a path it is already permitted, exactly as it does for `LimitConfig`.

**CLI, and a trap already documented as having happened once.**
`apps/cli/src/commands/settings.ts` picks its parse from the stored value's type — boolean, or
else `asNumber`. A string setting therefore goes through `Number("ultra")` → NaN, so
`ponytailMode` would ship unreachable from `omni settings set`, which is precisely the bug the
comment beside that line records `rtkEnabled` shipping with. Add a string arm validating
against the catalog, and a test that enumerates the keys of `DEFAULT_SETTINGS` and asserts each
one is settable — the point being that the next string setting cannot repeat this.

**Dashboard.** `SettingsBoard.tsx` already holds its draft as strings (`String(settings.rtkEnabled)`),
so a four-value control needs no new draft machinery: one field beside the RTK toggle, matching
whatever enumerated control `AgentSetup.tsx` already uses rather than adding a select primitive.
styled-components, no new dependency.

## Observability

No migration. `RequestLog.degradations` already exists as the persisted, operator-facing,
per-row channel for "the gateway changed your request" — auto-cache records
`anthropic:cache-breakpoint-added` there, which is an addition rather than a reduction, so this
widening of the column's meaning has precedent rather than being new. Dispatch's
`noteDegradations` appends and dedupes rather than assigning, so an entry added before the first
attempt survives failover.

Vocabulary, all constants, nothing interpolated — that array feeds an operator-facing column, so
request data in it would be a privacy change on the same terms as widening `LogFields`. The
mapping lives in `@omni/ponytail` as `ponytailNotes`, beside the text it describes, so the
vocabulary and the ruleset version stay in one place:

| Entry | Meaning |
|---|---|
| `ponytail:lite` / `ponytail:full` / `ponytail:ultra` | Applied at that level |
| `ponytail:already-present` | Dedupe skipped it |
| `ponytail:cache-marker-moved` | A client marker was moved onto our block |
| `ponytail:cache-marker-not-last` | A client marker sat earlier, so the ruleset is uncached |

Nothing is recorded when the mode is off. Absence is off, and a row per disabled request is
noise. `LogFields` is not widened: it carries no RTK fields either, and this needs no stdout line.

`ponytail:` ceiling: no column, no rollup counter. Add a real column when someone needs to
filter or aggregate the console log table by this.

## The text

`packages/ponytail/src/text.ts`, vendored from `.openclaw/skills/ponytail/SKILL.md` at upstream
**v4.8.2**, MIT, attribution and version pinned in a header comment.

Upstream's intensities are not three documents — they are one ruleset plus a level directive.
So the module is `BODY + LEVEL[mode]`, which keeps that structure and means a wording fix lands
once.

**Kept verbatim:** the seven-rung ladder, the "bug fix = root cause, not symptom" paragraph, the
rules list, the output pattern, "when NOT to be lazy", and the one-runnable-check requirement.

**Replaced, because server-side it would lie:**

- *Persistence, `/ponytail lite|full|ultra`, and "stop ponytail"* → one line stating the level is
  set by the gateway operator for this installation and cannot be changed from inside the
  conversation. A user who tries the documented escape hatch would otherwise believe it worked
  and keep getting lazy output.
- *The intensity table* → each mode ships only its own directive. The model cannot switch, so a
  table of the other two states describes places it cannot reach.

**Cut:** the frontmatter (skill metadata, not instruction) and the "pair with Caveman" boundaries
line (a cross-reference to a skill that is not here).

**Kept as a judgement call:** upstream's closing hardware-calibration paragraph (drifting clocks,
a PCA9685 running fast). It does not lie, so the "adapt only what would lie" rule keeps it, but it
is ~40 tokens of servo advice on every request through the gateway. Cutting it is a one-line
change if that trade reads wrong later.

**Cost, measured.** Body ≈ 4,900 characters ≈ **1,229–1,243 tokens per request** by
`estimateInputTokens`, depending on level. With the marker move
working as designed that is one cache write and roughly a tenth of that on each subsequent
request — which is what makes the exception in *Placement* worth its cost.

No drift test against upstream is possible without network in tests. The pin is a comment plus a
line in `docs/`, and the ceiling is named there.

## Testing

`packages/ponytail/test/inject.test.ts` — pure and fast:

- `off` returns the same object identity, `applied: false`
- each mode appends exactly one text block carrying that mode's directive
- absent `system` is created
- dedupe fires on a marker in a system block, and on one in a system-role turn
- a marked last block has its `cacheControl` moved: present on the new block, absent on the old,
  TTL preserved, breakpoint count unchanged
- an unmarked last block has no marker invented
- input immutability, pinned with a deep-frozen module fixture

`apps/gateway`:

- applied once per request on both the Anthropic and the OpenAI surface
- the degradation entries land on the request-log row, and none do when off
- auto-cache marks the ponytail block when the client marked nothing
- auto-cache still declines when the client marked its own prompt

  Both assert against the real Anthropic `toWire` through `wireFor`, reading system blocks from
  the **end** rather than by index: the OAuth leg prepends a billing header and two identity
  lines, so a fixed-length assertion fails for a reason that has nothing to do with this feature.
  Both were confirmed to fail when the marker move is removed.
- a failover sees identical system content on both attempts
- `count_tokens` includes the ruleset when on and excludes it when off

Store, control, CLI, dashboard:

- settings round-trip; a malformed stored value reads as `"off"`; the schema rejects an unknown mode
- `omni settings set ponytailMode ultra` works, plus the enumerate-every-key reachability test
- the settings control renders the current mode and saves the new one, under happy-dom

## Open questions

None. The hardware-paragraph trade under *The text* is recorded as a decision, not a question.

## History

Moved here from `CLAUDE.md` on 2026-09-03.

The header first said the vendored text was v4.8.2, read off a release page rather than the
repository, and that tag carries a different blob. Pin the blob (`a3e4d94b…`, tag v4.9.0), not
the release note.

`ponytail:cache-marker-not-last` is reported rather than absorbed because it otherwise reads
exactly like the cheap case: a breakpoint the client put on a system block that is not the final
one stays where it is, so the ruleset lands outside the prefix and is billed fresh, ~1,240 tokens
every request.
