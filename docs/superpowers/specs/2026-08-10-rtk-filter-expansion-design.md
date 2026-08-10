# RTK Filter Expansion Design

## Summary

Expand OmniGateway's built-in RTK tool-result compression from its initial ten filter families to a
broader conservative catalog for common coding-agent output. New coverage focuses on Bun,
lint/typecheck diagnostics, test runners, package managers, directory listings, Git operations, and
Docker builds.

The expansion preserves the existing security and correctness posture:

- built-in deterministic filters only;
- historical non-error tool results only;
- immutable canonical-IR transformation;
- explicit cache-control preservation;
- bounded synchronous processing;
- strict nonempty and strictly-shorter acceptance;
- no raw-output storage, custom rules, model calls, network, filesystem, or subprocesses;
- no command, path, tool identifier, or content persistence.

New higher-risk families are command-gated: they require a correlated, confirmed-shell tool call and
an exact recognized command family. Unknown-origin results do not become eligible for new filters.
Existing output-inferred Git/build/test/path behavior is hardened in the same change.

This design extends
`docs/superpowers/specs/2026-08-10-rtk-tool-result-compression-design.md`; unchanged decisions from
that specification remain authoritative.

## Research Basis

The catalog was compared with:

- upstream `rtk-ai/rtk` v0.45.0;
- OmniRoute's TypeScript RTK engine;
- 9Router's JavaScript RTK port;
- current OmniGateway RTK production code and tests.

Upstream RTK often injects structured-output flags and retains recoverable raw output. OmniGateway
cannot do either because it transforms already-recorded tool results and intentionally stores no
prompt content. Therefore this design borrows command families, semantic anchors, and adversarial
fixtures, but rejects upstream filters whose safety depends on command rewriting or raw recovery.

Cloud-provider output, infrastructure plans, database rows, arbitrary HTTP bodies, JSON,
environment output, SSH-wrapped commands, and generic stack-trace filtering remain out of scope.
Their omitted fields can change operational meaning, and their upstream implementations rely heavily
on recovery paths OmniGateway does not have.

## Goals

- Cover high-frequency coding-agent output absent from the initial catalog.
- Close known Bun command and output gaps.
- Preserve actionable diagnostics, failures, summaries, artifacts, refs, and package changes.
- Make filter growth auditable through a typed family registry and focused modules.
- Harden current unknown-origin detection and known-non-shell exclusions.
- Eliminate duplicated runtime filter-ID allowlists across RTK and store.
- Add the safety, invariance, and client-surface tests omitted from the initial implementation.

## Non-Goals

- User, project, or administrator-defined filters.
- One telemetry ID per tool or command subtype.
- Raw-output retention, recovery, or preview APIs.
- Semantic/model-based compression.
- Command execution, shell interception, or command rewriting.
- Full shell parsing.
- Generic log normalization by UUID, number, address, or path.
- Cloud, IaC, database, HTTP, arbitrary JSON, environment, or remote-shell filtering.
- Daily RTK analytics or new prompt-content telemetry.

## Public Filter Catalog

The existing family IDs remain:

- `git-diff`
- `git-status`
- `git-log`
- `grep`
- `path-list`
- `numbered-read`
- `build-output`
- `test-output`
- `deduplicate-log`
- `smart-truncate`

Add five family-level IDs:

- `lint-output`
- `package-output`
- `tree-output`
- `git-operation`
- `docker-build`

Tool-specific recognition remains internal. TypeScript and Biome report `lint-output`; Vitest and
pytest report `test-output`; Bun and Cargo build output report `build-output`. This intentionally
changes future `tsc` applications from `build-output` to `lint-output`; historical request rows retain
the IDs recorded when they were written.

Export one immutable runtime catalog from a leaf `@omni/rtk/catalog` subpath:

```ts
export const RTK_FILTER_IDS = [
  "git-diff",
  "git-status",
  "git-log",
  "grep",
  "path-list",
  "numbered-read",
  "build-output",
  "test-output",
  "deduplicate-log",
  "smart-truncate",
  "lint-output",
  "package-output",
  "tree-output",
  "git-operation",
  "docker-build",
] as const;
export type RtkFilterId = (typeof RTK_FILTER_IDS)[number];
export function isRtkFilterId(value: unknown): value is RtkFilterId;
```

