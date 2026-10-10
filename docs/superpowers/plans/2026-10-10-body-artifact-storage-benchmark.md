# Body artifact envelope benchmark (Task 5)

Measured 2026-10-11 on branch `feat/body-artifact-binary-writer` (base `8c9aec5`, Release A).
Plan: [body artifact storage optimization](2026-10-10-body-artifact-storage-optimization.md),
Task 5. Script: `scripts/bench-body-artifacts.ts`.

**Recommendation: binary-raw.** The decision rule is the plan's acceptance thresholds: binary-auto
ships only if it meets every one of them. Otherwise binary-raw ships if it meets its own, and
otherwise the work stops. Binary-auto passes size, memory, event-loop, throughput and PostgreSQL. It
fails the CPU/latency budget at the 512 KiB cap. At concurrency 1 the synthetic incompressible cap
fixture adds 5.8 ms of p95 seal time over raw, against a 5 ms budget. At concurrency 16 every cap
fixture is over budget: seal adds up to 15.5 ms and decode up to 11.5 ms. Binary-raw passes every
threshold that applies to it. The plan says to ship binary-raw "only after approval", so this needs
an explicit go before Task 8 switches the writer.

All numbers below come from synthetic data on one machine. They describe these fixtures on this
host. They are **not** an estimate of production savings, and the unweighted corpus averages are no
production mix.

## Method

### Modes

All three modes seal the same `prepareArtifact(input).json`, so masking, structural bounding and the
512 KiB omission budget are identical. Only the envelope differs.

| Mode | Call | Notes |
| --- | --- | --- |
| `legacy` | `sealArtifact(key, json)` | Today's writer: `enc:v1:` hex, `2N + 65` bytes. |
| `binary-raw` | `sealBinaryArtifact(key, json, keepRaw)` | **Uses the test-only `compress` seam.** `keepRaw` returns its input unchanged. The saving is then 0 bytes, under the policy's 64-byte minimum, so the production policy picks codec 0. Production code has no other way to force raw at or above 1 KiB. |
| `binary-auto` | `sealBinaryArtifact(key, json)` | The production policy as written: skip below 1,024 B, gzip level 1, keep it only if it saves at least 64 B. |
| `binary-auto --gzip-level 6` | Seam with `gzip(level 6)` | Informative only: the same policy with a different level. Not a candidate under the thresholds. |

Decode is `decodeArtifact(key, bytes, sha256)` in every mode. The key is derived once per process
from a benchmark-only secret, and KDF time (~22 ms) is excluded from every timing. No production
code was changed.

### Corpus

The corpus is generated deterministically by the script (mulberry32, fixed seeds). The script uses
no production data, makes no provider calls and handles no real credentials. There are 12 classes
with 24 variants each, 288 fixtures in total. Each fixture goes through `prepareArtifact`
unchanged.

| Class | What it is | Cohort |
| --- | --- | --- |
| `tiny-empty` | Null or `{}` pairs, with zero or one attempt | tiny |
| `short-chat` | One user turn with a reply. Client and attempt mirrored, as a passthrough is. | **representative** |
| `tool-schema` | 8-40 tool definitions with JSON schemas. Bounded to the last 24 tools. | **representative** |
| `tool-result` | 2-6 tool_use/tool_result rounds carrying synthetic code and logs | **representative** |
| `multilingual` | CJK, kana, Cyrillic, Arabic, Devanagari, Latin and emoji text | **representative** |
| `many-attempts` | 3-8 failover attempts with error bodies, with or without a final error | **representative** |
| `sse-frames` | 30-400 SSE frames. Bounding keeps the last 24. | **representative** |
| `omission-marker` | Input over the budget after bounding, so it becomes an omission marker | tiny |
| `near-cap-varied` | 456-496 KB of mixed prose, code and logs | **representative** |
| `near-cap-repetitive` | One paragraph repeated up to the cap: **labelled synthetic best case** | excluded |
| `high-entropy` | Random printable ASCII that survives masking, at the cap: **labelled synthetic worst case** | excluded |
| `masked-base64` | Image blocks with 27-64 KB of standard base64 that masking partly redacts | excluded (sanitizer-shaped) |

The representative compressible cohort was fixed in the script (`REPRESENTATIVE`) before any
measurement. The text is built from a synthetic syllable vocabulary with a Zipf-like distribution,
so its compressibility is a property of the generator, not of real prompts.

