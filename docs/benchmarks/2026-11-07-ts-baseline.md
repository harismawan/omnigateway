# Gateway baseline: TypeScript on Bun 1.4.4

These are the numbers any rewrite of the gateway is judged against, in both
deployment shapes the project ships: a single process on SQLite, and the k8s
shape (Postgres, Redis, several replicas). The raw output is in
[`2026-11-07-ts-baseline.json`](2026-11-07-ts-baseline.json) (single) and
[`2026-11-07-ts-baseline-cluster.json`](2026-11-07-ts-baseline-cluster.json)
(cluster).

## How it was measured

`scripts/bench-gateway.ts` is black-box. It starts the gateway from an argv,
configures it through the `omni` CLI (single) or the admin API (cluster), and
measures it only over HTTP, `/proc` and container cgroups. Nothing imports
gateway code, so the same run works against any implementation that keeps
the CLI, admin API and wire contracts.

- **Upstream.** `scripts/bench-gateway-upstream.ts` runs as two processes on
  one port, reached through a `custom` chat-completions credential. The
  upstream model name scripts each reply (`mock-c<chunks>-d<delayMs>`). No
  provider is called. The upstream alone serves about 74k req/s, so it is not
  the ceiling.
- **Host.** i5-13400, 8 cores, no SMT, Linux 6.12. `oha` runs on cores 6-7.
- **Single.**
  - Gateway on cores 0-3, upstream on 4-5.
  - SQLite store, request logging on, body capture off, `OMNI_LOG_LEVEL=warn`.
- **Cluster.**
  - Two replicas, `OMNI_CLUSTER_MODE=true`, on cores 0-1 and 2-3.
  - Postgres 17 and Valkey 8 in docker, sharing core 4. Upstream on core 5.
  - Load is split evenly, with one `oha` per replica. The "+db" column is the
    Postgres and Valkey CPU per request, read from their cgroups.
- **Duration.** 20 s per scenario after a 3 s warmup.
  - `-w` lets in-flight requests finish at the deadline. Only the cancel
    scenarios disconnect on purpose.
- **Build.** `bun scripts/build-binary.ts` at `4e524dd4`.

```sh
bun scripts/build-binary.ts /tmp/bench/omnigateway

# single
bun scripts/bench-gateway.ts --gateway /tmp/bench/omnigateway \
  --cli "bun apps/cli/src/index.ts" --out docs/benchmarks/<date>-<label>.json

# cluster
docker run -d --rm --name omni-bench-pg --network host --cpuset-cpus 4 \
  -e POSTGRES_PASSWORD=omni -e POSTGRES_DB=omni_bench_cluster -e PGPORT=55432 \
  postgres:17-alpine -c max_connections=300 -c shared_buffers=256MB
docker run -d --rm --name omni-bench-redis --network host --cpuset-cpus 4 \
  valkey/valkey:8-alpine valkey-server --port 56379 --save "" --appendonly no
bun scripts/bench-gateway.ts --gateway /tmp/bench/omnigateway \
  --cli "bun apps/cli/src/index.ts" --cluster --replicas 2 \
  --gateway-cpus 0-1,2-3 --upstream-cpus 5 \
  --database-url postgres://postgres:omni@127.0.0.1:55432/omni_bench_cluster \
  --redis-url redis://127.0.0.1:56379 --containers omni-bench-pg,omni-bench-redis \
  --out docs/benchmarks/<date>-<label>-cluster.json
```

## Single process (SQLite)

- **Process:**
  - boot to first healthy `/health`: 59 ms
  - idle RSS 56 MiB, 111 MiB after the run
  - binary 111 MiB
  - `omni keys list` 99 ms p50
- **Shutdown after the run:** 5.0 s, against 6 ms when idle. The early-cancel
  scenario ran just before it.

| scenario | clients | req/s | p50 ms | p99 ms | p99.9 ms | CPU ms/req | RSS peak MiB | crashed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| overhead-c1: chat SSE, 1 chunk | 1 | 1028 | 0.68 | 11.10 | 16.13 | 0.688 | 117 | 0 |
| chat-stream: chat SSE, 1 chunk | 64 | 1473 | 41.65 | 70.27 | 82.52 | 0.466 | 126 | 0 |
| anthropic-json: non-streaming, translated | 64 | 1536 | 39.25 | 67.76 | 223.26 | 0.441 | 122 | 0 |
| responses-stream: Responses SSE, translated | 64 | 1361 | 45.60 | 75.51 | 89.27 | 0.532 | 129 | 0 |
| agent-100k: ~100 KiB agent transcript | 32 | 917 | 35.57 | 57.42 | 68.23 | 0.990 | 152 | 0 |
| many-chunks: 2000 upstream chunks/reply | 16 | 160 | 93.45 | 204.90 | 220.04 | 5.874 | 156 | 0 |
| rate-limited-key: request/token/concurrency limits | 64 | 1377 | 44.29 | 73.07 | 92.63 | 0.527 | 133 | 0 |
| held-streams: 1000 streams × 30 s | 1000 | — | 30940 | 31579 | 31599 | 2.160 | 183 | 0 |
| client-cancel: abandon 30 s streams at 2 s | 200 | — | — | — | — | 0.770 | 171 | 0 |
| early-cancel: abandon after 1 ms | 64 | — | — | — | — | 0.021 | 204 | 0 |

In held-streams the time to first byte was 827 ms at p50 and 1553 ms at p99,
even though the upstream answers at once. That delay is the cost of admitting
1000 streams together.

