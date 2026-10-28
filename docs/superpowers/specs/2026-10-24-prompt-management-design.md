# Prompt Management Design

Date: 2026-10-24
Status: draft

## Goal

Let the operator write their own system-prompt additions, keep every version of them, and have
the gateway append them to requests — install-wide, per API key, or both — the way it already
appends the ponytail ruleset.

The motivating case: an operator whose team all use coding agents through the gateway wants every
session to carry "our repo conventions: Bun not Node, no default exports, run `bun test` before
claiming done", and a stricter addendum on the keys handed to contractors. Today the only lever is
`ponytailMode`, one vendored text at three intensities, global. Editing it means a release.

This generalises ponytail rather than adding a neighbour: ponytail becomes three read-only entries
in a prompt library, and the existing `ponytailMode` setting keeps working.

Sibling designs: `2026-10-24-request-traceability-design.md` and
`2026-10-24-log-export-design.md`. This one adds one `request_logs` column that the export design
ships when present.

## Decisions

Settled during brainstorming:

- **Append only.** Prompts are appended after the client's own system prompt, exactly where
  ponytail goes today. No prepend (it would break the client's cached prefix on every request), no
  replace (Claude Code and Codex depend on their own system prompt to function).
- **Assignable globally and per API key.** Not per virtual model.
- **Versioned with rollback.** Every save creates an immutable version; one version per prompt is
  active; rollback is activating an older version.
- **Ponytail becomes built-in library entries**, read-only but duplicable into an editable prompt.
  `ponytailMode` is kept as a compatibility alias.

## Scope

In scope: a pure `@omni/prompts` package generalising `@omni/ponytail`'s injection, prompt and
version storage on both backends, global and per-key assignment, the dispatch and `count_tokens`
call sites, a `request_logs.prompts` column, admin API, a console Prompts screen, key and settings
editors, client-dashboard display, CLI, docs.

Out of scope:

- **Prepend and replace modes.**
- **Per-virtual-model assignment.**
- **Template variables** (`{{date}}`, `{{key.label}}`). Prompts are literal text. A variable
  language is its own design with its own injection risks.
- **Prompt fetch API for applications** (Langfuse-style "give me prompt X"). The gateway applies
  prompts; it does not serve them.
- **Pinning an assignment to a version.** An assignment names a prompt; the active version applies.
  Rollback is how an operator returns to an older text.
- **Evals, datasets, A/B splits between versions.**
- **Conditional application** (only for some models, only for some agents).
- **Tracking upstream ponytail.** The built-ins stay pinned to the vendored text.

This changes what the model is *told*. Like ponytail, it is a guardrail, not a sandbox: a client
can instruct against it, and a model may ignore it.

## Library

### Built-in prompts

Three entries defined in code, not rows: `ponytail-lite`, `ponytail-full`, `ponytail-ultra`. Their
text is `rulesetFor(level)` from `@omni/ponytail`, their single version is labelled with the
vendored pin (`v4.9.0`), they cannot be edited, deactivated or deleted, and they are listed first
with a "built-in" badge. **Duplicate** copies the text into a new user prompt (version 1) that can
then be edited freely; the copy does not carry the ponytail dedupe marker semantics (see
*Dedupe*).

### User prompts

New tables, both backends. SQLite migration `023_prompts.sql`, Postgres `011_prompts.sql`
(renumber to whatever is next when built).

`prompts`:

| Column | Meaning |
|---|---|
| `id` TEXT PK | slug, `[a-z0-9-]{1,40}`, not starting with `ponytail-` (reserved) |
| `name` | display name, 1..80 characters |
| `description` | optional, ≤ 500 characters |
| `active_version` | INTEGER NULL — null means drafted but never activated; it applies to nothing |
| `created_at`, `updated_at` | |

`prompt_versions`:

| Column | Meaning |
|---|---|
| `prompt_id`, `version` | PK; version starts at 1, increments per save |
| `text` | 1..16,000 characters after trimming trailing whitespace |
| `note` | optional change note, ≤ 200 characters |
| `created_at` | |

Versions are immutable: no update or delete of a single version. Deleting a prompt deletes its
versions and is refused (`CONFLICT`, naming the assignments) while the prompt is assigned anywhere.
At most 50 user prompts and 100 versions each; saving the 101st version deletes the oldest
version that is not active.

Saving offers **Save and activate** (default) and **Save as draft** (new version, active unchanged).
**Activate** on any listed version is rollback.

## Assignment

- **Global:** `Settings.prompts: string[]`, ordered, default `[]`, at most 5 ids.
- **Per key:** `ApiKey.prompts: { ids: string[]; inheritGlobal: boolean }`, default
  `{ ids: [], inheritGlobal: true }`, at most 5 ids. New column `api_keys.prompts TEXT` holding the
  JSON, nullable, null reads as the default. Editable after minting, written whole via
  `PUT /api/keys/:id/prompts`, settable at mint; the "editable fields" line in CLAUDE.md gains it.

**At most one `ponytail-*` built-in per list.** Both the settings schema and the key schema refuse
a list naming two (`BAD_REQUEST`). A stored list that holds two anyway (restored or hand-edited
database) keeps the first at read time.

**Effective list for a request** = (global list if `inheritGlobal`) followed by the key's ids,
de-duplicated keeping the first occurrence, then filtered to prompts that exist and have an active
version. At most one `ponytail-*` built-in survives: if both lists name one, the key's wins (it is
the more specific choice) and the global one is dropped.

