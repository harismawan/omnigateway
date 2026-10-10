# Body Artifact Storage Optimization Implementation Plan

> **For Hermes:** If implementation is separately approved, use the subagent-driven-development skill to implement this plan task-by-task. This document is a proposal, not authorization to execute it.

**Goal:** Remove artifact-specific hexadecimal expansion and optionally compress masked, bounded JSON before encryption without changing credentials, capture limits, retention, or the public body API.

**Architecture:** Keep one artifact codec in `packages/store/src/bodies/artifact.ts`, shared by SQLite files and PostgreSQL `bytea`. Add a versioned binary AES-GCM envelope and retain a strictly validated legacy reader. Ship dual-read support with legacy writes first; activate binary writes in a later release only after every reader is upgraded.

**Tech Stack:** Existing Bun/TypeScript, WebCrypto AES-256-GCM, native `node:zlib`, `node:util` promisify, `bun:sqlite`, and Bun SQL. No new dependencies.

**Status:** Proposed; implementation, integration suites, storage benchmarks, rollout, and maintenance have not been executed. Source audit baseline: repository HEAD `e420919`. A separate concurrent change introduces independent body retention; rebase/re-read its actual policy before implementation and do not edit that work.

---

## 1. Verified current path and scope

| Path | Current responsibility / consequence |
|---|---|
| `apps/gateway/src/routes/proxy.ts:556-574` | Captures settle before the single `store.bodies.put` call, after the response. Preserve failure isolation and stream semantics. |
| `packages/store/src/bodies/artifact.ts:169-215` | `prepareArtifact` masks before structural bounding, serializes JSON, and applies the 512 KiB plaintext omission budget. Compression must follow this path, never bypass it. |
| `packages/store/src/bodies/artifact.ts:226-231` | `sealArtifact` encrypts JSON using the credential string helper, then UTF-8 encodes its hex envelope. |
| `packages/store/src/encryption.ts` | Shared credentials use `enc:v1:<iv-hex>:<ciphertext-hex>:<tag-hex>`. Key derivation uses PBKDF2 SHA-256, salt `omnigateway-field-encryption-v1`, 210,000 iterations, AES-256-GCM. Leave this file and these parameters unchanged. |
| `packages/store/src/sqlite/bodies.ts:87-103,129-147` | Saves those opaque bytes in date-sharded `.json.enc` files; records their actual length and digest; reports missing/corrupt rather than throwing. |
| `packages/store/src/postgres/bodies.ts:87-126,131-155` | Saves the same bytes in `request_bodies.bytes BYTEA`, atomically with metadata. It does not currently unhex the envelope. |
| `packages/store/src/bodies/artifact.ts:249-285` | Reads bytes, checks the digest over stored ciphertext, decrypts, and parses a non-array object. Format support belongs here, not in individual callers. |
| `packages/control/src/bodies.ts` and `apps/cli/src/commands/bodies.ts` | Consume decoded artifacts and report stored-byte metadata; API shape and conservative CLI withholding remain unchanged. |
| `packages/store/src/sqlite/store.ts:193` | Swap forwarder delegates `bodies.put`; keep its signature unchanged. |
| `packages/control/src/copyStore.ts:23-29` | Cross-backend copy explicitly does NOT carry body rows or corpus. Do not invent a body import/export mechanism as part of this optimization. |
| `packages/store/src/sqlite/maintenance.ts`, `packages/control/src/database.ts` | SQLite snapshot/import/restore concerns the database, not the external body directory. Existing missing/orphan reconciliation remains necessary. |
| `packages/store/src/postgres/maintenance.ts` | PostgreSQL backup/restore is external `pg_dump`/restore; body bytes are database data and must remain opaque through that path. |

The PostgreSQL client may display `bytea` as hex on the wire or in query output; that is distinct from the **actual UTF-8 hex envelope currently stored inside the column**. Changing `bytea_output` does not remove that inner expansion. PostgreSQL may already compress repetitive hex through TOAST: logical-byte reductions must not be misrepresented as equal physical-file reductions. AES ciphertext itself is not usefully compressible; compress plaintext before encryption, not ciphertext or its textual hex.

