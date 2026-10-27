# Task 10 — database-move integrity, rollout docs, final gate

Status: DONE_WITH_CONCERNS (pre-existing diagnostics only; controller whole-branch review pending).
Base: `cce1e147e3360daf1b7dcd6c8824adca3746feb8`. No subagents or push.

## Changes / interfaces

- `packages/control/src/copyStore.ts`: `CopyCounts` gains `prompts: number` and
  `promptVersions: number`, counting user tables only, independent of built-ins. Empty-target
  preflight includes `target.prompts.list()`. Fetch every source detail and validate nonempty/capped
  retained history, parent IDs, unique positive safe version numbers and retained active pointer
  before writing. Exact `PromptRepo.importRow(PromptDetail)` precedes settings/key assignments;
  no save/activate reconstruction. Existing log append preserves applied IDs.
- `packages/control/test/copyStore.test.ts`: SQLite→SQLite, SQLite→real PG, real PG→SQLite
  preserve exact `1,4..102` versions/texts/notes/timestamps, active v1, inactive draft, counts,
  global/key assignments, applied log IDs and next v103. Separate prompt-only-target preflight
  scenarios prove refusal before settings/password writes. Invalid/vanished later detail proves
  earlier valid history has not been partially imported.
- `apps/gateway/test/routes/database.test.ts`: actual HTTP snapshot/restore retains exact draft and
  active history, assignments and log IDs through held repo/method forwarders. A pre-feature file
  (both tables/columns and migration 24 removed) passes inspection, restores, migrates and accepts
  new prompt writes. `REQUIRED_TABLES` remains unchanged.
- `packages/store/test/contract/maintenance.test.ts`: both-backend table inventory/reopen and held
  forwarder coverage. `packages/control/test/database.test.ts`: preview/restore propagate counts.
  `packages/store/test/contract/prompts.test.ts`: delete/recreate resets history as permitted.
- README: creation, draft/rollback, ordered assignments, limits/token/cache cost, own-key visibility,
  non-sandbox/confidential-text warning, legacy upgrade/fail-open rollback, retention/unavailable/
  slug-incarnation limitation. Architecture: pure stage, cached active map, locks/invalidation,
  IDs/export and exact-copy/snapshot contracts. CLAUDE: pure package/catalog boundary, reserved
  prefix, sixth editable field, locked alias invariant and pins. Ponytail spec History points to
  managed-prompt spec without inventing operator approval.

## Deferred minor closures

- Task 6 `apps/gateway/test/e2e/clientSurface.test.ts`: HTTP filter test now wraps its real store
  lifetime in `try/finally { h.store.close(); }`, including assertion failures. Existing 30-assertion
  forwarding/privacy boundary test retained; focused and full suites pass.
- Task 9 `apps/cli/src/commands/prompts.ts`: only create/save mark `file` as multiple, preserving
  occurrences through existing parser; `readText` rejects >1 before any input/store effect. No
  global parser change. Regression covers both verbs, split/equals, file/file, file/stdin and
  stdin/stdin forms, exit 2, zero injected input/store/other effects, unchanged stored history and
  no new prompt. RED: prior implementation exits 0; GREEN: all eight combinations refuse.

## Environment and service verification

- Current isolated `feat/prompt-management` worktree; Linux x64, Bun `1.4.4 (38afee6c8)`.
- Confirmed harness names by reading `packages/store/test/contract/harness.ts`, control copy test,
  gateway coord/cluster tests: **`OMNI_TEST_DATABASE_URL`**, **`OMNI_TEST_REDIS_URL`** (not production
  variables). Only the operator-authorized disposable endpoints were used; harness drops public
  schema, Redis tests exercise shared coordination.
- Before destructive harness, ran this read-only service probe successfully (repeated after full
  gate into `task-10-services.log`):

```sh
bun -e 'import {SQL,RedisClient} from "bun"; console.log("bun",Bun.version,"platform",process.platform,process.arch); const db = new SQL({url:"postgres://postgres:omni@127.0.0.1:55434/omni",max:1}); console.log(await db`select version(), current_database(), inet_server_port()`); await db.close(); const r = new RedisClient("redis://127.0.0.1:56379"); console.log("Valkey",await r.send("PING",[]),await r.send("INFO",["server"])); r.close();'
```

PostgreSQL **17.11**, database `omni`, mapped external port 55434/internal 5432; Valkey **8.1.11**,
`PONG`, mapped 56379/internal 6379. Probe exit 0. Initial probe omitted only the Bun/platform print.

## RED / GREEN commands and evidence

Every log path below is relative to `.superpowers/sdd/2026-10-27-prompt-management/`.
Commands run from repository root; test commands use this exact prefix (`SERVICES` below is notation,
not an actual harness variable):