A dangling id (deleted between read and write, restored database) is skipped and noted
(`prompt:missing`); it is not an error.

### `ponytailMode` compatibility

`ponytailMode` stays in `Settings`, the schema, the CLI and the API, as an alias of "which
ponytail built-in is in the global list":

- **Upgrade:** the first `getSettings` that finds `prompts` absent and `ponytailMode !== "off"`
  reads `prompts` as `["ponytail-<mode>"]`. The next settings write persists it.
- **Settings writes are whole-object** (`control/src/settings.ts`, and the CLI resubmits the
  current object with one field changed), so a write routinely carries a stale copy of whichever
  alias it did not mean to change. `putSettings` therefore compares each against the *stored*
  value, not against each other:
  - only `prompts` changed → keep it, recompute `ponytailMode` from it;
  - only `ponytailMode` changed → replace any `ponytail-*` id in the global list with the new
    level (or remove it for `off`), keeping its position, or append if none was present;
  - both changed → `prompts` wins and `ponytailMode` is recomputed from it;
  - neither changed → nothing to reconcile.
  Both are stored, always consistent with each other.
- **Rollback** to a build without prompt management therefore keeps the operator's ponytail level:
  the older build reads the mirrored `ponytailMode` and ignores `prompts`. User prompts and per-key
  assignments stop applying — fails open, stated in README's upgrade notes, same stance as
  guardrails.

The existing Settings "Lazy senior dev mode" select stays and edits `ponytailMode`; the new global
prompt list is beside it and shows the same change.

## Injection

### Package

`packages/prompts` replaces `injectPonytail` at both call sites; `@omni/ponytail` stays as the
home of the vendored text, `PONYTAIL_MARKER` and its catalog.

```ts
export type ResolvedPrompt = {
  id: string;            // "team-rules" | "ponytail-full"
  version: number | string; // 3 | "v4.9.0"
  text: string;
  marker?: string;       // dedupe marker; built-ins pass PONYTAIL_MARKER
};

export type PromptsReport = {
  applied: Array<{ id: string; version: number | string }>;
  skipped: Array<{ id: string; reason: "already-present" }>;
  cacheMarkerMoved: boolean;
  cacheMarkerNotLast: boolean;
};

export function injectPrompts(
  request: ChatRequest,
  prompts: readonly ResolvedPrompt[],
): { request: ChatRequest; report: PromptsReport };

export function promptNotes(report: PromptsReport): readonly string[]; // constants only
```