For N UTF-8 JSON bytes, the current envelope is exactly `2*N + 65` bytes. A prior synthetic measurement of 262,390 JSON bytes → 524,845 stored bytes is consistent with this formula. The reported 1,866-byte gzip result was repetitive synthetic plaintext, **not a production compression estimate**. No production plaintext was fetched for this plan.

Read-only runtime probe: Bun `1.4.3` supports `node:zlib` bounded `gunzipSync(..., { maxOutputLength: 1024 })`; a 2,048-byte expanded payload failed with `ERR_BUFFER_TOO_LARGE`. Async API behavior and the deployed/pinned runtime still need explicit tests before implementation approval.

### Non-goals

- No changes to `MAX_ARTIFACT_BYTES` (512 KiB), `BODY_ROW_CAP` (100,000), per-value bounds, capture gates, masking rules, truncation/omission semantics, headers, or `LogFields`.
- No changes to shared credential `encrypt`, `decrypt`, `isEncrypted`, key derivation, or credential ciphertext.
- No new compression library, codec registry, storage interface, worker service, generic crypto framework, or user-facing compression setting.
- No eager production rewrite/backfill, schema migration for opaque bytes, artifact renaming, or body transfer feature.
- No retention changes; let legacy rows expire through the independently approved existing/body-specific retention policy.
- No automatic `VACUUM FULL`, table rewrite, or claim that this fixes existing bloat.

## 2. Minimum proposed format

Keep JSON `schemaVersion: 1`; envelope version describes storage, not the artifact domain schema.

Proposed binary layout (big-endian where applicable):

| Offset | Bytes | Meaning |
|---|---:|---|
| 0 | 4 | Fixed ASCII magic `OGBA` (artifact-only namespace) |
| 4 | 1 | Envelope version `1`; this fixes AES-256-GCM, UTF-8 JSON, 12-byte IV, 16-byte tag, and the codec definitions below |
| 5 | 1 | Codec `0` = raw UTF-8 JSON; `1` = gzip (RFC 1952). Reject every other value. |
| 6 | 4 | Original uncompressed UTF-8 byte count, unsigned big-endian |
| 10 | 12 | Fresh cryptographically random IV |
| 22 | variable | Ciphertext, followed by the final 16-byte GCM authentication tag returned by WebCrypto |

The first 10 bytes are GCM `additionalData`, authenticating format version, codec, and claimed expanded length. Ciphertext length is inferred from total bytes; a separate length field or IV/tag length fields add no information for this fixed version. Future incompatible compression/crypto semantics require a new envelope version, not guessing from a gzip prefix. Overhead is 38 bytes, so raw maximum is 524,326 bytes versus legacy 1,048,641 bytes for a 512 KiB plaintext.

Reuse the existing **derived CryptoKey** passed to the artifact functions. Use WebCrypto directly inside the artifact codec instead of teaching the credential helper another format. WebCrypto already returns ciphertext plus tag; keep it together without a hex/base64 intermediary. `sha256Hex` still returns a hexadecimal digest for metadata, over the **entire exact stored envelope**, including header, IV, and encrypted payload/tag. The digest detects disk damage/swaps; GCM is the authentication boundary and does not depend on the digest being present.

### Write sequence

1. Run existing `prepareArtifact` unchanged: mask → bound → serialize → omission budget.
2. Enforce that the serialized plaintext passed into `sealArtifact` is within `MAX_ARTIFACT_BYTES`, before encoding/compression. Never admit a larger plaintext because it compresses well.
3. Proposed initial policy: skip gzip below 1,024 bytes; otherwise use native async gzip at level 1, and choose it only if compressed bytes save at least 64 bytes versus raw bytes. Treat these as benchmark-selected internal constants, not public settings. Both formats have equal envelope overhead.
4. Use `promisify(gzip)` / `promisify(gunzip)` from `node:util`; prove Bun supports the selected options. Async native work avoids knowingly adding synchronous compression stalls to the gateway. Do not add a custom queue/pool unless measured concurrency shows the native scheduling is insufficient.
5. A compression failure may fall back to the bounded raw representation; encryption/storage failures must still propagate to the existing capture-failure handler. Never fall back to plaintext storage.
6. Construct the authenticated header, generate a fresh IV, encrypt selected bytes, concatenate header + IV + ciphertext/tag, and compute the stored-envelope digest. Existing store methods record `bytes.length`, not original or compressed plaintext size.

