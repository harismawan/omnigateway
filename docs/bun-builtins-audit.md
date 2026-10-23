# Bun 1.4.4 built-in migration

The repository development/build toolchain is pinned to Bun **1.4.4** in
`.bun-version`, `package.json`, CI, release, and Docker. The standalone Docker
image embeds that runtime; it does not install a separate Bun at startup.
Published plugin SDK engine requirements are independent and unchanged.

## Candidate coverage

| Area | Decision / acceptance criterion |
| --- | --- |
| Development/CI/release/Docker | Same exact Bun 1.4.4 pin; frozen lockfile installation. |
| Repository-check Git commands | `Bun.spawnSync`; preserve failures, stdio and per-caller output limits. |
| Server SHA/SHA-1/HMAC | `Bun.CryptoHasher`; preserve golden bytes and salt encoding. |
| Device UUID generation | Global Web Crypto UUIDv4, never time-ordered UUIDv7. |
| Request zstd encoding | One-write native Web stream; both wire goldens match. |
| Optional artifact gzip encoder | Native Web stream; same level handling and savings policy. |
| Artifact gzip decoder | Keep bounded native zlib compatibility API; see limits below. |
| Plugin tar/gzip | Gzip already Bun; tar-map replacement loses rejection/limit semantics. |
| Dashboard build/dev/shared graph | Native production/shared builds and Bun dev/preview; user approved full reload/state reset instead of Vite HMR. |
| CLI environment parser | Keep: native parser changes accepted syntax and values. |
| CLI argument parsing | Already Bun-provided `node:util.parseArgs`. |
| Constant-time comparisons | Already Bun-provided `node:crypto.timingSafeEqual`. |
| File I/O/traversal | Keep synchronous injection, atomicity, symlink and encoding contracts. |
| Test setup/reference code | Keep independent Git/crypto/zlib oracles rather than coupling assertions to migrated code. |
| Elysia/Zod/React/router/UI/DOM/Biome | No equivalent Bun built-in framework, schema validator, UI runtime, DOM test environment or linter. |

## Already native

- Package installation, workspace resolution, scripts, tests, TypeScript checking:
  Bun (`bun install`, `bun run`, `bun test`, `bun check`).
- CLI/gateway bundles and standalone executable: `Bun.build`.
- SQLite: `bun:sqlite`; Postgres: Bun `SQL`; Redis: `RedisClient` from `bun`.
- Admin password hashing/verification: `Bun.password`; plugin compatibility:
  `Bun.semver`; npm integrity checks: `Bun.CryptoHasher`.
- CLI process execution: `Bun.spawn`; source/import analysis: `Bun.Transpiler`;
  file discovery: `Bun.Glob`.

## Implemented replacements

- Repository hygiene Git execution now uses `Bun.spawnSync` through
  `scripts/lib/subprocess.ts`, with explicit failure handling, argv-only
  execution, UTF-8 output, quiet callers and the previous per-caller output
  budgets (history 1 MiB; diff/blob readers 64 MiB). Tests cover
  literal shell metacharacters, EOF stdin, failures/signals, launch errors, and
  output at and beyond the limit.
- Provider zstd encoding uses `CompressionStream("zstd", { level: 3 })` with
  one write and concurrent draining. Both byte-level wire goldens remain intact.
- Optional artifact gzip encoding uses `CompressionStream("gzip", { level })`,
  preserving default/-1/NaN handling, raw cutoff and exact 64-byte savings rule.
  Production artifact writes remain raw; bounded decompression is unchanged.
- Server SHA-256/SHA-1 and HMAC now use `Bun.CryptoHasher`; fixed codec/cache-key
  vectors preserve serialization, binary namespaces, UTF-8 salt encoding, Buffer
  consumers and digest truncation. Kimi/Grok device IDs use Web Crypto UUIDv4.
  OAuth secret generation remains callable without Bun hashing or a Buffer global.
  Its browser execution test specializes existing server-profile `Bun.env`
  reads; this is not a claim that the entire unspecialized provider root is
  browser-runtime-neutral.