**Sanitizer effect.** Masking runs before sealing. Standard base64 on its own shrinks to 47% of its
length under masking: runs of 41 or more token characters between `+`/`/` become `[redacted]`. What
is stored from `masked-base64` is therefore mostly short runs and redaction markers, which gzip
compresses by 57%. That is a sanitizer effect, not image compression. The "pre-mask / stored"
column below also includes bounding: `sse-frames` 2.44x and `tool-schema` 1.19x come from the
24-item array bound, and `omission-marker` 1,754x comes from the omission budget.

### Runs

- **In memory:** 1,000 operations per repeat, cycling through the 288 fixtures, with 200 warm-up
  operations and 5 repeats. Each repeat runs a seal phase and then a decode phase, with
  `Bun.gc(true)` before and after it. There were two passes per configuration in opposite orders
  (pass a: raw, auto, legacy; pass b: auto, raw, legacy), at concurrency 1 and at concurrency 16.
  Every run used a separate process.
- **PostgreSQL:** 10,000 rows per mode at concurrency 16, in 5 batches of 2,000. Each mode got its
  own new database, created with `createdb`, and ran in its own process. That was done twice: once
  for the representative cohort and once for all 12 classes. A row is one capture as
  `BodyRepo.put` performs it on Postgres: `prepareArtifact`, seal, then the same `INSERT … ON
  CONFLICT` statement. The script repeats that statement because the repo seals legacy only. The
  pool is `openPg`'s default (Bun `SQL`, default `max`), as in the gateway. There was one
  `CHECKPOINT` before the first batch. WAL is `pg_wal_lsn_diff` of `pg_current_wal_insert_lsn()`
  around each batch. Sizes were taken after the inserts and before a separate upsert batch, which
  re-puts the first 1,000 rows.
- **Timings:** seal and decode are `performance.now()` around each awaited call. At concurrency 16
  a timing includes time spent queued behind other in-flight operations on the JS thread or the
  zlib thread pool, which is the latency a capture actually sees. CPU is `process.cpuUsage()` for
  the whole process across all threads, so native zlib work counts. Event-loop delay is
  `monitorEventLoopDelay({resolution: 1})` per phase. Memory is `process.memoryUsage()` sampled
  every 5 ms.
- **Correctness:** every run seals every fixture in all three envelopes and decodes each one back,
  outside timing. It checks that legacy is `2N+65`, raw is `N+38` with codec 0, auto is never
  larger than raw, and the artifact round-trips exactly. There were 0 violations across all 13
  in-memory and 6 PostgreSQL runs.

### Environment

| | |
| --- | --- |
| Runtime | Bun 1.4.3, linux-x64; `process.versions.zlib` `12731092979c6d07f42da27da673a9f6c7b13586` |
| CPU / RAM | 13th Gen Intel Core i5-13400, 8 logical CPUs visible; 15.4 GiB |
| Database | PostgreSQL 16.15 (postgres:16-alpine, Docker, loopback). `full_page_writes=on`, `wal_compression=off`, `synchronous_commit=on`, `default_toast_compression=pglz`, `max_wal_size=1GB`, `checkpoint_timeout=5min`, `shared_buffers=128MB` |
| Isolation | One disposable container with no other clients. The database shares the host CPU with the benchmark process. |

## Results

### Logical envelope bytes (census, 24 fixtures per class)