Pure, no I/O, deep-frozen-input test as `@omni/ponytail` has.

### Algorithm

1. Empty list → same object, nothing applied.
2. **Dedupe each prompt** (see below); drop the ones already present.
3. Join the survivors' texts, in list order, separated by a blank line, into **one** appended
   `TextBlock` — one block, so the cache-marker rule below is unchanged from ponytail and no extra
   breakpoint is ever needed.
4. **Cache-marker move**, exactly as ponytail: a marker on the previously-last system block moves to
   the appended block with the same type and TTL; a marker on an earlier block stays and is reported
   as `cacheMarkerNotLast`; no marker is invented. When the client marked nothing, Anthropic
   auto-cache *may* mark the appended block later — only if `autoCacheEnabled` is on and the system
   tier adds at least 1,024 estimated tokens past any earlier breakpoint
   (`providers/src/anthropic/wire.ts` ~529, ~557–563, ~733). Ponytail's ~1,240 tokens always
   cleared that bar; a short user prompt on a short client system prompt will not, and is then
   billed uncached. Accepted: the bar is auto-cache's, not this feature's, and the cost of a short
   prompt uncached is small.
5. Total appended text is capped at 32,000 characters: prompts that would exceed it are dropped from
   the end of the list and noted (`prompt:over-budget`). The cap is a constant.

### Dedupe

- A prompt with a `marker` (the ponytail built-ins) is present if any system block or system-role
  turn contains the marker — today's ponytail rule, unchanged, so a client with the ponytail skill
  installed still is not given the ruleset twice.
- A prompt without one is present if any system block or system-role turn contains its full text
  (trimmed). This is also what makes injection idempotent.

### Call sites

- `apps/gateway/src/dispatch/index.ts`, where `injectPonytail` runs today (after RTK, before
  `resolveModel`, once per request so failover attempts send identical bytes). Dispatch receives the
  effective list through a new `DispatchOptions.prompts: readonly ResolvedPrompt[]`; `proxy.ts
  handle()` resolves it from the authenticated key and the snapshot. `requestTransforms: false`
  (guardrail and smart-router classifier calls) still means nothing is injected.
- `POST /v1/messages/count_tokens` (`routes/proxy.ts`), as ponytail does today, so the estimate
  includes the prompts the real request will pay for.

Prompt texts and the global list live in the routing snapshot, so cluster nodes pick up edits
through the existing `routing` pubsub invalidation; keys are already read per request.

### Screening does not see operator prompts

Guardrail judging and smart-router confidentiality screening run in `proxy.ts` before dispatch
(~697–773) and examine the client's request; prompts are appended later, in dispatch. That order
stays. Operator prompts are the operator's own text, written knowing which providers the gateway
routes to, so they are deliberately exempt from both: a guardrail never refuses a request because
of the operator's addendum, and smart routing never reroutes one to the local model because of it.
A request that screening *does* reroute still gets its prompts, on the local model. README says
in one sentence: do not put confidential material in a managed prompt.

## Observability

- New column `request_logs.prompts TEXT NOT NULL DEFAULT '[]'` — JSON array of `"<id>@<version>"`
  actually applied, in order (`["ponytail-full@v4.9.0","team-rules@3"]`). Same migration as the
  tables. Filterable in the console (`prompt:team-rules`), exported by the log-export design.
- Degradations (constants only): `prompt:cache-marker-moved`, `prompt:cache-marker-not-last`,
  `prompt:already-present`, `prompt:missing`, `prompt:over-budget`.
- For continuity with dashboards and tests that key on them, applying a ponytail built-in still adds
  `ponytail:<level>`, and its dedupe still adds `ponytail:already-present`. The `ponytail:cache-*`
  notes are replaced by the `prompt:` ones.
- Nothing is recorded when no prompt applies.

## Surfaces

### Admin API and control