- Dashboard production HTML and the multi-entry shared runtime now use
  `Bun.build`, with retained public TanStack route transforms and Babel's
  styled-components transform. Build-time route generation rejects failures
  even when a stale generated tree exists. Lazy groups, eager gates/loaders,
  representative styled display-name prefixes, theme bootstrap and shared
  import-map ordering are tested. Fonts remain separate content-hashed WOFF2
  assets; favicon/shared entry URLs and cache-path contracts remain stable.
  Docker uses the native no-typecheck production entrypoint. Development and
  preview now also use Bun; Vite and plugin-react are removed from installed
  dependencies. The retained TanStack `/vite` public hook facade does not load
  the Vite package: only its framework transforms are reused.

Bun's runtime declarations come from `bun-types@1.4.4`. `@types/bun@1.4.4` is
not published; the published 1.4.3 wrapper is used with a `bun-types` override
to prevent its older exact dependency from introducing conflicting globals.

## Equivalence boundaries

Replacing a dependency or compatibility API must preserve its observable
contract, including security limits, malformed-input rejection, wire encoding,
and development behavior—not only a successful build or decoded response.
`node:*` modules are provided by Bun itself; retaining one does not introduce a
Node.js runtime requirement or an npm dependency.

### Outbound HTTP

Keep `node:http`/`node:https` behind `HttpClient`. A raw local socket probe on
Bun 1.4.4 supplied headers in this order:

```text
User-Agent, x-app, X-Stainless-Lang, anthropic-version
```

Bun `fetch` emitted:

```text
User-Agent, X-Stainless-Lang, anthropic-version, x-app
```

Header order and casing are part of the provider CLI fingerprint, not an
incidental object order. `packages/providers/test/http-client.test.ts` pins
that contract. The existing client also preserves its explicit per-address
connection-attempt budget, abort handling, and incremental response stream.

### Environment and argument parsing

The CLI's small `.env` parser is not equivalent to Bun's native
`node:util.parseEnv`: inline `#` is literal in the current parser, quoted
`\n` stays escaped, and backticks are not stripped. Replacing it would
reinterpret existing installation configuration. Keep its root-selection and
environment precedence rules. `Bun.parseEnv` and `Bun.parseArgs` are absent in
1.4.4; `node:util.parseArgs` is already a native Bun-provided argument parser.

### Archive installation

Keep the plugin tar reader. Bun 1.4.4 `Bun.Archive.files()` omits hard links and
symlinks instead of rejecting the complete install, exposes no link metadata,
and applies PAX path overrides that the existing parser ignores. It lacks the
declared-entry aggregate size limit, including skipped metadata bodies, enforced
before copying. It also rejects unpadded final entries the installer accepts.
Filtering the returned file map cannot recover omitted entries or enforce that
pre-read limit; an equivalent preflight would still require the existing parser.
Plugin gzip decompression already uses `Bun.gunzipSync`. Its expansion occurs
before tar validation: the tar declared-size limit does **not** bound gzip
inflation or total archive memory. That existing limitation is distinct from
the artifact reader's native inflation ceiling below.

### Bounded artifact decompression

Keep asynchronous `node:zlib.gunzip` for artifact reads. A 2,048-byte expansion
with `maxOutputLength: 1024` still returned 2,048 bytes through Bun's gzip API
and Web `DecompressionStream` on Bun 1.4.4: those APIs do not enforce that option.
`Bun.gunzipSync` also reads only the first concatenated member and ignores
trailing garbage. Web decompression handles concatenated members but exposes
neither an expanded-size ceiling nor consumed-input count. A stream high-water
mark is a buffering threshold, not the artifact's total output security limit.
The existing bounded reader's oversize rejection and complete-input rules stay.

### Dashboard development server

Bun's production bundler can retain framework-owned TanStack route splitting
and Babel styled-components transforms. Bun has no built-in replacements for
those framework-specific transforms; retaining them is necessary for lazy route
groups and readable styled component names.