| Class | N min / median / max (B) | Pre-mask / stored plaintext | Legacy (B) | Raw (B) | Auto L1 (B) | Raw vs legacy | Auto L1 vs raw | gzip chosen (L1) | Auto L6 vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-empty | 160 / 161 / 258 | 1.00x | 11,208 | 5,736 | 5,736 | 48.8% | 0.0% | 0/24 | 0.0% |
| short-chat | 2,377 / 4,426 / 5,733 | 1.00x | 208,684 | 104,474 | 41,968 | 49.9% | 59.8% | 24/24 | 71.0% |
| tool-schema | 23,814 / 55,022 / 66,607 | 1.19x | 2,460,696 | 1,230,480 | 358,613 | 50.0% | 70.9% | 24/24 | 81.2% |
| tool-result | 36,287 / 94,373 / 179,481 | 1.00x | 4,779,384 | 2,389,824 | 1,226,732 | 50.0% | 48.7% | 24/24 | 64.4% |
| multilingual | 10,738 / 21,474 / 37,526 | 1.00x | 1,114,256 | 557,260 | 211,949 | 50.0% | 62.0% | 24/24 | 73.2% |
| many-attempts | 11,015 / 25,559 / 52,926 | 1.00x | 1,294,020 | 647,142 | 117,623 | 50.0% | 81.8% | 24/24 | 87.6% |
| sse-frames | 19,791 / 77,922 / 80,184 | 2.44x | 3,141,874 | 1,571,069 | 829,604 | 50.0% | 47.2% | 24/24 | 66.1% |
| omission-marker | 692 / 693 / 693 | 1,753.59x | 34,804 | 17,534 | 17,534 | 49.6% | 0.0% | 0/24 | 0.0% |
| near-cap-varied | 456,550 / 473,587 / 496,443 | 1.00x | 22,798,852 | 11,399,558 | 6,332,204 | 50.0% | 44.5% | 24/24 | 63.5% |
| near-cap-repetitive (best case) | 457,414 / 472,934 / 496,435 | 1.00x | 22,768,956 | 11,384,610 | 628,766 | 50.0% | 94.5% | 24/24 | 96.8% |
| high-entropy (worst case) | 443,352 / 468,694 / 491,508 | 1.00x | 22,590,960 | 11,295,612 | 11,286,157 | 50.0% | **0.1%** | **24/24** | 17.5% |
| masked-base64 | 29,245 / 47,136 / 64,696 | 2.03x | 2,286,412 | 1,143,338 | 485,965 | 50.0% | 57.5% | 24/24 | 67.2% |
| **Representative cohort** (7 classes, equal counts) | | | 35,797,766 | 17,899,807 | 9,118,693 | 50.0% | **49.1%** | | 66.3% |

Unfavourable fixtures:

- `high-entropy` takes gzip on all 24 fixtures for a 0.1% saving, about 400 B on 470 KB. That
  clears the absolute 64-byte minimum, so every read of such a row pays a gunzip for nothing.
- Level 1 on this zlib gains essentially nothing from symbol statistics. Random printable ASCII
  compresses to 99.98% at level 1 and to 83.1% at levels 2-6. That is consistent with a
  fixed-Huffman fast path. Level 1's savings come from matches only.

### Seal / decode latency (ms, median / p95)

Concurrency 1, pass a. There are about 415-420 samples per class per mode: 5 repeats x 1,000
operations / 12 classes.

| Class | Seal legacy | Seal raw | Seal auto | Seal auto−raw p95 | Decode legacy | Decode raw | Decode auto | Decode auto−raw p95 | Seal L6 p95 | Decode L6 p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-empty | 0.076 / 0.182 | 0.049 / 0.087 | 0.049 / 0.093 | 0.006 | 0.111 / 0.207 | 0.050 / 0.086 | 0.056 / 0.088 | 0.002 | — | — |
| short-chat | 0.260 / 0.417 | 0.058 / 0.093 | 0.126 / 0.224 | 0.131 | 0.423 / 0.558 | 0.063 / 0.108 | 0.111 / 0.157 | 0.049 | — | — |
| tool-schema | 2.466 / 3.481 | 0.128 / 0.205 | 0.258 / 0.437 | 0.232 | 3.684 / 4.762 | 0.234 / 0.341 | 0.368 / 0.521 | 0.180 | — | — |
| tool-result | 4.477 / 7.925 | 0.194 / 0.394 | 0.721 / 1.204 | 0.810 | 6.615 / 12.111 | 0.258 / 0.465 | 0.655 / 1.040 | 0.575 | — | — |
| multilingual | 1.114 / 1.805 | 0.098 / 0.173 | 0.211 / 0.318 | 0.145 | 1.579 / 2.746 | 0.117 / 0.183 | 0.202 / 0.311 | 0.128 | — | — |
| many-attempts | 1.204 / 2.308 | 0.094 / 0.183 | 0.161 / 0.248 | 0.065 | 1.787 / 3.397 | 0.105 / 0.176 | 0.172 / 0.266 | 0.090 | — | — |
| sse-frames | 3.344 / 4.128 | 0.169 / 0.295 | 0.530 / 0.742 | 0.447 | 5.306 / 6.086 | 0.214 / 0.323 | 0.511 / 0.639 | 0.316 | — | — |
| omission-marker | 0.092 / 0.143 | 0.048 / 0.081 | 0.049 / 0.080 | −0.001 | 0.138 / 0.222 | 0.057 / 0.098 | 0.060 / 0.092 | −0.006 | — | — |
| near-cap-varied | 21.957 / 27.734 | 0.780 / 1.527 | 3.081 / 3.824 | **2.297** | 90.265 / 97.808 | 0.863 / 1.259 | 2.605 / 3.329 | **2.070** | 10.640 | 3.054 |
| near-cap-repetitive | 21.987 / 26.153 | 0.777 / 1.645 | 0.590 / 0.857 | **−0.788** | 88.537 / 96.624 | 0.805 / 1.329 | 1.092 / 1.727 | **0.398** | 0.901 | 1.703 |
| high-entropy | 22.007 / 26.881 | 0.777 / 1.554 | 5.947 / 7.383 | **5.829** | 88.307 / 95.428 | 0.716 / 1.184 | 2.593 / 3.512 | **2.328** | 11.994 | 3.438 |
| masked-base64 | 2.328 / 3.374 | 0.155 / 0.229 | 0.301 / 0.492 | 0.263 | 3.533 / 4.678 | 0.157 / 0.272 | 0.287 / 0.429 | 0.157 | — | — |