### Read sequence and hostile-input limits

- Limit acquisition before whole-file allocation where possible: SQLite `readArtifact` should open the file, check size, then read at most the supported global encoded maximum plus one byte using the same handle. A stat-only check followed by unrestricted `readFile` has a growth race. Oversize existing files are `corrupt`; missing files remain `missing`.
- PostgreSQL must not select an arbitrary-size hostile `bytea` before checking its length. In `get`, keep metadata and use `CASE WHEN octet_length(bytes) <= $2 THEN bytes ELSE NULL END AS bytes` plus `octet_length(bytes) AS encoded_size`; distinguish SQL NULL (missing) from non-NULL oversize (corrupt). Use the same global encoded maximum as the shared reader. Avoid adding a repository API parameter for it.
- Proposed global encoded maximum is `2*MAX_ARTIFACT_BYTES + 65`; once binary magic is detected, apply the tighter `MAX_ARTIFACT_BYTES + 38` limit. Reject oversize before digest-copy allocation and decrypt. The legacy ceiling is a **proposed compatibility restriction**, not a proven historical writer maximum; resolve the gate below before activating bounded acquisition.
- Compare the first bytes exactly: `OGBA` selects binary; exact ASCII `enc:v1:` selects legacy. Unknown input is `corrupt`. A malformed/unknown-version binary envelope never falls back to legacy, and vice versa.
- Validate binary minimum length (header + IV + tag), envelope version, codec, total bounds, and claimed original byte count (`1..MAX_ARTIFACT_BYTES`) before allocating based on a field or decrypting. Reject tag truncation and unsupported fields.
- Validate legacy ASCII structure, exactly five colon-delimited components, even lowercase hex, exact 12-byte IV and 16-byte tag, and body-hex plaintext size limit before invoking existing `decrypt`. Keep legacy digest handling unchanged; null digest still requires valid GCM. Do not change credential validation in `encryption.ts`.
- Check the stored-envelope digest when supplied, then authenticate/decrypt with GCM. Only authenticated codec/length metadata may govern decompression.
- For gzip, pass native `maxOutputLength: MAX_ARTIFACT_BYTES` to the decompressor; checking only after inflate is not safe. Also require output byte length to equal the authenticated header value. Raw payload length must also match. Test concatenated gzip members and trailing garbage against native runtime behavior; permit valid members only if their complete output respects both bounds, reject malformed trailing bytes rather than returning a partial artifact.
- Decode binary plaintext with fatal UTF-8 decoding; parse JSON and preserve the existing non-null/non-array object check. Do not turn this storage task into a new domain-schema validator. No plaintext or native error details escape through logs or reader failures.
- Every malformed envelope, wrong key, bad digest/tag/header, invalid UTF-8/JSON, length mismatch, or decompression limit failure returns `{ ok: false, failure: "corrupt" }`. Store-level state recovery (`corrupt`/`missing` back to `ready` when repaired) remains intact.

## 3. Proposed tasks (do not execute from this document alone)

Each test/implementation step is a small checkpoint; benchmark runs and container startup may take longer. No commit, deploy, or production write is authorized by this plan.

### Task 1: Pin legacy compatibility before changing the codec

**Files:** Modify `packages/store/test/bodies.test.ts`; test `packages/store/test/encryption.test.ts`, `packages/store/test/credentials.test.ts`.