The original strict-parity investigation retained Vite: native Bun development
probes encountered a TanStack circular-module
initialization failure and indirect `import.meta.hot.data` incompatibility.
Even with targeted workarounds, editing a split route reset unrelated component
state to zero; the same edit under the existing Vite pipeline preserved it.
Page reload would not meet the original unchanged-development requirement.
On 2026-10-23 the user explicitly accepted this change to remove Vite. Native
development now rebuilds the production/shared graph (including production React)
and reloads the page after success; it provides neither Fast Refresh nor React
development diagnostics. This avoids the incompatible native framework HMR path.
The API/health proxy, assets, SPA fallback, route generation and styled names stay.
Failed builds keep the previous working snapshot; subsequent edits recover.
Preview serves an existing build without watching. No Vite runtime is installed.

### Constant-time comparison and filesystem contracts

`node:crypto.timingSafeEqual` remains necessary: neither
`Bun.timingSafeEqual` nor `crypto.subtle.timingSafeEqual` exists in 1.4.4.
Ordinary string equality is not a replacement. Synchronous injected filesystem
operations, atomic rename-based writes, containment/realpath checks, and Latin-1
capture reads are not replaced by asynchronous `Bun.file().text()`.
The recursive source walker also retains its current inclusion of filename
symlinks and traversal order: a direct `Bun.Glob` swap changes those results.

### Test oracles

The scratch-repository fixtures in `scripts/test/{history,tree}.test.ts` keep
`node:child_process` as an independent setup oracle for the Bun-native Git
wrapper under test. Reusing that wrapper to set up its own expected history
would couple both sides of the assertion. Provider cryptographic/compression
goldens likewise retain independent reference implementations in tests.

## Verification

Baseline on Bun 1.4.4: 4,783 core and 752 dashboard tests passed with local Redis
8/Postgres 18 enabled (no skips). Typechecks, lint, both repository-hygiene
checks, dashboard/npm/binary builds and Docker build passed. The image served
`/health` and the console as non-root; Chrome headless rendered first-run setup.
Final verification after all migrations uses the CI service versions, Valkey 8
and Postgres 17; these baseline results are not a claim about unfinished edits.
Final service-enabled verification passed **4,819 core + 758 dashboard tests**,
with zero failures or skips, using Valkey 8/Postgres 17. Frozen installation
left the lockfile unchanged, including the exact pruned Docker manifests.
Core/dashboard typechecks, repository lint, stale-claims/dead-export checks,
native dashboard/npm/binary builds, and the actual Alpine Docker build passed.
The built image served `/health` and first-run setup in Chrome without runtime
exceptions, failed requests or HTTP errors. Expected pre-existing React test
`act` warnings and the framework's exported-AppShell split warning remain.

Browser checks use Chrome 155. The native-dev comparison checked that a counter
stays at 1 after styled and route edits: both edits preserved state in Vite;
native Bun preserved it only for the styled edit. Production bundle boot checks
do not imply authenticated-board, plugin-UI or HMR coverage on their own.
An additional Chrome production smoke uses an authenticated API fixture and
a dynamically imported plugin UI: it renders the real console shell and
plugin route, verifies shared React/SDK function identity and styled output,
and observes the plugin's live context changing when the host pauses. It has
no runtime exceptions, failed requests or HTTP errors. This fixture smoke is
not an end-to-end test of real authentication or plugin installation.

The Vite-removal follow-up additionally exercised the real native dev server in
Chrome on a scratch copy: source edit reloads/reset state, a syntax error keeps
the working page, repair recovers, and added/deleted routes regenerate correctly.
Native preview also boots `/login` without browser/runtime/network errors.
Proxy tests cover request bodies/query/cookies/Host, multiple Set-Cookie headers,
manual redirects, streaming cancellation, health and unavailable backends.
After the follow-up and review corrections, the service-enabled suites passed
**4,832 core + 758 dashboard tests**, with zero failures/skips. A preceding run
timed out in the existing gateway client-disconnect timer test; its file passed
23 tests in isolation and the full quiet rerun passed without changing gateway
code or relaxing timeouts. Review reproductions cover symlinked roots/TMPDIR,
edits during the initial build and failed-startup resource cleanup.