Reads `requireReader`, writes `requireAdmin`; every write emits `changed("res:prompts")` and a
routing change.

- `GET /api/prompts` — library with built-ins, active version, assignment counts
- `GET /api/prompts/:id` — with version list (text included)
- `POST /api/prompts` — `{ id, name, description?, text, note?, activate }`
- `PUT /api/prompts/:id` — name and description only
- `POST /api/prompts/:id/versions` — `{ text, note?, activate }`
- `PUT /api/prompts/:id/active` — `{ version }` (rollback)
- `POST /api/prompts/:id/duplicate` — `{ id, name }`, works on built-ins
- `DELETE /api/prompts/:id` — `CONFLICT` while assigned
- `PUT /api/keys/:id/prompts` — `{ ids, inheritGlobal }`, both required
- Global list rides `PUT /api/settings` as `prompts`.

Zod schemas strict, no defaults on the per-key body, like the other key setters.

### Console

*Operator decision:* prompt management is its own page with its own menu entry, titled **Prompt
Management** — not a section of Settings.

**Navigation.** A new entry in `DESTINATIONS` (`apps/dashboard/src/components/RailNav.tsx`):
`{ to: "/prompts", label: "Prompt Management", blurb: "System-prompt additions, versions, and where
they apply", Icon: <a lucide icon such as ScrollText's sibling MessageSquareText> }`, placed after
**Keys** and before **Usage** — it belongs with the setup screens (Accounts, Models, Keys), ahead of
the watching ones. A new route file `apps/dashboard/src/routes/prompts.tsx` and a feature directory
`apps/dashboard/src/features/prompts/`, following the existing `features/<name>/<Name>Board.tsx`
pattern. Readers can open the page; editing controls are disabled for them, as on the other boards.

**The page has three areas:**

1. **Library** — list of prompts, built-ins first with a "built-in" badge, each showing name, active
   version, estimated tokens and "Used by: global, N keys". Actions: New prompt, Duplicate (works
   on built-ins), Delete (disabled with the reason while assigned).
2. **Editor** (opens for the selected prompt) — name and description; a textarea with character
   count and estimated token count; change note; **Save and activate** / **Save as draft**; a version
   history panel with a diff against the previous version and an **Activate** button per version
   (rollback). Built-ins open read-only with only Duplicate available.
3. **Assignments** — where prompts apply:
   - **Global prompts:** the ordered multi-select for `Settings.prompts`, with the total estimated
     token cost per request. The existing **"Lazy senior dev mode"** select moves here from the
     Settings screen, directly above the list, since it is the same setting seen through its alias
     (choosing a level updates the list and vice versa, per *`ponytailMode` compatibility*).
   - **Per key:** a read-only table of keys that have prompts or have turned off "Also apply global
     prompts", each with its effective list; a row links to that key's "Edit prompts" dialog on the
     Keys screen.

**Elsewhere in the console**, only what belongs to those screens stays:

- **Settings:** no prompt controls any more. Where the ponytail select used to be, one line of text
  links to Prompt Management ("Prompt injection, including ponytail, moved to Prompt Management").
- **Keys:** the "Edit prompts" dialog per key stays here (it edits a key, like the other key
  dialogs): ordered multi-select, "Also apply global prompts" toggle, the resulting effective list
  previewed, and a link to Prompt Management to edit the prompts themselves.
- **Logs:** applied prompts as chips in the request detail, each linking to that prompt and version
  on Prompt Management; `prompt:` filter term.

### Client dashboard

`readOwnKey` includes the key's effective prompt list with names and active texts, read-only — the
key holder is entitled to know what their model is being told, as with guardrail policies. Their
logs show the `prompts` column.

### CLI

`omni prompts list | show <id> [--version n] | create <id> --name … (--file f | stdin) [--draft] |
save <id> (--file f | stdin) [--note …] [--draft] | activate <id> <version> | duplicate <src>
<id> | remove <id>`; `omni keys prompts <id> --ids a,b [--no-global]`; `omni settings set prompts
a,b`.