```sh
OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379
```

- RED, with that prefix:
  `bun test packages/control/test/copyStore.test.ts packages/store/test/contract/maintenance.test.ts apps/gateway/test/routes/database.test.ts`
  → **49 pass, 8 fail**, 273 assertions, 57 tests/3 files (`task-10-red.log`). Failures are missing
  counts, assignment-before-library on three directions, prompt-only preflight on three directions,
  and invalid source history accepted. Snapshot/compatibility/forwarders already passed, so no
  unnecessary store production change was made.
- Minor RED: `bun test apps/cli/test/prompts.test.ts` → **13 pass, 1 fail**, 166 assertions
  (`task-10-minor-red.log`), duplicate source exits 0 instead of 2.
- Final focused GREEN, with service prefix:
  `bun test packages/control/test/copyStore.test.ts packages/store/test/contract/maintenance.test.ts apps/gateway/test/routes/database.test.ts packages/store/test/contract/prompts.test.ts packages/store/test/contract/promptSettings.test.ts packages/control/test/prompts.test.ts apps/gateway/test/routes/promptsProxy.test.ts packages/control/test/database.test.ts apps/cli/test/prompts.test.ts apps/gateway/test/e2e/clientSurface.test.ts`
  → **257 pass, 0 fail, 0 skips**, 1,355 assertions, 10 files, 18.54s (`task-10-green.log`).

## Full gate — separate invocations, all exit 0

Output was redirected using `> <log> 2>&1`; exit status preserved for full-gate commands.

| Exact command | Result | Output |
|---|---|---|
| `bun install --frozen-lockfile` | 296 installs/289 packages, no changes | `task-10-install.log` |
| `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379 bun run test:all` | Core **5845 pass/0 fail**, 56,653 assertions, 353 files, 212.75s; dashboard **869 pass/0 fail**, 2,723 assertions, 54 files, 68.47s; **0 skips**, actual PG/Redis enabled | `task-10-suite.log` |
| `bun run typecheck` | 759 core + 221 dashboard files, no type errors | `task-10-types.log` |
| `bun run lint` | 997 files, zero diagnostics | `task-10-lint.log` |
| `bun run check:claims` | no stale claims, 24 removed symbols checked | `task-10-claims.log` |
| `bun run check:dead` | no dead exports, 287 changed files checked | `task-10-dead.log` |
| `bun run build:dashboard` | production build/typecheck successful | `task-10-dashboard.log` |

Initial `test:all` invocation hit the tool's 120,000ms timeout and was SIGTERM-terminated, not a pass;
rerun used 600,000ms and completed above (same output path replaced). No lockfile or tracked
generated output changes. `git diff --check` exit 0. Formatting uses targeted `bunx biome check
--write` only; final format output (`task-10-format.log`) has zero diagnostics.

## Self-review / concerns

- Reviewed task diff and bindings: imports occur before both assignment paths, exact numbers and
  all parent/history fields round-trip, user-only target refuses, held forwarders follow swaps,
  migration-001 required set untouched, CLI fix transport-local and privacy-safe.
- Full dashboard suite includes Task 7 unavailable/pruned/deleted-history regressions; they continue
  to show **Version unavailable**, not active text. Slug reuse limitation intentionally documented,
  not expanded into incarnation IDs.
- Existing diagnostics remain, not hidden: core negative history test prints `missing-base` stderr
  (also recorded in Task 9 service-suite evidence); dashboard error-boundary tests print expected
  catalog errors and `/keys/keys` route warnings (also in `task-9-dashboard.log`); production build
  prints existing `_app.tsx` **AppShell not code-split** advisory (also in `task-8-build.log` and Task 7
  build logs). No new lint warning. Dead checker retains two explicit `unchecked` common-word
  notices (`state`, `note`), not a clean claim about those two exports.
- Copy is not an online transactional database-wide snapshot/merge; callers must keep installations
  quiescent as with the existing backend move. No concurrency model expansion here.
- Controller whole-branch independent review is still required by the brief; not delegated here
  because this implementer was explicitly forbidden subagents. No functional blocker observed.

## Review fix round 1 — base `9a48f913`

Important finding verified: a valid restored source may retain missing global/key IDs, but normal
target assignment writes treated them as new references and failed after library import. Fixed
without dropping IDs or refusing that supported dataset.

- New internal `ConfigRepo.importSettings(settings: Settings): Promise<void>` writes a normalized
  source snapshot rather than merging aliases/retention against unrelated target defaults.
- `KeyRepo.importRow(row: ApiKey, mode?: "restore")` preserves restored dangling assignments only
  when explicitly called with internal restore mode. Default import, create, setters, HTTP and CLI
  behavior stay unchanged. Limits and uniqueness checks still apply.