1. Add a synthetic legacy fixture using existing `encrypt(await deriveKey(testSecret), prepareArtifact(input).json)` and `TextEncoder`; verify decode with correct and null digest, wrong key, and known expected artifact.
2. Add malformed legacy cases: extra components, odd/invalid hex, wrong IV/tag lengths, invalid JSON. Assert `corrupt`, not an exception. Test oversized acquisition separately under the explicitly approved compatibility policy in step 6.
3. Run `bun test packages/store/test/bodies.test.ts packages/store/test/encryption.test.ts packages/store/test/credentials.test.ts`. New exact-boundary tests may initially fail; do not weaken them to match the old reader.
4. Keep an independent fixture emitted by the unchanged legacy helper; a fixture generated only by the new writer does not prove backward compatibility.
5. Add an explicit oversized-frame legacy fixture through the unchanged store helpers. A reproduced synthetic 6,000-attempt artifact produced 1,889,340 plaintext bytes and 3,778,745 stored bytes and decoded successfully: `prepareArtifact`'s final omission fallback does not recheck the remaining frame size. Do not label this valid authenticated artifact malformed merely because it exceeds the proposed new ceiling. Normal gateway dispatch is capped at 10 attempts; this store-API probe does not establish affected production traffic.
6. **Compatibility gate before Task 2:** trace supported historical writers and inspect only authorized artifact-size metadata, without fetching plaintext. Record whether oversized valid frames may exist. Either obtain explicit approval to reject them (document the restriction and recovery option), or revise this plan to a finite, separately justified legacy limit and retain their reads. Never silently remove bounds or claim universal legacy compatibility. If evidence or approval is missing, stop format rollout; binary new-write limits remain strict. No production scan, deletion, conversion, or eager backfill is authorized by this plan.

### Task 2: Add binary dual-reader and safe acquisition, leave default writer legacy

**Files:** Modify `packages/store/src/bodies/artifact.ts`, `packages/store/src/postgres/bodies.ts`; test `packages/store/test/bodies.test.ts`, `packages/store/test/contract/bodies.test.ts`.

1. Add test-built raw binary envelopes through WebCrypto using the specified header/AAD. First prove raw/legacy round trips and unsupported/mutated/truncated headers fail.
2. Implement minimal binary encode/decode helpers in `artifact.ts`, validation and bounded file acquisition there, and guarded PostgreSQL selection. Keep `sealArtifact` emitting legacy for release A. No changes to SQLite repo signatures or migrations are needed.
3. Add digest/tag tests both with matching recomputed digest and with null digest, so the checksum cannot hide a missing authentication guard. Test same JSON sealed twice has different IV/envelope bytes.
4. Run `bun test packages/store/test/bodies.test.ts packages/store/test/contract/bodies.test.ts` against a disposable PostgreSQL instance as described below. Prove both backends report oversized bytes as corrupt, not missing.

### Task 3: Add bounded gzip arm behind inactive binary writer

**Files:** Modify `packages/store/src/bodies/artifact.ts`, `packages/store/test/bodies.test.ts`.

1. Add tests for tiny input choosing raw, a compressible fixture choosing gzip, and incompressible input falling back to raw without growth. Test exact policy boundaries (size cutoff and minimum saving).
2. Add a validly encrypted, authenticated gzip bomb with a plausible small claimed size but expansion above the cap. It must fail inside bounded decompression, not after unrestricted inflation. Add claimed-length mismatch, truncated gzip, invalid footer, concatenated members, and trailing garbage cases.
3. Implement native gzip/gunzip and authenticate header fields. Enforce the original cap for new writes and binary read output; enforce the finite legacy read limit selected and approved at the Task 1 compatibility gate. Keep default writes legacy pending benchmarks and rollout.
4. Run `bun test packages/store/test/bodies.test.ts`; temporarily remove the decompression bound, disable AAD, and alter codec detection one at a time to prove the corresponding tests fail. Restore from scratch-file backups, never `git checkout` over uncommitted work.

### Task 4: Exercise both stores, consumers, and backup/copy semantics

**Files:** Modify `packages/store/test/contract/bodies.test.ts`; modify `packages/store/test/bodies.test.ts` at the legacy-prefix assertion near line 613 only when binary activation is intended. Add focused assertions to existing `packages/control/test/copyStore.test.ts`. Test existing consumers listed below.