### Database snapshots

`prompts` and `prompt_versions` are included in snapshots and restore.

## Testing

- `@omni/prompts`: empty list identity; one block for several prompts in order; marker dedupe for
  built-ins and full-text dedupe for user prompts; idempotence; cache-marker move, not-last report,
  no invented marker; over-budget drop from the end; deep-frozen input; notes are constants.
- Effective-list resolution: inherit on/off, ordering, de-duplication, one ponytail built-in with key
  precedence, dangling ids noted.
- `ponytailMode` compatibility: upgrade read, alias writes in both directions, rollback read by a
  build that knows only `ponytailMode` (fixture database).
- Store contract on both backends: prompt CRUD, version immutability, active pointer, 100-version
  pruning keeps the active one, delete refused while assigned, key column round-trip, snapshot
  restore.
- Gateway: prompts applied on all three surfaces, streaming and not; failover sends identical system
  content; classifier calls get none; `count_tokens` includes them; `request_logs.prompts` written;
  an edit on one node applies on another after the routing change.
- The existing ponytail gateway tests keep passing through the alias.
- Console: the rail shows **Prompt Management** between Keys and Usage and routes to `/prompts`;
  editor save paths (activate and draft), rollback, built-ins read-only with Duplicate; the global
  list and the ponytail select on the page stay in sync both ways; Settings no longer renders any
  prompt control and links to the page; key dialog effective preview; log chips link to the prompt
  version; a reader sees the page with editing disabled.

## Docs

README (operator section, rollback note), `ARCHITECTURE.md` (transform stage), the ponytail spec's
History gains a line pointing here, CLAUDE.md (editable key fields, the reserved `ponytail-` prefix).

## Left to the builder

Diff rendering in the console; the page's exact layout (tabs or stacked panels) and icon; token
estimate via `estimateInputTokens`; separator between joined
prompts; whether built-ins are surfaced through the same repository interface or merged in control;
CLI flag spelling; exact pruning query.

## Calls made by the designer, not the operator

- Multiple prompts are joined into one appended block.
- Effective list is global-then-key, `inheritGlobal` per key defaulting to true; at most one ponytail
  built-in, key wins.
- Limits: 5 assigned globally, 5 per key, 50 prompts, 100 versions each, 16,000 characters per
  version, 32,000 characters injected per request.
- Full-text dedupe for user prompts; marker dedupe only for built-ins.
- `ponytailMode` kept and mirrored for rollback; user prompts fail open on rollback; on a write,
  whichever alias differs from the stored value wins, `prompts` if both do.
- At most one ponytail built-in per list, enforced at write.
- Operator prompts are exempt from guardrail and smart-router screening.
- Short prompts may go uncached when auto-cache's 1,024-token bar is not met; accepted.
- No version pinning; drafts allowed; delete refused while assigned.
- Key holders can read the prompts applied to their key.
- `ponytail:<level>` degradations kept for continuity; cache notes renamed to `prompt:`.
- `ponytail-` id prefix reserved.
- *Operator decision:* a dedicated **Prompt Management** page and menu entry. Designer's calls within
  it: route `/prompts`, placed after Keys; the ponytail select and the global list move there from
  Settings; per-key editing stays a Keys dialog, summarised read-only on the page.

## Implementation clarifications — 2026-10-27

These are controller rulings for implementation, not additional decisions attributed to the operator.
They resolve ambiguities in the earlier draft; the later dedicated-page decision supersedes the
earlier statement that the Settings select stays in place.

- Use SQLite `024_prompts.sql`, Postgres `013_prompts.sql`, and the actual dashboard route convention
  `apps/dashboard/src/routes/_app.prompts.tsx`. Export `rulesetFor` publicly from `@omni/ponytail`;
  retain the vendored `v4.9.0` pin. `@omni/prompts` remains pure.