Concurrency 16, pass a. Each time includes queueing behind the other 15 in-flight operations.

| Class | Seal legacy | Seal raw | Seal auto | Seal auto−raw p95 | Decode legacy | Decode raw | Decode auto | Decode auto−raw p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny-empty | 93.4 / 141.5 | 2.119 / 4.810 | 0.338 / 1.341 | −3.469 | 300.5 / 394.3 | 2.639 / 4.925 | 0.472 / 1.125 | −3.800 |
| short-chat | 117.9 / 155.4 | 2.262 / 5.067 | 0.958 / 2.179 | −2.888 | 302.2 / 394.9 | 2.607 / 4.754 | 0.649 / 1.531 | −3.223 |
| tool-schema | 125.7 / 156.8 | 2.516 / 5.427 | 1.317 / 2.905 | −2.522 | 302.4 / 394.4 | 2.738 / 4.926 | 1.397 / 3.093 | −1.833 |
| tool-result | 137.4 / 163.0 | 2.978 / 6.071 | 2.476 / 5.239 | −0.832 | 304.3 / 394.7 | 2.927 / 5.021 | 2.990 / 5.443 | 0.422 |
| multilingual | 123.9 / 159.4 | 2.454 / 5.717 | 1.203 / 2.639 | −3.078 | 300.6 / 393.1 | 2.645 / 4.990 | 1.099 / 2.607 | −2.383 |
| many-attempts | 106.7 / 155.7 | 2.456 / 5.712 | 1.225 / 2.676 | −3.036 | 353.5 / 449.8 | 2.697 / 5.020 | 1.307 / 2.685 | −2.335 |
| sse-frames | 100.2 / 153.0 | 2.862 / 6.439 | 1.946 / 4.213 | −2.226 | 450.1 / 556.9 | 2.960 / 5.576 | 2.362 / 3.975 | −1.601 |
| omission-marker | 89.2 / 140.6 | 2.480 / 5.683 | 0.613 / 1.444 | −4.239 | 460.2 / 555.1 | 2.767 / 5.275 | 0.524 / 1.543 | −3.732 |
| near-cap-varied | 91.6 / 135.3 | 2.921 / 6.548 | 8.576 / 12.835 | **6.287** | 493.5 / 572.7 | 3.288 / 5.941 | 12.470 / 16.301 | **10.360** |
| near-cap-repetitive | 92.4 / 143.0 | 2.779 / 6.067 | 1.645 / 3.472 | **−2.595** | 439.9 / 518.7 | 3.390 / 6.143 | 8.504 / 12.273 | **6.130** |
| high-entropy | 100.5 / 151.3 | 3.036 / 5.737 | 15.962 / 20.941 | **15.204** | 384.1 / 457.0 | 3.557 / 6.342 | 11.784 / 15.760 | **9.418** |
| masked-base64 | 90.6 / 139.8 | 2.102 / 4.773 | 1.343 / 2.864 | −1.909 | 324.6 / 398.7 | 2.676 / 5.444 | 1.411 / 2.665 | −2.779 |

Cap fixtures in both passes, as p95 auto − raw in ms. The cap budget is 5 ms.