`@omni/rtk/catalog` contains only this constant, type, and validator and imports no transformer or IR
code. Store runtime code imports that leaf instead of maintaining a duplicate list. Dashboard
continues importing request-log types only through `@omni/store/types`; the catalog change must not
pull runtime store or RTK transformation code into the browser. Adding IDs requires no SQL migration
because `rtkFilters` remains validated JSON text. Existing request-log fields and dashboard rendering
require no schema change.

## Package Structure

Refactor the current single implementation file into focused pure units:

```text
packages/rtk/src/
  index.ts                 public API and copy-on-write request traversal
  catalog.ts               filter IDs and registry ordering
  command.ts               bounded command classification
  correlation.ts           tool-use/result provenance
  detect.ts                existing output-inferred detector coordination
  filters/
    shared.ts              bounded line, diagnostic, omission, ANSI utilities
    git.ts                 diff/status/log hardening and operations
    search.ts              grep, path list, tree, long listing
    diagnostics.ts         lint and TypeScript families
    tests.ts               Bun/Vitest/Jest/pytest/Go
    build.ts               Bun/Cargo/common build and Docker
    packages.ts            Bun/npm/pnpm/yarn/Cargo/pip/uv
    generic.ts             exact dedup and shell-only smart truncation
```

Exact filenames may combine tightly coupled small units, but each module must have one clear family
responsibility. No module may import gateway, store, router, providers, process, filesystem,
network, timers, or logging.

Each specialized registry entry follows this conceptual contract:

```ts
interface FilterDefinition {
  readonly id: RtkFilterId;
  detect(context: DetectionContext): DetectionResult | null;
  compress(text: string, context: FilterContext): string;
}
```

`DetectionResult` carries an internal subtype and parser evidence; it never enters telemetry.
Exactly one specialized family wins per block. Build/test/lint/package/Docker output may then run
only the existing exact consecutive-line deduplicator as a bounded post-pass. No specialized output
feeds generic smart truncation.

## Command Classification

### Input and bounds

Classification receives command text only from an earlier correlated confirmed-shell tool use. It
inspects at most 16,384 UTF-16 code units and 256 lexical tokens. Exceeding either bound makes the
command unrecognized rather than partially classified.

The classifier is a deterministic tokenizer, not a complete shell parser. It recognizes quoted
words and separators needed for common wrappers, but does not expand variables, substitutions,
globs, aliases, redirections, or shell functions.

### Supported wrappers

The classifier may skip:

- leading `NAME=value` environment assignments;
- `env` with assignments and only `-i`, `--ignore-environment`, `-u NAME`, `--unset=NAME`, or `--`;
- `timeout` with only `-s SIGNAL`, `--signal=SIGNAL`, `-k DURATION`, `--kill-after=DURATION`, `--`,
  and one required duration operand;
- one leading `cd <path> &&` segment.

After those wrappers, exactly one output-producing command is allowed. Any additional `&&`, `;`,
pipe, background operator, redirection, command substitution, process substitution, or unrecognized
segment makes classification fail closed. This prevents mixed output from being assigned to one
family.

Recognized execution wrappers include:

- `bun run [--] <script>`;
- `bun x [--bun] [--] <executable>`;
- `bunx [--bun] [--] <executable>`;
- `npx [--yes|-y] [--] <executable>`.

Every wrapper requires exactly one executable or script token at the specified position. Unsupported
options, options with unknown arity, missing operands, or malformed quoting make classification fail
closed. Option parsing stops at `--`; later tokens belong to the wrapped executable.

Classification matches exact executable and subcommand tokens. Prefix matching such as
`startsWith("git diff")` is removed so names like `git different-command` cannot match.

### Shell and non-shell aliases

Existing exact normalized shell names remain. Additional shell aliases may be added only with
client fixtures proving they execute arbitrary commands.

Expand the exact known-non-shell catalog with fixture-backed names such as:

- `read_file`
- `list_directory`
- `find_files`
- `code_search`
- `apply_patch`

Normalization remains lowercase plus separator normalization. Substring matching remains forbidden.
Unrecognized names remain unknown.

## Detection Policy

### New families

All five new family IDs are command-gated. Their detector runs only when:

1. a preceding tool use correlates by ID;
2. its normalized tool name is in the exact shell allowlist;
3. command extraction succeeds;
4. bounded command classification selects a recognized family.

Output shape may confirm a subtype after command classification, but output alone cannot activate a
new family.

### Existing families

Existing build/test output inference remains available for unknown-origin results only through these
closed qualifying combinations:

| Subtype | Required independent anchors |
|---|---|
| Bun build | one Bun invocation/banner row **and** one artifact/bundle/final-build row |
| Cargo build | one `Compiling`/`Checking`/Cargo invocation row **and** one `Finished` or Rust diagnostic-code/source-frame row |
| Generic compiler | two coordinate-bearing diagnostics with compiler codes, or one such diagnostic **and** one explicit build summary |
| Bun/Vitest/Jest | one runner/banner or suite-file row **and** one structured pass/fail/test-file summary |
| pytest | one pytest session/collection row **and** one short-test-summary or passed/failed/error count row |
| Go test | one `=== RUN`/package result row **and** one `--- PASS/FAIL`, `ok`, `FAIL`, or package-summary row |

Anchors in one row count once even when it matches multiple regexes. Generic words such as `FAIL`,
`Error:`, `warning:`, `Checked N files`, or `passed` are never independent anchors by themselves.
Unknown-origin inference is not added for lint, package, tree, Git-operation, or Docker families.

Unknown-origin Git inference is hardened:

- diff requires `diff --git` plus a file pair or hunk marker;
- status requires a branch/category marker plus a status entry;
- log requires a commit header plus author/date/subject evidence.

Correlated exact Git commands may classify without those output combinations.

Unknown-origin path inference requires:

- at least ten nonempty candidate rows;
- at least 80% path-shaped rows;
- no more than 10% prose-shaped rows;
- no diagnostic, JSON-object, Markdown-fence, or table-header conflict.

Numbered reads continue to require confirmed shell origin. Generic deduplication and smart
truncation continue to require confirmed shell origin.

### Priority

Specialized priority becomes:

1. Git diff
2. Git status
3. Git log
4. Git operation
5. Docker build
6. package output
7. lint/typecheck output
8. build output
9. test output
10. grep
11. tree/long listing
12. path list
13. numbered read

Priority-specific adversarial tests cover overlapping strings. For example, a Git diff containing
compiler output stays `git-diff`; `bun run test` routes to `test-output`, not `build-output`.

## Filter Families

### Bun and common build output

Enhance `build-output` subtypes for:

- `bun run` non-test scripts;
- `bun build`;
- Cargo build/check;
- common compiler summaries.

Preserve:

- emitted artifact paths, sizes, targets, and sourcemaps;
- file/line/column diagnostics;
- diagnostic codes and multiline source frames;
- warning and error continuation notes;
- panic/cause chains;
- final build status and duration.

Collapse only recognized progress, repeated compile/download rows, and exact duplicate lines.

Script wrappers are classified by a closed script-name grammar because RTK cannot read package
manifests. `bun run` and `npm run` route to tests only for exact names `test`, `test:unit`,
`test:integration`, `test:e2e`, or names beginning `test:`. They route to lint only for `lint`,
`typecheck`, `check`, names beginning `lint:`, or names beginning `typecheck:`. Other script names stay
`build-output`. `bun x`, `bunx`, and `npx` route by their directly present wrapped executable.

### Lint and typecheck output

`lint-output` initially recognizes this exact command matrix:

| Subtype | Accepted token forms |
|---|---|
| TypeScript | `tsc`, `tsc --noEmit`, wrapped executable `tsc`, approved lint script names above |
| Biome | `biome check`, `biome lint`, wrapped executable `biome` with those subcommands |
| ESLint | `eslint`, wrapped executable `eslint` |
| Ruff | `ruff check`, wrapped executable `ruff` with `check` |
| Clippy | `cargo clippy` |
| golangci-lint | `golangci-lint run` |

Arguments following an accepted form are opaque except that JSON/SARIF/custom formatter options
(`--format=json`, `--output-format=json`, `--sarif`, and equivalent separated forms) make the family
unsupported and leave output unchanged. Package script names outside the closed grammar are not
resolved or guessed.

Preserve every unique error until the global output cap. Diagnostic identity is subtype-specific:

- TypeScript/ESLint/Biome/Ruff/golangci: `(file, line, column, code-or-rule, severity, message)`;
- Clippy/Rust: `(crate-or-file, line, column, diagnostic-code, severity, message)`.

A diagnostic block includes its primary row plus contiguous source, caret, indented continuation,
help, note, and related-location rows defined by that subtype parser. If one complete error block or
all unique error blocks cannot fit the output cap, reject the candidate and retain original content.