- `PromptsReport.skipped[].reason` is `"already-present" | "over-budget"`. Resolution reports missing
  or inactive assignments separately through the constant `prompt:missing`; injection reports only
  what it actually applied or skipped. Budget after dedupe, including the two-character blank-line
  separators; on the first overflow, discard that survivor and the whole remaining suffix.
- Save text with `trimEnd()`, preserve leading whitespace, reject whitespace-only text, and measure
  the 16,000-character limit after `trimEnd()`. Full-text dedupe uses the saved text's trimmed form.
  Duplicating an active user prompt copies its active version; duplicating a never-active draft
  copies its latest saved version. Copies never inherit built-in marker semantics.
- Reconcile the two settings aliases in shared `mergeSettings`, using the stored settings read
  inside SQLite's immediate transaction or Postgres's settings-row lock. Omitted `prompts` from
  older clients must not erase assignments. An explicit prompts list is authoritative on read;
  only absence triggers the legacy ponytail upgrade.
- Persisted malformed assignment JSON normalizes to defaults, invalid IDs are skipped, duplicate
  IDs keep their first occurrence, and only the first built-in per stored list survives. API writes
  reject invalid shapes, IDs, limits, and multiple built-ins rather than repairing them silently.
- Assignment counts mean explicit global-list membership and explicit key-list membership across
  **all** keys, including expired/revoked keys; they are not counts of effective inheritance.
  Assignment to an inactive draft still blocks deletion. Show effective lists separately.
- Versions are immutable inserts, numbered `MAX(version) + 1` under the mutation lock. Prune the
  oldest nonactive versions to 100 in that same transaction. Serialize the 50-prompt cap and
  delete/assignment races. Postgres prompt deletion and every global/key assignment writer take
  the same advisory management lock **before** settings, key, prompt, or config-version locks;
  SQLite uses immediate transactions. Recheck assignments under that lock, not in control alone.
  The plan's race-resolution choice is to refuse newly added references to missing user prompts
  under that lock, while allowing an unchanged restored dangling reference to remain; if assignment
  wins the race, deletion is refused, and if deletion wins, the new assignment is refused.
- `listActive()` is the only prompt-text repository read used by routing-snapshot construction.
  Request handling resolves once from a snapshot and the authenticated key, then passes the same
  immutable resolved list into dispatch/failover; `count_tokens` uses the identical resolver and
  injector. No version-history request-path reads. Emit local routing changes and add Postgres
  config-version triggers for both new tables so remote nodes refresh as well.
- `requestTransforms: false` always overrides a supplied prompt list. Screening examines only the
  client's request; a screened request rerouted locally still receives managed prompts afterward.
  Record **actually applied** `id@version` values, not configured/effective candidates, including
  failures after injection. The implementation must explicitly retain injection state before model
  resolution, carry it into the first pending route log, and use it in the route's terminal catch
  even when dispatch throws before returning an outcome; pre-injection refusals record `[]`.
- Carry applied IDs explicitly through the export record, OTLP attributes, CSV, JSONL, and client
  log projection. `prompt:<id>` matches an exact ID before `@`, never an arbitrary substring.
- The holder's own summary exposes effective names and active texts only, never the global library
  or other keys. Client log chips are read-only and must not link into console prompt routes.
  Targeted invalidation of the holder's own summary is permitted for policy freshness; invalidation
  frames carry no other-key identifiers or prompt text. Preserve `Settings.prompts` when unrelated
  Settings controls save their whole object, despite moving all prompt controls to the new page.
- Slug recreation after deletion is allowed. Historical deleted/pruned versions display
  **unavailable**, never fall back to current text; persisted `id@version` cannot prove incarnation
  after slug reuse, so do not promise historical text recovery in that case.
- Snapshots include both tables without adding them to `REQUIRED_TABLES` (old snapshots remain
  valid and migrate on restore). Backend copy imports all retained versions with original numbers,
  timestamps, and active pointer **before** settings/key assignments, and rejects a target already
  containing user prompts. Do not rebuild history through ordinary save/activate operations.