| Fixture | c1 seal a / b | c1 decode a / b | c16 seal a / b | c16 decode a / b |
| --- | --- | --- | --- | --- |
| near-cap-varied | 2.30 / 2.39 | 2.07 / 1.96 | **6.29 / 6.46** | **10.36 / 11.46** |
| near-cap-repetitive | −0.79 / −0.71 | 0.40 / 0.37 | −2.60 / −2.54 | **6.13 / 6.64** |
| high-entropy | **5.83 / 5.77** | 2.33 / 2.05 | **15.20 / 15.53** | **9.42 / 9.64** |

The below-cap classes get faster under auto at concurrency 16. Encrypting and hashing fewer bytes
on the JS thread outweighs the gzip work, which runs off-thread.

### Throughput, CPU, event loop, memory (in memory)

The table shows the median of 5 repeats. The ELD column gives the median of the per-repeat p95
values and the largest of them. Peak values are the maximum over the 5 repeats.

| Run | Seal ops/s | Seal CPU ms/op | Seal ELD p95 ms | Decode ops/s | Decode CPU ms/op | Decode ELD p95 ms | Peak RSS MiB | Peak heap MiB | Peak external MiB | RSS after GC per repeat (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy c1 a | 144.5 | 7.189 | 22.7 / 22.8 | 41.3 | 23.707 | 56.9 / 57.2 | 906.4 | 420.4 | 406.0 | 250.6, 252.7, 245.2, 233.4, 243.0 |
| raw c1 a | 3,096.5 | 0.330 | 0.55 / 0.71 | 3,125.8 | 0.332 | 0.58 / 0.64 | 483.0 | 221.2 | 264.6 | 229.7, 231.9, 233.3, 230.8, 229.9 |
| auto c1 a | 979.5 | 1.071 | 0.63 / 0.67 | 1,338.4 | 0.753 | 0.55 / 0.64 | 438.7 | 173.2 | 181.4 | 272.0, 271.1, 272.9, 268.6, 273.8 |
| legacy c1 b | 142.9 | 7.232 | 22.5 / 25.8 | 41.1 | 23.836 | 56.6 / 56.7 | 1,118.1 | 428.0 | 409.4 | 227.5, 229.0, 232.5, 217.3, 238.1 |
| raw c1 b | 3,024.8 | 0.346 | 0.57 / 0.73 | 3,078.4 | 0.333 | 0.63 / 0.72 | 504.0 | 221.5 | 257.4 | 256.8, 262.8, 261.1, 258.0, 243.9 |
| auto c1 b | 969.1 | 1.077 | 0.57 / 0.58 | 1,315.1 | 0.767 | 0.50 / 0.53 | 411.8 | 176.1 | 183.3 | 257.9, 255.2, 254.4, 254.0, 253.6 |
| legacy c16 a | 147.7 | 7.437 | 484.4 / 508.0 | 41.8 | 23.562 | 1,782.6 / 1,814.0 | 1,123.7 | 465.3 | 465.4 | 226.8, 220.9, 226.1, 216.9, 222.8 |
| raw c16 a | 4,986.5 | 0.369 | 14.7 / 15.7 | 5,061.1 | 0.373 | 14.4 / 15.4 | 650.0 | 284.1 | 330.7 | 307.6, 319.9, 317.5, 318.8, 298.1 |
| auto c16 a | 4,727.8 | 1.086 | 3.0 / 3.5 | 3,991.5 | 0.748 | 2.2 / 2.9 | 639.1 | 313.4 | 320.0 | 307.5, 310.9, 314.5, 305.7, 313.6 |
| legacy c16 b | 142.9 | 7.712 | 488.1 / 496.2 | 42.0 | 23.445 | 1,732.2 / 1,805.6 | 1,124.7 | 551.7 | 540.5 | 231.4, 227.6, 226.2, 217.3, 225.6 |
| raw c16 b | 4,989.1 | 0.371 | 16.3 / 17.5 | 4,789.0 | 0.385 | 14.4 / 17.4 | 646.7 | 287.5 | 327.9 | 283.0, 287.2, 288.4, 287.8, 288.9 |
| auto c16 b | 4,747.2 | 1.090 | 2.7 / 2.9 | 3,974.6 | 0.747 | 2.3 / 2.7 | 672.9 | 341.7 | 352.7 | 322.1, 312.7, 308.2, 305.8, 318.5 |
| auto L6 c1 | 477.1 | 2.124 | 0.63 / 0.67 | 1,372.9 | 0.740 | 0.50 / 0.63 | 380.9 | 157.6 | 160.6 | 263.7, 263.4, 257.7, 259.1, 251.3 |
| auto L6 c16 | 2,707.6 | 2.385 | 1.7 / 1.7 | 4,330.6 | 0.689 | 2.0 / 2.1 | 621.1 | 311.8 | 313.8 | 313.1, 315.3, 328.0, 320.2, 316.2 |

Bun does not report the compressor's native allocations separately. They show up only in RSS,
outside the heap and external figures, so the peak-RSS comparison is the bound on them here.

### PostgreSQL: 10,000 rows per mode, concurrency 16, separate new database per mode

Representative cohort (7 classes):

| Mode | sum(size_bytes) | sum(octet_length) | sum(pg_column_size) | pg_table_size | pg_indexes_size | pg_total_relation_size | TOAST total | WAL (inserts) | Checkpoints during | Capture rows/s (median of 5) | CPU ms/row | ELD p95 ms | Peak RSS MiB | Upsert WAL (1,000 rows) | Upsert rows/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | 2,130,597,810 | 2,130,597,810 | 2,130,597,810 | 2,219,360,256 | 1,032,192 | 2,220,392,448 | 2,217,017,344 | 2,290,645,568 | 4 | 154.2 | 7.474 | 71.9 / 75.4 | 486.0 | 453,600,608 | 148.7 |
| binary-raw | 1,065,353,905 | 1,065,353,905 | 1,065,353,905 | 1,115,537,408 | 1,032,192 | 1,116,569,600 | 1,113,243,648 | 1,150,332,016 | 2 | 869.9 | 1.311 | 12.0 / 12.4 | 319.1 | 226,829,504 | 888.2 |
| binary-auto | 542,798,768 | 542,798,768 | 542,801,888 | 570,294,272 | 1,032,192 | 571,326,464 | 566,812,672 | 587,642,912 | 1 | 847.6 | 1.834 | 10.6 / 10.9 | 309.6 | 115,949,120 | 713.5 |

Per-batch capture rows/s: legacy 155.4, 155.7, 149.9, 154.2, 153.4. Raw 869.9, 877.6, 897.3, 863.5,
746.5. Auto 689.9, 858.2, 847.6, 842.3, 857.0. WAL per 2,000-row batch was steady: legacy 457-458
MB, raw 229-231 MB, auto 117-118 MB.

All 12 classes:

| Mode | sum(octet_length) | pg_table_size | pg_total_relation_size | WAL (inserts) | Checkpoints during | Capture rows/s (median of 5) | CPU ms/row | ELD p95 ms | Peak RSS MiB | Upsert WAL (1,000 rows) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | 2,898,359,548 | 3,019,464,704 | 3,020,496,896 | 3,121,872,168 | 5 | 111.6 | 9.491 | 92.3 / 95.0 | 585.1 | 618,433,304 |
| binary-raw | 1,449,234,774 | 1,514,741,760 | 1,515,773,952 | 1,560,334,544 | 2 | 524.0 | 2.115 | 23.5 / 23.9 | 491.3 | 309,586,184 |
| binary-auto | 747,890,274 | 783,228,928 | 784,261,120 | 808,892,496 | 1 | 514.4 | 2.904 | 18.0 / 18.4 | 430.7 | 159,634,464 |

Per-class stored bytes in the all-class databases, as `sum(octet_length(bytes))`, 833-834 rows per
class:

| Class | Legacy | Raw | Auto |
| --- | --- | --- | --- |
| tiny-empty | 394,580 | 201,877 | 201,877 |
| short-chat | 7,259,738 | 3,634,456 | 1,462,378 |
| tool-schema | 85,483,266 | 42,746,220 | 12,451,583 |
| tool-result | 166,277,874 | 83,143,524 | 42,699,968 |
| multilingual | 38,696,823 | 19,352,993 | 7,363,602 |
| many-attempts | 44,862,321 | 22,435,742 | 4,083,446 |
| sse-frames | 109,172,615 | 54,590,889 | 28,832,321 |
| omission-marker | 1,212,797 | 610,980 | 610,980 |
| near-cap-varied | 791,239,277 | 395,624,220 | 219,792,351 |
| near-cap-repetitive | 790,284,749 | 395,146,956 | 21,793,676 |
| high-entropy | 784,090,325 | 392,049,744 | 391,722,979 |
| masked-base64 | 79,385,183 | 39,697,173 | 16,875,113 |

TOAST behaviour:

- **No row was TOAST-compressed in any mode.** `pg_column_size` equals `octet_length` for every
  out-of-line value. The legacy hex envelope is not compressed by pglz either, so PostgreSQL was
  not already recovering the hex expansion, and the physical savings follow the logical ones.
- The only differences are a few bytes of inline varlena header on tiny values.
- Almost all bytes live in the TOAST relation. The main heap is 2.3-3.9 MB and the primary-key
  index is 1 MB in every mode.

Checkpoints: one `CHECKPOINT` ran before the inserts. Requested checkpoints then followed WAL
volume (`max_wal_size=1GB`): 4-5 for legacy, 2 for raw and 1 for auto. Full-page images after each
checkpoint are part of the measured WAL. The format pays for them in proportion to the bytes it
writes, so they are included rather than isolated.

Cross-check: the brief's `psql` size query run after each benchmark agrees on `count`,
`sum(size_bytes)` and `sum(octet_length)`. Its `pg_table_size` is about 10% larger in every mode
because it runs after the upsert batch has left dead tuples.

### Dump, restore, read-only verification (all-class databases)

Each mode followed the same steps: `pg_dump -Fc`, then `createdb omni_restore`, then `pg_restore`,
then `bench-body-artifacts.ts --verify-restored`. The verifier uses one session with
`default_transaction_read_only = on` and never drops or writes anything. For every row it
regenerates the fixture from the row id, decodes the restored bytes and compares them exactly.

| Mode | Dump size | Dump + restore | Rows verified | Formats seen | Failures |
| --- | --- | --- | --- | --- | --- |
| legacy | 1,888,449,498 | 1,140 s | 10,000 | legacy 10,000 | 0 |
| binary-raw | 1,653,890,864 | 119 s | 10,000 | binary-raw 10,000 | 0 |
| binary-auto | 853,981,763 | 60 s | 10,000 | binary-gzip 8,333, binary-raw 1,667 | 0 |

The verifier can fail: on a scratch database, one row with a single byte altered was reported
`corrupt` and the run exited 1. The brief's
`OMNI_TEST_DATABASE_URL=… bun test packages/store/test/contract/bodies.test.ts` passed against the
disposable server: 22 tests, 0 failures.

## Threshold verdicts

| Threshold | Measured | Verdict |
| --- | --- | --- |
| Correctness/security: required cases pass, no cap/mask/auth regression, no production secrets | 0 census violations in all 19 runs (288 fixtures each; 168 in representative-cohort runs). 30,000 restored rows decode exactly. Masking and bounding run unchanged through `prepareArtifact`. Synthetic key and data only. Body contract suite 22/22. | PASS |
| Raw: exact `N+38` | Every fixture, every run | PASS |
| Raw: ≥45% logical reduction vs legacy for fixtures ≥1 KiB | 240/240 fixtures; class minimum 49.9% (`short-chat`) | PASS |
| Auto: never larger than raw | 0 violations | PASS |
| Auto: ≥20% further reduction, representative cohort | 49.1% logical (census); 49.0% `sum(octet_length)` in Postgres | PASS |
| CPU/latency: p95 seal overhead at the 512 KiB cap ≤5 ms vs raw | c1: varied +2.30/+2.39, repetitive −0.79/−0.71, **high-entropy +5.83/+5.77**. c16: **varied +6.29/+6.46**, repetitive −2.60/−2.54, **high-entropy +15.20/+15.53** | **FAIL** |
| CPU/latency: p95 decode overhead at the cap ≤5 ms vs raw | c1: +2.07/+1.96, +0.40/+0.37, +2.33/+2.05. c16: **+10.36/+11.46, +6.13/+6.64, +9.42/+9.64** | **FAIL** (c16) |
| CPU/latency: p95 event-loop delay increase ≤5 ms | In memory c1 seal +0.09/+0.00 ms. c16 seal 3.0 vs 14.7 and 2.7 vs 16.3 (lower). Postgres c16 10.6 vs 12.0 and 18.0 vs 23.5 (lower) | PASS |
| CPU/latency: capture-enabled throughput regression ≤5% at representative concurrency (16) | Postgres capture rows/s vs raw: −2.6% (representative), −1.8% (all classes). Against legacy, +450% and +361%. | PASS |
| Memory: no monotonic RSS growth across repeats | RSS after GC flat in every run (above) | PASS |
| Memory: peak additional RSS vs raw ≤32 MiB at c16 | In memory −10.9 (pass a), +26.2 (pass b). Postgres −9.5 and −60.6. | PASS (within run-to-run noise: auto's own peak differs 34 MiB between passes) |
| PostgreSQL: ≥20% fresh total-relation reduction vs legacy, representative cohort | Auto −74.3%, raw −49.7% | PASS (both) |
| PostgreSQL: ≥20% WAL reduction vs legacy, representative cohort | Auto −74.3%, raw −49.8% | PASS (both) |

Binary-raw against the same budgets, measured relative to legacy where raw is the baseline above:

- It is faster on every class and every concurrency.
- Its event-loop delay is lower: in memory at c16, 14.7 ms against 484 ms.
- Its peak RSS is lower: in memory c16, 650 MiB against 1,124 MiB.
- Its capture throughput is 5.6x legacy on the representative cohort.
- Its relation size and WAL are about 50% lower.

## Recommendation

Per the decision rule, **binary-raw**, subject to the approval the plan requires. Binary-auto fails
the cap latency budget, so its constants are not confirmed for shipping.

The decision does not depend on the near-miss alone. The concurrency-1 failure is 0.8 ms over
budget on a labelled synthetic worst case. The concurrency-16 failures are 1.1-10.5 ms over budget
on all three cap fixtures, including the representative `near-cap-varied`, and they reproduce
across both passes.

If auto is revisited later, these measurements bear on the constants:

- **`GZIP_MIN_SAVING_BYTES = 64` is absolute.** It admits a 0.1% saving on a 470 KB incompressible
  body, which costs about 2 ms at c1 and 9-10 ms at c16 of p95 decode on every read for no
  storage benefit. A relative minimum would have stored `high-entropy` raw, but it would not remove
  the seal-time cost of trying gzip, which is the larger part of that fixture's overrun.
- **Level 1 on Bun's zlib** gains nothing from symbol statistics (above). Level 6 saves more (66.3%
  vs raw on the cohort, against 49.1%), but it doubles seal CPU and makes cap seal p95 worse:
  10.6-12.0 ms at c1, 22.7-31.1 ms at c16. It is not a fix for the latency budget.
- The latency budget applies to a capture that completes after the response
  (`apps/gateway/src/routes/proxy.ts`). Whether a per-capture p95 measured under concurrency is the
  right budget for that path is a question for the plan owner. This document only applies the
  budget as written.

## Limitations

- **Synthetic data only.** Generated vocabularies and code templates set compressibility. Class
  weights are equal. Neither is a production distribution, so nothing here predicts production
  savings.
- **One host, shared CPU.** PostgreSQL ran in Docker on the same 8 logical CPUs as the benchmark,
  and the machine was otherwise idle but not isolated (load average 0.3-0.7 at the start). There
  was no CPU pinning and frequency scaling was not controlled. GC was forced between repeats but
  not during them, so GC pauses fall into individual samples. Pass-to-pass spread is the noise
  estimate: up to about 5% for ops/s, up to about 35 MiB for binary peak RSS, and 212 MiB for
  legacy peak RSS.
- **Concurrency-16 latency is queueing latency.** It includes waiting on the JS thread and on
  Bun's zlib thread pool, whose size was not configured or measured.
- **Event-loop delay** uses Bun's `monitorEventLoopDelay` at 1 ms resolution, so differences under
  about 1 ms are not meaningful.
- **WAL** includes checkpoint full-page images, and checkpoint counts differ by mode in proportion
  to WAL volume. No `wal_compression` was tested. Upsert cost is reported once, for 1,000 rows.
- **Native compressor memory** is visible only as RSS. Bun exposes no separate counter.
- The Postgres pool size is Bun `SQL`'s default, as in the gateway, so 16 concurrent captures share
  fewer connections. That pool limit is the same for all three modes.

## Reproducing

```bash
bun scripts/bench-body-artifacts.ts --mode legacy|binary-raw|binary-auto --iterations 1000 --concurrency 1|16 --out "$TMPDIR/x.json"
bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 1000 --concurrency 16 --gzip-level 6
# One new disposable database per mode; the script refuses a non-loopback host and a non-empty table.
docker exec omni-body-bench-pg createdb -U postgres omni_bench_auto
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni_bench_auto \
  bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 10000 --concurrency 16 --postgres --cohort representative
OMNI_TEST_DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/omni_restore bun scripts/bench-body-artifacts.ts --verify-restored
```

Each run prints JSON containing sizes, timings and counts, never payload bytes. The disposable
databases and dumps used here were dropped afterwards.