Preserve at most 20 unique warnings after all errors. A parser must count every warning block before
omitting any and emit one exact total omitted-warning count. If warning boundaries or total cannot be
counted reliably, reject the candidate rather than truncate warnings. Do not merge diagnostics solely
by message; identity fields above remain part of uniqueness. Preserve the final explicit
error/warning/fixability summary.

Successful no-findings output may collapse only when the original contains an explicit recognized
success/zero-diagnostic summary. The filter never invents `ok` or infers success from silence.

### Test output

Enhance `test-output` for:

- Bun test;
- Vitest;
- Jest;
- pytest;
- Go test.

Preserve:

- failed test, suite, package, and collection names;
- assertion expected/actual diffs without reformatting;
- source frames and stack locations;
- setup/teardown and collection errors;
- panic and cause chains;
- skipped, todo, ignored, xfail, and xpass counts;
- snapshot additions/updates/failures;
- retries, projects, shards, attachments, screenshots, and trace paths;
- final pass/fail/error/skipped counts and duration.

Passing-case rows and progress indicators may collapse into exact counts. Failed detail blocks remain
in input order. Every unique failure is preserved until the global output cap; when the cap prevents
that, the candidate is rejected and original content remains unchanged rather than silently dropping
a failure.

### Package output

`package-output` recognizes these exact correlated mutation commands:

- `bun add`, `bun install`, `bun update`, `bun remove`;
- `npm install`, `npm update`, `npm audit`;
- `pnpm install`, `pnpm update`;
- `yarn install`, `yarn up`;
- `cargo add`, `cargo update`, `cargo fetch`;
- `pip install`;
- `uv sync`, `uv add`, `uv remove`.

`bun pm`, `pip list`, `pip outdated`, manager search/view/list/audit-JSON modes, and every inventory or
table mode remain unchanged in this tranche. JSON/custom reporter flags make the command unsupported.
Arguments selecting packages, workspaces, registries, or lock modes remain opaque after exact
subcommand classification; they do not broaden the family.

Preserve:

- package name and version changes;
- additions, removals, upgrades, and downgrades;
- lockfile create/update/save events;
- lifecycle and post-install script names and failures;
- blocked-script/trust guidance;
- vulnerabilities and audit severity/counts;
- peer, version, resolution, and platform conflicts;
- warnings and errors with continuations;
- generated artifact paths;
- final explicit manager summary.

Collapse only recognized downloads, resolution spinners, progress percentages, cache hits, and
repeated `already installed` chatter. Inventory/table commands are unsupported in this tranche and
retain original rows; they do not use a lossy default.

### Tree and long listings

`tree-output` recognizes correlated `tree`, long `ls`, and recursive listing commands. Improved
`path-list` handles correlated `find`, glob, and `git ls-files` output as well as high-confidence
unknown relative paths.

Preserve:

- root path/header;
- directory hierarchy and branch glyphs;
- symlink targets;
- permission/type marker when present;
- unparsed or locale-specific rows;
- first and last representative entries in each retained directory group;
- original final directory/file summary;
- exact omitted directory and entry counts.

Parser-specific count units are:

- `tree`: each glyph-prefixed row is one entry; indentation/glyph prefix defines its parent group;
- `find`, glob, and `git ls-files`: each complete newline-delimited path is one entry; dirname is its
  group;
- recursive `ls`: an exact `<directory>:` heading starts one group and each following parsed listing
  row is one entry;
- `ls -la`: one POSIX long-list row is one entry; its file-type character identifies regular,
  directory, symlink, device, socket, or pipe; symlink target remains part of that entry.

Names containing literal newlines, malformed hierarchy, missing recursive headings, ambiguous
locale/date columns, or rows that cannot be assigned and counted unambiguously make the parser retain
original content. Backslash in Windows paths is data, not a hierarchy glyph.

For grouped listings, retain at most 40 directory groups and 12 representative entries per group.
When groups are omitted, preserve first and last groups and state exact omitted counts. Extension
summaries may be added only from parsed file entries and never replace original summary semantics.

Long-list parsing never discards devices, sockets, pipes, unusual names, or unparsed rows. Any
unparsed long-list row causes original retention; there is no lossy fallback for locale-specific
rows.

### Git operations

`git-operation` recognizes exact correlated commands:

- `git branch`
- `git switch`
- `git checkout`
- `git push`
- `git pull`
- `git fetch`

Preserve:

- current and listed branches;
- detached HEAD;
- ahead/behind/divergence state;
- merge/rebase/cherry-pick/revert/bisect states;
- conflicts and rejected refs;
- local/remote ref mappings;
- created/deleted/forced-update markers;
- changed paths and branch names;
- remote URLs already present in output;
- explicit final status.