1. Shared contract: write/read raw and gzip artifacts and legacy fixtures through SQLite and PostgreSQL, asserting whole prepared artifact, metadata byte count/digest, masking, omission, preserved incoming truncation, upsert, corruption, and repaired-state recovery.
2. Fixture setup should use existing test SQL/file mechanisms, with test-only backend-specific branches if needed; do not introduce a production raw-byte import API. Cross-load identical opaque envelopes into SQLite files and PostgreSQL bytea using the same derived key, and verify decoded equality in both directions. This proves byte compatibility, not a new supported migration tool.
3. Preserve tests showing SQLite snapshots exclude body files and restore may produce missing metadata pointers; confirm orphan sweep still sees unchanged `.json.enc` paths. For PostgreSQL, round-trip disposable schema data with `pg_dump`/`pg_restore`, then decode restored legacy/raw/gzip rows. Do not add this tooling to the production snapshot abstraction.
4. Confirm `copyStore` continues to omit bodies and reports `NOT_CARRIED`. CLI `--json` exports decoded artifacts, not stored binary envelopes; SQLite snapshot import is still database-only. Do not claim cross-backend copy carries the corpus.
5. Run:

```bash
bun test packages/store/test/bodies.test.ts packages/store/test/contract/bodies.test.ts packages/store/test/maintenance.test.ts packages/store/test/swap.test.ts
bun test packages/control/test/bodies.test.ts packages/control/test/database.test.ts apps/cli/test/bodies.test.ts apps/cli/test/database.test.ts apps/gateway/test/bodyLogging.test.ts apps/gateway/test/routes/database.test.ts
```

Expected: all executed tests pass, PostgreSQL body-contract skip count zero when its URL is supplied; existing credential ciphertext still starts `enc:v1:`. No counts are claimed in advance.

### Task 5: Benchmark before choosing activation and compression constants

**Proposed files:** Create `scripts/bench-body-artifacts.ts` only if the experiment merits a reproducible repo script; store results in `docs/superpowers/plans/2026-10-10-body-artifact-storage-benchmark.md`. Keep one script, not a benchmark framework. Neither file is created by this plan.

Implement the script with native timing, `process.cpuUsage()`, `process.memoryUsage()`, event-loop delay sampling, and existing artifact/store helpers. Proposed CLI contract:

```bash
bun scripts/bench-body-artifacts.ts --mode legacy --iterations 1000 --concurrency 1
bun scripts/bench-body-artifacts.ts --mode binary-raw --iterations 1000 --concurrency 1
bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 1000 --concurrency 1
bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 1000 --concurrency 16 --postgres
```

These commands become runnable only after that proposed script exists; they are not claims of completed measurements. All modes must start from identical `prepareArtifact` output, with the same masks and bounds. Derive the key once per run and exclude KDF time from per-artifact crypto timing. Warm up, use at least five repeat runs, report runtime/CPU/DB version, sample sizes, median and p95 seal/decode timings, throughput, CPU per operation, peak RSS and heap, and event-loop delay. Run modes in separate processes and report GC/noisy-machine limitations.

Corpus: tiny marker/empty-pair artifacts; short natural-language exchanges; tool schemas and tool results; multilingual text; bounded many-attempt and SSE-frame artifacts; omission markers; near-cap varied-text and repetitive fixtures; incompressible fixtures that survive masking. If sanitizer masks high-entropy tokens, report that effect rather than treating pre-mask input as stored data. Include explicitly labeled synthetic worst/best cases; representative manually sanitized fixtures only after separate privacy approval. Never decrypt/export production prompts, credentials, keys, or tokens for a benchmark. Report fixture-class distributions and avoid extrapolating an unweighted synthetic average to production savings.

Measure logical envelope bytes, PostgreSQL `octet_length(bytes)` and `sum(size_bytes)`, `pg_table_size`, `pg_indexes_size`, and `pg_total_relation_size` (including TOAST/index overhead). Use separate identical fresh databases/tables per mode, equal row counts and fresh schema, and enough repeated rows (proposed 10,000) for page/TOAST effects to be visible. Keep payload bytes out of console results. Capture WAL LSN before/after fixed insert batches with `pg_wal_lsn_diff`; isolate from other clients and document checkpoints/full-page-write effects. Capture equivalent upsert batches separately if evaluating update cost. Ciphertext randomness and TOAST mean physical results will not exactly follow envelope ratios.