- Both backends use existing mutation lock rules: SQLite immediate transactions; PG management
  advisory lock before settings/key/config-version writes. No temporary unlocked assignment writes.
  SQLite forwarders carry the new method and mode across reopen.
- Copy fetches source settings before the first write, imports library first, then uses these internal
  restore paths. All existing retained-history prevalidation remains; key limits parsing and duplicate
  ID/hash checks are now performed for the entire batch before any library write.
- Tests: dangling global+key lists with valid retained library survive SQLite→SQLite, SQLite→PG and
  PG→SQLite exactly; alias remains `full` despite target `ultra`, retention marker `123` remains exact
  despite one-day retention. Runtime resolver skips missing IDs with `prompt:missing`, keeps valid
  text and key built-in override. Ordinary writers accept unchanged restored IDs but still reject
  **new** missing IDs; default key import refuses dangling IDs and assigned deletion stays refused.
  Both-store contracts exercise held repo forwarders, duplicate import atomicity, explicit empty-list
  alias authority; PG waiter tests prove each restore path waits on management lock before writing.
  Deterministic unreadable-limit/duplicate key batch failures leave target library/keys/password empty.
- Minor architecture correction: built-in composition is now attributed to proxy, not `buildSnapshot`.
  Architecture also names the internal restore contracts and ordinary-write boundary.

### Round 1 commands / output

All logs remain under `.superpowers/sdd/2026-10-27-prompt-management/`. Environment is unchanged:
Bun 1.4.4 Linux x64, authorized disposable PG17 at 55434 and Valkey at 56379. Before destructive
harness, ran this read-only probe → PG **17.11**/database `omni`, Redis **PONG**, exit 0
(`task-10-round1-services.log`):

```sh
bun -e 'import {SQL,RedisClient} from "bun"; const s=new SQL({url:"postgres://postgres:omni@127.0.0.1:55434/omni",max:1}); console.log(await s`select version(),current_database()`);await s.close();const r=new RedisClient("redis://127.0.0.1:56379");console.log(await r.send("PING",[]));r.close()'
```

Every test invocation below used the exact environment prefix:
`OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379`.

- RED: `bun test packages/control/test/copyStore.test.ts packages/store/test/contract/prompts.test.ts`
  → **43 pass, 5 fail**, 282 assertions, 48 tests/2 files (`task-10-round1-red.log`). Three copy
  directions reproduce `PromptStoreError: missing`; two contracts fail on not-yet-implemented
  restore method. Initial GREEN after implementation → **50 pass, 0 fail**, 335 assertions, including
  PG lock waiters (`task-10-round1-green-initial.log`).
- Final focused GREEN:
  `bun test packages/control/test/copyStore.test.ts packages/store/test/contract/maintenance.test.ts apps/gateway/test/routes/database.test.ts packages/store/test/contract/prompts.test.ts packages/store/test/contract/promptSettings.test.ts packages/control/test/prompts.test.ts apps/gateway/test/routes/promptsProxy.test.ts packages/control/test/database.test.ts apps/cli/test/prompts.test.ts apps/gateway/test/e2e/clientSurface.test.ts`
  → **265 pass, 0 fail, 0 skips**, 1,419 assertions, 10 files, 19.69s (`task-10-round1-green.log`).

All full gates rerun separately, exit **0**, output redirected with status preserved:

| Command | Result | Log |
|---|---|---|
| `bun install --frozen-lockfile` | 296 installs/289 packages; no changes | `task-10-round1-install.log` |
| `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379 bun run test:all` | **5853 core pass**, 56,719 assertions, 353 files, 217.61s; **869 dashboard pass**, 2,725 assertions, 54 files, 68.73s; **0 failures/skips** | `task-10-round1-suite.log` |
| `bun run typecheck` | 759 core + 221 dashboard files; no errors | `task-10-round1-types.log` |
| `bun run lint` | 997 files; zero diagnostics | `task-10-round1-lint.log` |
| `bun run check:claims` | no stale claims; 24 symbols | `task-10-round1-claims.log` |
| `bun run check:dead` | no dead exports; 287 changed files | `task-10-round1-dead.log` |
| `bun run build:dashboard` | production build/typecheck successful | `task-10-round1-dashboard.log` |

Self-review: only explicit internal restore paths bypass reference existence; both retain the same
transaction/lock and commit-time invalidation as ordinary writes. Existing API/CLI call sites never
pass restore mode. `git diff --check` passes; no lockfile/generated output changes. Existing negative
history stderr, dashboard error-boundary/act diagnostics, `AppShell` code-split advisory and two dead
checker common-word notices remain the previously documented baseline, not new regressions.
Controller whole-branch review remains pending; no subagents or push.