## Cluster (2 replicas, Postgres 17 + Valkey 8)

- **Process:** boot 85 ms p50; idle RSS 117 MiB for the fleet.
- **CPU per request:** "gateway" is the replicas; "+db" is Postgres plus Valkey.

| scenario | clients | req/s | p50 ms | p99 ms | p99.9 ms | gateway CPU ms/req | +db CPU ms/req | RSS peak MiB | crashed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| overhead-c1 | 1 | 376 | 4.40 | 18.97 | 28.80 | 1.157 | 1.381 | 210 | 0 |
| chat-stream | 64 | 401 | 156.72 | 243.36 | 296.50 | 0.916 | 1.179 | 219 | 0 |
| anthropic-json | 64 | 236 | 170.30 | 1525.62 | 2546.64 | 1.047 | 1.298 | 210 | 0 |
| responses-stream | 64 | 404 | 154.10 | 267.50 | 318.17 | 0.834 | 1.171 | 225 | 0 |
| agent-100k | 32 | 206 | 89.43 | 840.28 | 1084.21 | 2.086 | 1.404 | 244 | 0 |
| many-chunks | 16 | 176 | 86.29 | 158.76 | 188.16 | 6.762 | 1.542 | 343 | 0 |
| rate-limited-key | 64 | 367 | 171.55 | 260.94 | 293.88 | 1.024 | 1.404 | 231 | 0 |
| held-streams | 1000 | — | 30734 | 30795 | 30803 | 2.630 | 0.503 | 249 | 0 |
| client-cancel | 200 | — | — | — | — | — | — | 259 | **2 of 2** |
| early-cancel | 64 | — | — | — | — | — | — | **4183** | 0 |

## Findings

### 1. Cluster replicas crash when a client disconnects early (live bug)

A client that disconnects while its request is being sent upstream can kill a
cluster-mode replica with an uncaught `error: aborted`.

- **When it happens.** In the full run, both replicas died during
  client-cancel. In a manual reproduction, 50 one-at-a-time `curl -m 0.002`
  requests were enough. Single mode survived 200 of the same requests, and its
  two early-cancel runs here, without a crash.
- **Where the error comes from.** `packages/providers/src/http-client.ts`
  rejects its promise with `new Error("aborted")` when the dispatch signal
  fires.
- **Leading hypothesis.** `waitForCancellation` in
  `apps/gateway/src/dispatch/index.ts` rejects with `signal.reason` as soon as
  the signal aborts, and it abandons the `attempt()` promise it was racing.
  That promise rejects a moment later with the transport's `aborted`, and
  nothing is attached to observe it. Bun treats an unhandled rejection as fatal
  (`/tmp` reproduction: same shape, same trace, exit 1).
- **Why only cluster mode (unproven).** The Postgres and Redis awaits before
  the send widen the window in which the abort lands inside that race. The
  SQLite store is synchronous.
- **Not yet confirmed.** A fix and a regression test against the real code
  path.

### 2. Cluster replicas grow memory without bound under early disconnects (live bug)

In early-cancel the fleet grew from 115 MiB to 4.2 GiB in 20 s and did not
give it back.

- **Isolated reproduction** (one replica, 64 clients abandoning after 1 ms):
  RSS climbed roughly linearly, from 81 MiB to 1.4 GiB over 15 s. It was still
  1.4 GiB after 5 s idle.
- **The same load in single mode** went from 56 to 151 MiB and settled to
  97 MiB.

At the k8s limit of 512 MiB, a pod would be OOM-killed within a few seconds of
this traffic. The cause is not yet investigated.

### 3. Each process is effectively single-core

- **Single mode.** Pinned to four cores, the gateway uses about 0.7 CPU-s per
  second. Throughput is 1 / (CPU per request), about 1.4k req/s, and latency
  under load is queueing time. One client sees a 0.7 ms p50; 64 clients see
  42 ms.
- **Cluster mode.** It is slower per request: two replicas together serve
  about 400 req/s, against 1.4k for one SQLite process.
  - Each request costs 0.9-1.2 ms of gateway CPU, plus about 1.2-1.4 ms of
    Postgres and Valkey CPU.
  - Each replica's 2 cores are not saturated, so part of the latency is waiting
    on the round trips to the database and Redis.

### 4. Tail latency

- **Single mode.** p99 is 11 ms with one idle client, against a 0.7 ms p50.
  Those stalls are not caused by load.
- **Cluster mode.** The non-streaming and 100 KiB scenarios reach p99 of
  0.8-1.5 s. Plain streaming stays at 0.25 s.

### 5. Other observations

- **Per-chunk cost** is about 3 µs, so a 2000-chunk reply costs about 6 ms of
  CPU.
- **Memory** in single mode peaks around 180-200 MiB under 1000 streams or
  early cancels. It drops back partly, to about 110 MiB.
- **The SQLite database** reached 224 MB after the single run.

## Caveats

- Loopback only. Real upstream latency is hundreds of ms to seconds, so these
  numbers measure gateway overhead, not what clients see end to end.
- Single run per shape. Expect a few percent of noise between runs. A trial
  showed a 925 ms p99 on rate-limited-key that the full run did not reproduce,
  so rerun before quoting tails.
- Postgres and Valkey share one core and run in docker on the same host. A
  managed database on a network would shift the cluster numbers. The core
  sharing is a property of this rig, not of production.
- Percentiles for the two-replica fleet are request-weighted means of each
  replica's percentiles, not exact merged percentiles. The per-replica values
  are in the JSON.