Disposable server commands, **future execution only** (test-only password, loopback binding):

```bash
docker run -d --name omni-body-bench-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=omni postgres:16-alpine
docker exec omni-body-bench-pg pg_isready -U postgres -d omni
# If readiness fails, inspect container logs and retry the readiness check; do not run tests yet.
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni bun test packages/store/test/contract/bodies.test.ts
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 10000 --concurrency 16 --postgres
# Repeat legacy and binary-raw on reset disposable databases; NEVER point this harness at production.
docker exec omni-body-bench-pg psql -U postgres -d omni -c "SELECT count(*), sum(size_bytes), sum(octet_length(bytes)), pg_table_size('request_bodies'), pg_indexes_size('request_bodies'), pg_total_relation_size('request_bodies') FROM request_bodies;"
docker exec omni-body-bench-pg pg_dump -U postgres -d omni -Fc -f /var/lib/postgresql/body-bench.dump
docker exec omni-body-bench-pg createdb -U postgres omni_restore
docker exec omni-body-bench-pg pg_restore -U postgres -d omni_restore /var/lib/postgresql/body-bench.dump
# Script read-only verification mode must decode restored fixtures without wiping the target schema.
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni_restore bun scripts/bench-body-artifacts.ts --verify-restored
docker rm -f omni-body-bench-pg
```

`forEachStore().fresh()` drops the public schema. Never run it to verify restored rows or against a valuable database. Container paths above are isolated container data, not host scratch artifacts; host temporary outputs belong under `$TMPDIR`.

**Proposed acceptance thresholds, to confirm before implementation:**

- Correctness/security: all required cases pass; no cap/mask/auth regression; no production secrets used.
- Raw binary: exact `N+38` envelope size; at least 45% logical-byte reduction versus legacy for fixtures of at least 1 KiB. Tiny payloads need not meet a percentage target.
- Auto compression: never larger than raw binary; at least 20% further reduction on the explicitly designated representative compressible cohort. No savings requirement for tiny/incompressible fixtures.
- CPU/latency: p95 additional seal/decode overhead at the 512 KiB cap no more than 5 ms each versus binary raw, p95 event-loop delay increase no more than 5 ms, and capture-enabled throughput regression no more than 5% at representative concurrency. These are proposed budgets, not observed results.
- Memory: no monotonic RSS growth across repeat batches; peak additional RSS versus binary raw no more than 32 MiB at concurrency 16 on the benchmark host. Report native compressor allocations as well as JS heap.
- PostgreSQL: at least 20% fresh total-relation and WAL reduction versus legacy for the representative cohort, with identical row counts and transaction settings. Report TOAST exceptions openly. If physical/WAL thresholds or compression latency fail, ship only binary raw after approval, or stop and revisit; do not hide unfavorable fixtures.

### Task 6: Update only documentation that the storage change invalidates

**Files:** Modify `docs/superpowers/specs/2026-08-14-body-logging-design.md`, `docs/operations.md`, `ARCHITECTURE.md`, and `apps/cli/src/commands/bodies.ts:64-65` (comment only). Check `README.md` for any surviving sizing claim before editing it.

Document artifact-specific binary encoding, legacy compatibility, plaintext budget versus envelope bytes, mixed-corpus sizing, checksum/GCM roles, and staged rollout. Replace claims that artifacts use exactly the credential encryption path or always double in size. Do not rewrite historic plans. Do not change body retention prose owned by the concurrent retention work; merge/review the current spec before touching adjacent sections. Keep existing SQLite snapshot exclusions and cross-backend copy exclusions explicit. Do not advertise worst-case corpus bytes as PostgreSQL allocated table/WAL size or promise compression ratios for production.

### Task 7: Release A verification and deployment gate

**Files:** Reader implementation/tests/docs above; `sealArtifact` remains legacy-writing.

Run from repository root, against disposable PostgreSQL for store contracts and disposable Redis for the complete cluster contracts:

```bash
unset NODE_ENV OMNI_TEST_DATABASE_URL OMNI_TEST_REDIS_URL
docker run -d --name omni-body-verify-redis -p 127.0.0.1:6399:6379 redis:7-alpine
docker exec omni-body-verify-redis redis-cli ping
# Reuse an explicitly disposable, ready PostgreSQL test server on loopback port 55432.
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:6399 bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
bun run check:claims
bun run check:dead
docker rm -f omni-body-verify-redis
```

Record actual pass/fail/skip counts; a green run with skipped PostgreSQL coverage is insufficient. If new tracked-source files are introduced, dead-export discovery requires intent-to-add before its check, removing that staging afterward; do not commit without separate permission. No production deploy/tag follows automatically from green checks.

### Task 8: Release B activation and rollback rehearsal

**Files:** Modify `packages/store/src/bodies/artifact.ts` default writer to binary-auto (or raw if benchmark approval chooses that); update `packages/store/test/bodies.test.ts` writer-format assertion and release documentation.

1. Keep release A legacy-writing while upgrading **every** gateway replica, CLI/admin tool, standby, restore reader, and scheduled job that opens the same corpus. A rolling fleet with one old reader is not safe for binary writes.
2. Verify dual-reader version coverage operationally; approve release B separately. Release B changes only the writer default, reuses identical reader support, and repeats focused/full gates and the restored-corpus rehearsal.
3. No public codec setting is needed for the minimum rollout: separate releases provide the activation gate. If the operator requires switching writes without deploying, ask first; that is an explicit extra requirement, not a speculative setting.
4. Old readers cannot read either new raw or new gzip binary envelopes. They may persist `detail_state=corrupt` for valid new data, so protect CLI/standby as well as serving replicas. Release A/B readers should recover that state when they can read the bytes again.
5. Safe rollback is to release A (dual-read, legacy-write). This stops new binary writes but does **not** convert existing binary data. Rollback to a pre-dual-reader version is unsafe until all binary rows/files have expired under the actual body retention policy, or an explicitly approved offline conversion/complete matching backup restore has removed them. Disabling capture alone does not make old readers safe.
6. Rehearse legacy writer → dual reader → binary writer → release A rollback using one mixed corpus, checking old-reader failure is documented and new-reader recovery works. Default action remains natural expiry, not rewrite/backfill.

## 4. Existing bloat is separate maintenance

This plan reduces **new write volume**. It does not shrink allocated PostgreSQL files containing old/dead tuples. Ordinary vacuum/autovacuum reclaims space for reuse and may truncate some empty tail pages, but is not a guaranteed full shrink. TOAST, WAL, replication, and backups need separate observation. Any `VACUUM FULL`, repack, or table rewrite requires separate approval, lock/downtime planning, free-space and replica-impact checks; none is included or automatically scheduled here.

For SQLite, the optimized body bytes are external files, not inline DB pages. New smaller artifacts do not reclaim old directory contents until existing pruning removes them. Database vacuum does not compact the artifact directory.

## 5. Approval points and tradeoffs

- **Recommended minimum:** artifact-local binary format plus legacy reader; async gzip only if native bounds and benchmark budgets hold. Binary-only remains a useful fallback without compression complexity.
- **CPU versus bytes:** native gzip level 1 and save-at-least-64-byte selection are proposed defaults; benchmark data decides the final threshold/level. Raw fallback prevents incompressible-size regression but still pays an attempted compression cost above the cutoff.
- **Privacy:** compression exposes compressed-length information to someone observing artifact sizes; storage is not a public compression oracle. Continue masking/gating/access control, never expose compression ratios on request paths or log plaintext.
- **Compatibility versus immediate benefit:** two releases avoid a new setting and schema work but delay write activation until all readers are upgraded. Historical corpus savings arrive only as legacy artifacts naturally expire.
- **Open decisions:** approve the binary layout/AAD contract; confirm target Bun version supports bounded async gunzip and strict malformed-stream behavior; approve representative synthetic/sanitized fixture mix and provisional budgets; choose raw-only versus gzip after measurements; select release A/B rollout dates and minimum rollback reader version.

**Completion for this planning task:** this English plan only. No code implemented, committed, benchmarks run, production database touched, backfill started, or maintenance scheduled.