Collapse only recognized transfer object-count/progress rows and exact duplicates. The filter never
synthesizes success because tool-result IR has no exit code.

Existing `git-status` expands porcelain support, rename/copy pairs, detached HEAD, and in-progress
operation markers. Existing diff/log filters retain their public IDs.

### Docker build

`docker-build` recognizes exact correlated commands for:

- `docker build`;
- `docker buildx build`;
- `docker compose build`.

Preserve:

- stage index and name;
- Dockerfile line locations;
- executed instruction/command;
- cache-hit summary;
- warning and error blocks with multiline context;
- missing-file/cache-key diagnostics;
- exit code text present in output;
- produced image name, tag, ID, or digest;
- explicit final result.

Collapse only BuildKit rows matching closed forms for repeated `[N/M]` progress redraws,
elapsed-only updates, layer transfer percentages, and duplicate `CACHED` rows. A hash-only token may
be removed only from a repeated progress row already proven redundant. Never remove any hash or
digest attached to export, naming, image-ID, manifest, provenance, error, warning, or final-result
rows. ANSI/control-sequence cleanup applies only after command-gated classification. If diagnostic
blocks cannot be parsed without severing context, retain original content.

### Grep and path hardening

Grep parsing adds support for:

- Windows drive-letter paths;
- `path:line:text` matches;
- context rows and `--` separators;
- heading mode when correlated command flags establish it;
- short correlated results below the three-line unknown-origin threshold.

Ambiguous colon-delimited unknown output stays unchanged. Match grouping preserves filename, line
number, context separators, and representative matches; long-line match-centered truncation is not
implemented unless the search pattern can be extracted unambiguously.

## Shared Bounds and Acceptance

Existing eligibility remains:

- minimum 500 UTF-16 code units;
- maximum 1,000,000 code units;
- maximum accepted transformed output 250,000 code units;
- cache-controlled and explicit error results remain byte-identical.

Detection remains prefix-bounded. A family parser may make at most three full linear passes:
classification/block indexing, selection/counting, and rendering. Regexes must be anchored or use
linear character classes; nested/unbounded quantified groups and backtracking across full content are
forbidden. Intermediate retained text, indexes, and rendered fragments together must not exceed
three times input code units or 100,000 row records, whichever bound is reached first. Crossing a
bound rejects the candidate and retains original content. Tests exercise maximum rows, maximum code
units, and adversarial repeated prefixes.

Family limits:

- unique errors/failures: retain all until output cap; reject candidate if cap would omit one;
- warnings: retain at most 20 unique entries with exact omitted count;
- directory groups: at most 40;
- representative entries per directory: at most 12;
- command text: at most 16,384 code units and 256 tokens.

Every omission marker states the exact number and kind of omitted rows/items. A filter may not emit a
generic marker when it has counted a different semantic unit.

The shared acceptance guard remains:

- candidate is a string;
- candidate is nonempty;
- candidate is strictly shorter;
- candidate is at most the output cap;
- no parser exception occurred;
- family-specific required semantic anchors remain.

A detected specialized family whose parser fails or does not shrink is terminal. It does not fall
through to generic truncation.

## Error Handling

- Command tokenizer ambiguity returns unrecognized.
- Detector ambiguity returns no match.
- Family detector/parser exceptions retain original block and increment internal skip count.
- Missing required summary or semantic anchors retains original block.
- Unsupported output modes (`--json`, JSON/YAML/template/custom columns where relevant) retain
  original content.
- No filter emits synthesized success, failure, or exit status.
- Top-level transformer failure retains original request under existing report semantics.

These failures never alter routing, provider retries, deadline handling, stream commit behavior, or
usage accounting.

## Telemetry and Privacy

Existing request-log metrics remain unchanged. `rtkFilters` may now contain the five new family IDs.
The dashboard renders family IDs using its existing aggregate-only display.

Persisted/logged data still excludes:

- tool subtype;
- command or arguments;
- tool name or ID;
- files, paths, package names, branches, refs, URLs, image names, diagnostics, or matches;
- original and transformed content.

No new migration, request-log column, daily aggregate, or runtime log field is introduced.

## Testing Strategy

### Test organization

Create focused package suites and fixture directories by family rather than extending one monolithic
test file. Fixtures contain synthetic or publicly licensed output only; never production prompts,
credentials, private repository paths, or secrets.

Each family requires:

1. command classification tests;
2. positive success output;
3. positive failure/warning output;
4. large output with critical anchors only in the middle;
5. weak-negative source/prose/JSON examples;
6. malformed and partial output;
7. non-inflation and deterministic repeat tests.

### Command tests

Cover:

- exact executable/subcommand matches;
- `cd … &&`, assignments, `env`, and `timeout` wrappers;
- `bun run`, `bun x`, `bunx`, and `npx` routing;
- quoted arguments and paths;
- malformed quotes and oversized command/token inputs;
- prefix collisions and unsupported output flags;
- fixture-backed shell/non-shell aliases.

### Family fixtures

Required ecosystems:

- Bun build/install/test, including blocked scripts, lockfile rows, snapshots, unhandled errors, and
  `Ran N tests across M files`;
- TypeScript, Biome, ESLint, Ruff, Clippy, and golangci-lint;
- Vitest, Jest, pytest, and Go test;
- npm, pnpm, yarn, Cargo, pip, and uv;
- tree, `ls -la`, relative find/glob, Windows paths, symlinks, devices, and locale/unparsed rows;
- Git branch/switch/checkout/push/pull/fetch, detached/in-progress/conflict/rejection cases;
- classic Docker and BuildKit success/failure/cache/multiline diagnostics.

### Current-filter hardening

Add explicit tests for:

- unknown Git requiring multiple anchors;
- Git priority over embedded build/test strings;
- command extraction string/object/key precedence and invalid shapes;
- exact shell matching and non-shell aliases;
- grep Windows paths/context and ambiguous colon output;
- path density/prose conflicts;
- 499/500 and 1,000,000/1,000,001 size boundaries;
- CRLF, Unicode, tabs, ANSI, and huge repeated runs;
- fail-open exception paths through a package-internal transformer factory that accepts a registry;
  production exports use the fixed built-in registry, while tests inject throwing detector/parser
  entries without exposing registry customization publicly;
- copy-on-write identity for untouched requests/messages/blocks;
- preservation of all non-tool-result request fields and block types.

### Persistence and integration

- Every `RTK_FILTER_IDS` entry passes runtime validation and request-log JSON round-trip.
- Invalid stored values remain excluded.
- Dashboard request details render every family ID without content exposure.
- Anthropic and OpenAI ingress requests with equivalent tool history produce equivalent canonical
  compression.
- Streaming and non-streaming paths preserve RTK metrics.
- Failover attempts receive one identical transformed request.
- Deadline checks bracket preprocessing.
- Error and cache-controlled blocks remain unchanged.
- Mid-conversation system placement, cache markers, thinking signatures, usage accounting, and
  provider translation suites remain green.

## Completion Gate

Run focused tests first, then:

```bash
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

Dashboard test output must remain free of Recharts geometry and React `act(...)` warnings. Run
`git diff --check` before completion.

## Ordered Implementation Tranches

The approved release contains all five new family IDs, delivered through independently green
tranches on one feature branch. Each tranche ends with its focused tests, core typecheck, lint, and
`git diff --check`; no later tranche starts while those checks fail.

1. **Foundation and hardening**
   - leaf runtime catalog and store validator reuse;
   - module split, bounded command classifier, test-only registry factory;
   - command extraction/alias tests;
   - unknown Git, grep, path, size, Unicode/CRLF, immutability, and exception hardening.
2. **Coding diagnostics**
   - Bun routing gaps;
   - `lint-output` subtypes;
   - expanded `test-output` and existing `build-output` fixtures.
3. **Package and repository operations**
   - `package-output`;
   - `git-operation` and current Git status improvements.
4. **Listings and container builds**
   - `tree-output`, long listings, improved path grouping;
   - `docker-build`.
5. **Cross-layer completion**
   - persistence catalog round-trip;
   - dashboard family rendering;
   - Anthropic/OpenAI, streaming, failover, deadline, cache, thinking, and privacy integration.

A new family ID, detector, and dashboard expectation land together only in its tranche. If a family
cannot preserve required semantics, that tranche is incomplete: remove its ID, detector, fixtures,
and UI expectation before proposing a reduced release. No public no-op IDs ship. Reducing the
approved five-family scope requires user approval and a spec amendment.

## Rollout

The existing `rtkEnabled` setting controls all built-in families. It remains disabled by default.
No additional operator toggle is introduced.

Future cloud/IaC/database/HTTP/JSON filters require a separate design, likely including an explicit
recovery model.
