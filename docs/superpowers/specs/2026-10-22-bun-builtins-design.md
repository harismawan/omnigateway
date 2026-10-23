# Bun 1.4.4 and native tooling

> Development amendment (2026-10-23): user authorized removing Vite even when
> development reloads/reset state. `2026-10-23-remove-vite.md` supersedes the
> retained-Vite/Fast-Refresh constraint below; other compatibility constraints stand.

## Intent

Use Bun 1.4.4 consistently and replace every equivalent tool/API with Bun's
built-ins. The user's expanded instruction is to perform replacements, not
merely list opportunities; unchanged behavior remains the acceptance condition.

## Constraints

- Work in the isolated `feat/bun-1-4-4-builtins` worktree branch.
- Preserve public APIs, wire encodings, storage formats, authentication,
  environment interpretation, filesystem containment, and development behavior.
- Never replace cryptographic hashes with noncryptographic `Bun.hash`.
- Keep published SDK minimum engines independent from the repository toolchain.
- No publishing, pushing, merging, or changes to another agent's worktree.

## Toolchain

Pin `.bun-version`, root `packageManager`, CI, release, and Docker to 1.4.4.
Update Bun declarations to 1.4.4 when using its native compression-level option.
Keep historical benchmarks and fixtures unchanged. Verify the final lockfile
with `bun install --frozen-lockfile`.

## Subprocesses

Replace repository-check Git subprocesses with `Bun.spawnSync` behind a small
shared wrapper. Keep argv separate from the executable, preserve cwd, explicit
stdio suppression and existing per-caller output budgets (history 1 MiB, larger
diff/blob readers 64 MiB), and throw on nonzero/signal/overflow termination at
the helper boundary. Preserve callers' existing caught-error classification,
even when stricter errors would be a desirable separate change.
Existing history/working-tree checks must still handle shallow
clones, missing references and missing tracked files as before.

## Hashing and identifiers

Use `Bun.CryptoHasher` for server-side SHA-256, SHA-1 UUID derivation, and HMAC
calls currently using `node:crypto`. Preserve input serialization, namespace
bytes, UTF-8 HMAC salt, Buffer consumers, hex truncation, and UUID version bits.
Use Web Crypto UUIDv4 instead of importing Node's UUID generator. Keep browser-
callable Codex secret generation free from eager Bun reads. Execute a browser
bundle with Bun absent and call secret generation; a successful bundle alone
does not prove compatibility. Pin fixed SHA/HMAC/UUID vectors including Unicode,
UTF-8 salt versus hex-decoded salt, Buffer consumers and truncated digests.
No Bun reference may enter pure package or provider leaf graphs.

## Compression

Use one-write Web `CompressionStream("zstd", { level: 3 })` for the provider
request encoder. Both existing byte-for-byte goldens must pass; concurrent
draining must prevent backpressure deadlock, and stream errors must reject.

Use Web gzip compression for the optional artifact benchmark writer, preserving
the cutoff, level/default normalization, 64-byte savings decision, and raw default
writer. Bounded asynchronous gunzip remains Bun's `node:zlib` implementation:
other native entrypoints do not preserve its output ceiling and consumed-input
contracts. Test omitted/default level, -1, NaN, 0/1/9, invalid and fractional
levels and exact 63/64-byte savings decisions. The plugin's gzip path already
uses Bun directly; its full expansion precedes tar-size validation and is not
covered by the artifact reader's inflation ceiling.

## Dashboard

Investigate Bun build/serve replacements against the current Vite contract:
TanStack generated routes and lazy split groups; eager authentication/catalog
gates; styled-components display names and hot reload; shared import-map runtime;
self-hosted separately cached fonts; public assets; API/health proxy and SPA
fallback. Retain framework-specific transforms where Bun has no equivalent,
rather than inventing a new framework compiler or dropping those behaviors.
Only claim Vite removed when both build and development parity are demonstrated.
Investigation found production/shared parity viable, while native development
route edits reset unrelated component state. Migrate production/shared builds
only; keep Vite dev/preview until that measured regression is resolved.

## Proven incompatibilities

- `fetch` changes upstream header order; retain ordered `node:http` transport.
- `Bun.Archive.files()` drops links and lacks declared-size limits; retain tar
  parser rather than weakening archive installation security.
- Native `.env` parsing changes inline comments, escapes and quoting; retain
  the CLI's installation-file interpretation.
- `parseArgs` and `timingSafeEqual` already use Bun-provided compatibility APIs;
  no separate Bun replacement exists.
- Filesystem injection/atomic rename/containment contracts are not replaced by
  unrelated async file conveniences.

## Proof

Use focused differential/golden tests at each changed boundary, an independent
review, complete core/dashboard suites, all CI checks, dashboard/npm/binary
builds and Docker smoke coverage. Exercise local Redis/Postgres integration when
available, report versions/skips honestly, and never contact live AI providers.
