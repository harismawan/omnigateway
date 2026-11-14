#!/usr/bin/env bun
/**
 * Black-box latency, throughput, CPU and memory benchmark for the gateway.
 *
 * Black-box on purpose: the gateway is a process started from an argv, set up
 * only through the `omni` CLI and measured only over HTTP and `/proc`. Nothing
 * here imports gateway code, so the same run is repeatable against any
 * implementation that keeps the CLI and wire contracts — which is the point: it
 * is the baseline a rewrite is judged against.
 *
 *   bun scripts/build-binary.ts /tmp/opencode/bench/omnigateway
 *   bun scripts/bench-gateway.ts \
 *     --gateway /tmp/opencode/bench/omnigateway \
 *     --cli "bun apps/cli/src/index.ts" \
 *     --out docs/benchmarks/2026-11-07-ts-baseline.json
 *
 * `--gateway` may be relative (`target/release/omnigateway`): its program
 * path is resolved against the repo root, not the bench root it runs in.
 *
 * Options: `--duration 20s` `--warmup 3s` `--gateway-cpus 0-3` `--upstream-cpus 4-5`
 * `--load-cpus 6-7` `--streams 1000` `--boots 5` `--only <scenario,...>`
 * `--request-timeout 30s` `--rate <req/s>`.
 *
 * **Every request has a row.** The gateway runs with `OMNI_BENCH=1`, which
 * makes the Rust gateway serve `POST /__omni/bench/flush`: a writer barrier.
 * Every event the gateway hands its writer takes a sequence number; the
 * barrier's watermark is the last one at its admission, and it answers once
 * all of those are resolved, with `{watermark, committed, failed, dropped}`
 * for exactly that prefix (`committed + failed + dropped == watermark`). The
 * harness calls it at each scenario's start and end; the scenario's events,
 * drops and failures are the deltas between the two, and the rows it then
 * counts are all in. Any barrier answer but 200 (409 another in flight, 503
 * queue full, 504 server timeout of 30 s), a timeout here (60 s), or an
 * incoherent answer makes the scenario *inconclusive*: flagged, never counted
 * as zero. A gateway without the route (TS, which writes every row
 * synchronously, 404s) is checked by the rows alone.
 *
 * After each scenario (single mode) the request log is read for the
 * scenario's window: every response the clients got must have a `done` row,
 * and no row may still be `pending`. Drops, failures, missing or pending rows
 * flag the scenario and the run. A run that dropped rows is not a
 * like-for-like comparison with one that wrote them all.
 *
 * **Per-request timeout.** Every scenario but the held and cancelling ones
 * passes `-t` (`--request-timeout`, 30 s), so one wedged connection becomes a
 * counted error instead of a run that never ends.
 *
 * **Host calibration.** Before the run, a fixed CPU-bound loop is timed on
 * each vCPU, alone and then all at once, and recorded with the output: a slow
 * or contended vCPU shows up there, so runs on different days are comparable.
 * During each scenario the CPU time spent by processes other than the bench's
 * own is sampled too (`foreignCores`): load from elsewhere on the host is the
 * first thing that makes two runs of one binary disagree.
 *
 * `--rate` caps every duration scenario (the cancelling ones included) at that
 * many requests per second (`oha -q`), for finding and reporting the highest
 * rate a gateway sustains without dropping log rows. The scenario shapes are
 * otherwise unchanged; held-streams has a fixed request count and no cap.
 *
 * **Cluster mode** (`--cluster`) runs the k8s shape instead: Postgres + Redis,
 * `OMNI_CLUSTER_MODE=true`, `--replicas N` gateway processes on consecutive
 * ports sharing them. The CLI cannot reach a Postgres store, so setup goes
 * through the admin API — the path an operator of a cluster uses too. Load is
 * split evenly across replicas, one `oha` per replica, and merged.
 *
 *   bun scripts/bench-gateway.ts --gateway … --cli … --cluster --replicas 2 \
 *     --database-url postgres://postgres:omni@127.0.0.1:55432/omni_bench_x \
 *     --redis-url redis://127.0.0.1:56379 --gateway-cpus 0-1,2-3
 *
 * `--containers omni-bench-pg,omni-bench-redis` adds the CPU those docker
 * containers spend during each scenario, read from their cgroups.
 *
 * With `--cluster`, `--gateway-cpus` takes one cpu list per replica separated
 * by commas between groups (`0-1,2-3`). The database is migrated by the gateway
 * and must be empty; the run refuses any name not starting `omni_bench_`.
 *
 * Needs `oha` and `taskset` on PATH and Linux `/proc`. Upstream is
 * `bench-gateway-upstream.ts`, a scripted chat-completions SSE server reached
 * through a `custom` credential, so no provider is ever called.
 */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { processEnvironment } from "./bench-environment";
import {
  type MatrixMeta,
  matches,
  matrixScenarios,
  matrixSmoke,
  allProviders as providers,
  type Verdict,
} from "./bench-matrix";
import { seedOAuth } from "./bench-oauth";
import { readOhaReport } from "./bench-oha-report";
import {
  setupViaApi as apiSetup,
  RECOVERY_LATENESS_MS,
  type RecoverySample,
  recoveryVerdict,
  sampleRecovery,
  smoke as smokeRequests,
} from "./bench-probe";
import { showPerformance } from "./bench-report";

const { values: flags } = parseArgs({
  options: {
    gateway: { type: "string" },
    cli: { type: "string" },
    out: { type: "string" },
    duration: { type: "string", default: "20s" },
    warmup: { type: "string", default: "3s" },
    "gateway-cpus": { type: "string", default: "0-3" },
    "upstream-cpus": { type: "string", default: "4-5" },
    "load-cpus": { type: "string", default: "6-7" },
    streams: { type: "string", default: "1000" },
    boots: { type: "string", default: "5" },
    only: { type: "string" },
    matrix: { type: "boolean", default: false },
    "fresh-process": { type: "boolean", default: false },
    label: { type: "string" },
    cluster: { type: "boolean", default: false },
    replicas: { type: "string", default: "1" },
    "database-url": { type: "string" },
    "redis-url": { type: "string" },
    containers: { type: "string" },
    "request-timeout": { type: "string", default: "30s" },
    rate: { type: "string" },
  },
});

if (flags.gateway === undefined || flags.cli === undefined) {
  console.error("usage: bench-gateway.ts --gateway <argv> --cli <argv> [--out file.json]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "..");
/**
 * The gateway is spawned with its cwd in the bench root, so a relative
 * program path is resolved against the repo root here, once; a bare name
 * (no slash) is left for PATH lookup.
 */
const GATEWAY_ARGV = flags.gateway
  .split(/\s+/)
  .filter(Boolean)
  .map((arg, i) => (i === 0 && arg.includes("/") ? resolve(REPO, arg) : arg));
const CLI_ARGV = flags.cli.split(/\s+/).filter(Boolean);
const ENCRYPTION_KEY = "bench-only-encryption-key-0123456789";
const GATEWAY_PORT = 18200;
const UPSTREAM_PORT = 18100;
const CLUSTER = flags.cluster === true;
if (flags.matrix && CLUSTER) throw Error("matrix cluster setup is not implemented");
if (flags.matrix && !matrixScenarios().some((s) => matches(s.name, flags.only)))
  throw Error("--only matched no matrix scenarios");
const REPLICAS = CLUSTER ? Number(flags.replicas) : 1;
const ADMIN_PASSWORD = "bench-admin-password";
const PORTS = Array.from({ length: REPLICAS }, (_, i) => GATEWAY_PORT + i);
const BASES = PORTS.map((port) => `http://127.0.0.1:${port}`);
const BASE = BASES[0] as string;

/**
 * One cpu list per replica. Single mode takes the whole flag as one list; in
 * cluster mode a top-level comma separates replicas, so `0-1,2-3` is two
 * replicas of two cores each and `0-3` alone is shared by all of them.
 */
const CPU_SETS: string[] = (() => {
  const raw = flags["gateway-cpus"] ?? "0-3";
  if (!CLUSTER) return [raw];
  const groups = raw.split(",");
  return PORTS.map((_, i) => groups[i % groups.length] as string);
})();

if (CLUSTER) {
  const url = flags["database-url"];
  if (url === undefined || flags["redis-url"] === undefined) {
    console.error("--cluster needs --database-url and --redis-url");
    process.exit(2);
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.startsWith("omni_bench_")) {
    console.error(`refusing database "${name}": cluster runs need a database named omni_bench_*`);
    process.exit(2);
  }
  if (!Number.isInteger(REPLICAS) || REPLICAS < 1 || REPLICAS > 8) {
    console.error("--replicas must be 1-8");
    process.exit(2);
  }
}
const CLK_TCK = 100;
const PAGE_KB = 4;

const root = mkdtempSync("/tmp/opencode/omni-bench-");
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: ENCRYPTION_KEY,
  OMNI_DB_PATH: join(root, "omni.db"),
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: String(GATEWAY_PORT),
  OMNI_ROOT: root,
  // No dashboard: static serving is not what is being measured, and an absent
  // directory is a supported, logged configuration.
  OMNI_STATIC_DIR: join(root, "no-dashboard"),
  OMNI_LOG_LEVEL: "warn",
  // The Rust gateway's writer barrier (`POST /__omni/bench/flush`); off
  // without it, and unknown to TS.
  OMNI_BENCH: "1",
  ...(CLUSTER
    ? {
        OMNI_CLUSTER_MODE: "true",
        OMNI_DATABASE_URL: flags["database-url"],
        OMNI_REDIS_URL: flags["redis-url"],
      }
    : {}),
};

const children: Subprocess[] = [];
function cleanup(): void {
  for (const child of children) child.kill("SIGKILL");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ---------------------------------------------------------------- utilities

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cli(args: string[], stdin?: string): Promise<unknown> {
  const proc = Bun.spawn([...CLI_ARGV, "--root", root, "--json", ...args], {
    cwd: REPO,
    env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`omni ${args.join(" ")} failed (${code}): ${err}`);
  return JSON.parse(out);
}

/** utime+stime in seconds and resident set in KiB, read from /proc. */
function procSample(pid: number): { cpuS: number; rssKb: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // A dead child not yet reaped still has a /proc entry; it is not a gateway.
    if (fields[0] === "Z" || fields[0] === "X") return null;
    const cpuS = (Number(fields[11]) + Number(fields[12])) / CLK_TCK;
    const statm = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
    return { cpuS, rssKb: Number(statm[1]) * PAGE_KB };
  } catch {
    return null;
  }
}

/**
 * CPU seconds a docker container has used, from its cgroup. Cluster mode reads
 * Postgres and Redis this way, because their cost is the gateway's cost too: a
 * replica that answers fast by hammering the database is not cheap.
 */
function containerCpuS(name: string): number | null {
  const id = Bun.spawnSync(["docker", "inspect", "-f", "{{.Id}}", name]).stdout.toString().trim();
  if (id.length === 0) return null;
  for (const dir of [
    `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
    `/sys/fs/cgroup/docker/${id}`,
  ]) {
    try {
      const line = readFileSync(`${dir}/cpu.stat`, "utf8").split("\n")[0] ?? "";
      return Number(line.split(" ")[1]) / 1e6;
    } catch {
      // try the next layout
    }
  }
  return null;
}

const BACKING = (flags.containers ?? "").split(",").filter(Boolean);

function backingCpuS(): number | null {
  if (BACKING.length === 0) return null;
  let total = 0;
  for (const name of BACKING) {
    const s = containerCpuS(name);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** Summed over every replica: a fleet's cost is all of its processes. */
function fleetSample(pids: number[]): { cpuS: number; rssKb: number } | null {
  let cpuS = 0;
  let rssKb = 0;
  for (const pid of pids) {
    const s = procSample(pid);
    if (s === null) return null;
    cpuS += s.cpuS;
    rssKb += s.rssKb;
  }
  return { cpuS, rssKb };
}

/** Expands a taskset cpu list (`0-3,6`) into cpu numbers. */
function cpuList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map(Number) as [number, number | undefined];
    for (let c = a; c <= (b ?? a); c += 1) out.push(c);
  }
  return out;
}

/** Busy and total jiffies per cpu, from /proc/stat. */
function cpuTimes(): Map<number, { busy: number; total: number }> {
  const out = new Map<number, { busy: number; total: number }>();
  for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
    const m = /^cpu(\d+) (.*)$/.exec(line);
    if (m === null) continue;
    const [user, nice, system, idle, iowait, irq, softirq, steal] = (m[2] as string)
      .trim()
      .split(/\s+/)
      .map(Number) as number[];
    const busy = (user ?? 0) + (nice ?? 0) + (system ?? 0) + (irq ?? 0) + (softirq ?? 0);
    out.set(Number(m[1]), {
      busy,
      total: busy + (idle ?? 0) + (iowait ?? 0) + (steal ?? 0),
    });
  }
  return out;
}

/** The current `cpu MHz` of each cpu, as the guest kernel reports it. */
function cpuMhz(): number[] {
  return [...readFileSync("/proc/cpuinfo", "utf8").matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) =>
    Number(m[1]),
  );
}

/**
 * A fixed, CPU-bound loop (an LCG, no memory traffic) in a child pinned to one
 * cpu; returns the loop's wall time in ms, measured inside the child so its
 * startup does not count. Equal hardware gives equal numbers, so a slower
 * vCPU (an E-core under it, a lower clock, a host thread sharing its core)
 * shows up as a larger one.
 */
const SPIN =
  "let a = 1; const t = performance.now(); " +
  "for (let i = 0; i < 100_000_000; i += 1) a = (a * 1103515245 + 12345) | 0; " +
  "console.log(JSON.stringify({ ms: performance.now() - t, a }));";

async function spin(cpu: number): Promise<number> {
  const proc = Bun.spawn(["taskset", "-c", String(cpu), process.execPath, "-e", SPIN], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return (JSON.parse(out) as { ms: number }).ms;
}

type Calibration = {
  /** Per cpu, the spin loop alone on the host's otherwise idle bench cpus. */
  alone: Record<string, number>;
  /** Per cpu, the same loop with one copy on every cpu at once. */
  together: Record<string, number>;
  /** `cpu MHz` per cpu, sampled while every cpu spins. */
  mhzUnderLoad: number[];
  /** Busy cores outside the bench in the second before calibration. */
  foreignCoresBefore: number;
};

/**
 * Times the spin loop on every cpu, first one at a time, then all at once (a
 * vCPU whose physical core is shared or slower falls behind there). Two
 * passes of each; the faster is kept, so a one-off hiccup does not count.
 */
async function calibrate(): Promise<Calibration> {
  const all = cpus().map((_, i) => i);
  const before = cpuTimes();
  await sleep(1000);
  const foreignCoresBefore = busyCores(before, cpuTimes());
  const alone: Record<string, number> = {};
  const together: Record<string, number> = {};
  let mhzUnderLoad: number[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const c of all) {
      alone[c] = Math.min(alone[c] ?? Number.POSITIVE_INFINITY, await spin(c));
    }
    const runs = all.map((c) => spin(c));
    await sleep(150);
    mhzUnderLoad = cpuMhz();
    const done = await Promise.all(runs);
    done.forEach((ms, c) => {
      together[c] = Math.min(together[c] ?? Number.POSITIVE_INFINITY, ms);
    });
  }
  const round = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]));
  return {
    alone: round(alone),
    together: round(together),
    mhzUnderLoad,
    foreignCoresBefore: Math.round(foreignCoresBefore * 100) / 100,
  };
}

/** Busy cores across the whole host between two `cpuTimes` samples. */
function busyCores(
  a: Map<number, { busy: number; total: number }>,
  b: Map<number, { busy: number; total: number }>,
): number {
  let busy = 0;
  let total = 0;
  for (const [c, s] of b) {
    const p = a.get(c);
    if (p === undefined) continue;
    busy += s.busy - p.busy;
    total += s.total - p.total;
  }
  return total === 0 ? 0 : (busy / total) * b.size;
}

type ThreadTime = { name: string; cpuS: number; waitS: number };

/**
 * Per thread of `pid`: its name, CPU seconds, and seconds spent runnable but
 * waiting for a cpu (`schedstat`), which is what a thread starved of cores
 * shows and a thread blocked on I/O does not.
 */
function threadTimes(pid: number): Map<string, ThreadTime> {
  const out = new Map<string, ThreadTime>();
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
        const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const sched = readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ");
        out.set(tid, {
          name,
          cpuS: (Number(f[11]) + Number(f[12])) / CLK_TCK,
          waitS: Number(sched[1]) / 1e9,
        });
      } catch {
        // thread ended
      }
    }
  } catch {
    // process ended
  }
  return out;
}

/**
 * Per thread between two `threadTimes` samples `secs` apart, keyed `name` (or
 * `name#2`, `#3`… for threads sharing a name), busiest first: `cpu` is CPU%
 * and `runqueue` the % of the window it was runnable but not running. Threads
 * under 1% CPU are left out.
 */
function threadShare(
  a: Map<string, ThreadTime>,
  b: Map<string, ThreadTime>,
  secs: number,
): Record<string, { cpu: number; runqueue: number }> {
  const rows = [...b]
    .map(([tid, t]) => {
      const p = a.get(tid);
      return {
        name: t.name,
        cpu: ((t.cpuS - (p?.cpuS ?? 0)) / secs) * 100,
        runqueue: ((t.waitS - (p?.waitS ?? 0)) / secs) * 100,
      };
    })
    .filter((r) => r.cpu >= 1)
    .sort((x, y) => y.cpu - x.cpu);
  const seen = new Map<string, number>();
  const out: Record<string, { cpu: number; runqueue: number }> = {};
  for (const r of rows) {
    const n = (seen.get(r.name) ?? 0) + 1;
    seen.set(r.name, n);
    out[n === 1 ? r.name : `${r.name}#${n}`] = {
      cpu: Math.round(r.cpu),
      runqueue: Math.round(r.runqueue),
    };
  }
  return out;
}

/** utime+stime of the upstream processes, in seconds. */
function upstreamCpuS(): number {
  let total = 0;
  for (const pid of upstreamPids) total += procSample(pid)?.cpuS ?? 0;
  return total;
}

async function waitHealthy(timeoutMs: number, base = BASE): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now()))),
        ),
      });
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(5);
  }
  return false;
}

function startGateway(replica = 0): Subprocess {
  const proc = Bun.spawn(["taskset", "-c", CPU_SETS[replica] as string, ...GATEWAY_ARGV], {
    cwd: root,
    env: { ...env, OMNI_PORT: String(PORTS[replica]) },
    stdout: Bun.file(join(root, `gateway-${replica}.log`)),
    stderr: Bun.file(join(root, `gateway-${replica}.err`)),
  });
  children.push(proc);
  return proc;
}

/** `taskset` execs, so the spawned pid is the gateway itself. */
async function stopGateway(proc: Subprocess): Promise<number> {
  const started = performance.now();
  proc.kill("SIGTERM");
  const timeout = sleep(15_000).then(() => "timeout" as const);
  const result = await Promise.race([proc.exited, timeout]);
  if (result === "timeout") proc.kill("SIGKILL");
  return performance.now() - started;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

// ---------------------------------------------------------------- fixtures

function chatBody(model: string): string {
  return JSON.stringify({
    model,
    stream: true,
    messages: [{ role: "user", content: "Say something short." }],
  });
}

function anthropicBody(model: string, stream: boolean): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    stream,
    messages: [{ role: "user", content: "Say something short." }],
  });
}

function responsesBody(model: string): string {
  return JSON.stringify({ model, stream: true, input: "Say something short." });
}

/**
 * The shape a coding agent actually sends: a long system prompt, a dozen tool
 * schemas and a transcript of tool calls and results. About 100 KiB, which is
 * an unremarkable mid-session Claude Code request.
 */
function agentBody(model: string): string {
  const filler = (n: number, seed: string): string =>
    Array.from({ length: n }, (_, i) => `${seed} line ${i}: const value${i} = compute(${i});`).join(
      "\n",
    );
  const tools = Array.from({ length: 16 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i}. ${filler(4, "doc")}`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path." },
        offset: { type: "integer" },
        limit: { type: "integer" },
        pattern: { type: "string" },
      },
      required: ["path"],
    },
  }));
  const messages: unknown[] = [{ role: "user", content: "Refactor the parser module." }];
  for (let turn = 0; turn < 20; turn += 1) {
    const id = `toolu_bench_${turn}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Reading file ${turn}.` },
        { type: "tool_use", id, name: `tool_${turn % 16}`, input: { path: `/src/file${turn}.ts` } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: filler(40, `file${turn}`) }],
    });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "Now apply the change." }] });
  return JSON.stringify({
    model,
    max_tokens: 4096,
    stream: true,
    system: filler(120, "system"),
    tools,
    messages,
  });
}

// ---------------------------------------------------------------- scenarios

type Scenario = {
  smokeBytes?: number;
  name: string;
  what: string;
  path: string;
  body: string;
  key: "plain" | "limited";
  concurrency: number;
  /** Fixed request count instead of a duration (held-stream scenarios). */
  requests?: number;
  /** Per-request client timeout, to exercise client disconnects. */
  clientTimeout?: string;
  warmup?: boolean;
};

type OhaJson = {
  summary: {
    successRate: number;
    requestsPerSec: number;
    total: number;
    sizePerRequest: number | null;
  };
  latencyPercentiles: Record<string, number | null>;
  firstBytePercentiles?: Record<string, number | null>;
  statusCodeDistribution: Record<string, number>;
  errorDistribution: Record<string, number>;
};

type ScenarioResult = {
  cpuMsPerRequestDrained?: number | null;
  integrity?: { errors: string[]; verifier: unknown; sizes?: unknown };
  name: string;
  what: string;
  concurrency: number;
  requests: number;
  successRate: number;
  rps: number;
  latencyMs: { p50: number; p90: number; p99: number; p999: number; p9999: number };
  ttfbMs: { p50: number; p99: number } | null;
  status: Record<string, number>;
  errors: Record<string, number>;
  cpuSeconds: number;
  cpuMsPerRequest: number;
  /** Postgres + Redis CPU per request, when `--containers` names them. */
  backingCpuMsPerRequest: number | null;
  rssStartMb: number;
  rssPeakMb: number;
  rssEndMb: number;
  /** Actual cancellation recovery observations; elapsed times include scheduler lag. */
  recoverySamples: RecoverySample[];
  recoveryVerdict: "pass" | "miss" | "inconclusive" | null;
  recoveryLatenessToleranceMs: number;
  healthyAfter: boolean;
  /** Replicas whose process was gone after the scenario. Each is restarted. */
  crashed: number;
  /**
   * The request log against what the clients saw, for this scenario's
   * measured window (single mode; `null` in cluster mode). `missing` is
   * answered requests with no `done` row; `pending` is rows never finished.
   * Either above zero means the gateway shed log rows.
   */
  rows: RowCheck | null;
  /** Busy cores spent by processes outside the bench during the scenario. */
  foreignCores: number;
  /** Epoch ms the scenario (its warmup) started. */
  windowFrom: number;
  /** `cpu MHz` of each gateway cpu, sampled mid-scenario. */
  gatewayMhz: number[];
  /**
   * CPU% per gateway thread name over a 5 s window mid-scenario (single
   * mode): where the gateway's cores go, e.g. request workers against the
   * writer's blocking thread.
   */
  threads: Record<string, { cpu: number; runqueue: number }> | null;
  perReplica?: { rps: number; p50: number; p99: number }[];
};

/**
 * What the request log holds for one scenario's window. Scenarios run one at a
 * time with idle gaps, and a row's `at` is when its request started, so the
 * rows with `at` from the warmup's start to the settle's end are exactly the
 * scenario's: its warmup's and its measured run's, against both their
 * answered counts.
 */
type RowCheck = {
  /** Requests the clients got any HTTP status for: each must have a row. */
  answered: number;
  done: number;
  pending: number;
  /** `answered - done`, floored at 0. */
  missing: number;
  /**
   * The writer's counters over this scenario, from the flush barrier at its
   * start and end: exact, whenever the drops happened in it. The cancel
   * scenarios' 499 rows can hide a missing row from `missing`; this cannot.
   * `"unsupported"`: the gateway has no barrier (TS). `"inconclusive"`: a
   * barrier did not answer in time.
   */
  writer: WriterDelta | "unsupported" | "inconclusive";
};

/** `POST /__omni/bench/flush`'s answer: the prefix of events up to `watermark`. */
type WriterCounts = { watermark: number; committed: number; failed: number; dropped: number };
/** One scenario's events: `events == committed + failed + dropped`. */
type WriterDelta = { events: number; committed: number; failed: number; dropped: number };

const BARRIER_TIMEOUT_MS = 60_000;

/**
 * Every replica's writer barrier, summed. `"unsupported"` if a gateway 404s
 * it, `"inconclusive"` if one does not answer within the timeout (or errs).
 */
async function writerBarrier(): Promise<WriterCounts | "unsupported" | "inconclusive"> {
  const total: WriterCounts = { watermark: 0, committed: 0, failed: 0, dropped: 0 };
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/__omni/bench/flush`, {
        method: "POST",
        signal: AbortSignal.timeout(BARRIER_TIMEOUT_MS),
      });
      if (res.status === 404) {
        await res.body?.cancel();
        return "unsupported";
      }
      if (!res.ok) {
        await res.body?.cancel();
        return "inconclusive";
      }
      const c = (await res.json()) as WriterCounts;
      // The gateway promises an exact prefix; anything else is not evidence.
      if (c.committed + c.failed + c.dropped !== c.watermark) return "inconclusive";
      total.watermark += c.watermark;
      total.committed += c.committed;
      total.failed += c.failed;
      total.dropped += c.dropped;
    } catch {
      return "inconclusive";
    }
  }
  return total;
}

function writerDelta(
  a: Awaited<ReturnType<typeof writerBarrier>>,
  b: Awaited<ReturnType<typeof writerBarrier>>,
): WriterDelta | "unsupported" | "inconclusive" {
  if (a === "inconclusive" || b === "inconclusive") return "inconclusive";
  if (a === "unsupported" || b === "unsupported") return "unsupported";
  return {
    events: b.watermark - a.watermark,
    committed: b.committed - a.committed,
    failed: b.failed - a.failed,
    dropped: b.dropped - a.dropped,
  };
}

function scenarios(): Scenario[] {
  const long = Number(flags.streams);
  return [
    {
      name: "overhead-c1",
      what: "chat SSE, 1 chunk, one client: pure per-request overhead",
      path: "/v1/chat/completions",
      body: chatBody("bench-c1"),
      key: "plain",
      concurrency: 1,
    },
    {
      name: "chat-stream",
      what: "chat SSE, 1 chunk, 64 clients: throughput",
      path: "/v1/chat/completions",
      body: chatBody("bench-c1"),
      key: "plain",
      concurrency: 64,
    },
    {
      name: "anthropic-json",
      what: "Anthropic non-streaming, translated from chat SSE, 64 clients",
      path: "/v1/messages",
      body: anthropicBody("bench-c1", false),
      key: "plain",
      concurrency: 64,
    },
    {
      name: "responses-stream",
      what: "Responses SSE, translated from chat SSE, 64 clients",
      path: "/v1/responses",
      body: responsesBody("bench-c1"),
      key: "plain",
      concurrency: 64,
    },
    {
      name: "agent-100k",
      what: "Anthropic SSE with a ~100 KiB agent transcript, 32 clients",
      path: "/v1/messages",
      body: agentBody("bench-c1"),
      key: "plain",
      concurrency: 32,
    },
    {
      name: "many-chunks",
      what: "Anthropic SSE, 2000 upstream chunks per reply, 16 clients",
      path: "/v1/messages",
      body: anthropicBody("bench-c2000", true),
      key: "plain",
      concurrency: 16,
    },
    {
      name: "rate-limited-key",
      what: "chat SSE, 1 chunk, 64 clients, key with request/token/concurrency limits",
      path: "/v1/chat/completions",
      body: chatBody("bench-c1"),
      key: "limited",
      concurrency: 64,
    },
    {
      name: "held-streams",
      what: `${long} concurrent streams, 60 chunks 500 ms apart (~30 s each)`,
      path: "/v1/messages",
      body: anthropicBody("bench-long", true),
      key: "plain",
      concurrency: long,
      requests: long,
      warmup: false,
    },
    {
      name: "client-cancel",
      what: "200 clients abandoning 30 s streams after 2 s",
      path: "/v1/messages",
      body: anthropicBody("bench-long", true),
      key: "plain",
      concurrency: 200,
      clientTimeout: "2s",
      warmup: false,
    },
    {
      // Clients that give up before the upstream has answered. This is the
      // shape that killed cluster-mode replicas in the first baseline run: an
      // abort racing the attempt left a rejected promise nobody awaited.
      name: "early-cancel",
      what: "64 clients abandoning 1-chunk requests after 1 ms",
      path: "/v1/chat/completions",
      body: chatBody("bench-c1"),
      key: "plain",
      concurrency: 64,
      clientTimeout: "1ms",
      warmup: false,
    },
  ];
}

async function oha(
  scenario: Scenario,
  key: string,
  duration: string | null,
  base = BASE,
  concurrency = scenario.concurrency,
): Promise<OhaJson> {
  const bodyFile = join(root, `${scenario.name}.json`);
  writeFileSync(bodyFile, scenario.body);
  const args = [
    "taskset",
    "-c",
    flags["load-cpus"] ?? "6-7",
    "oha",
    "--no-tui",
    "--output-format",
    "json",
    "-m",
    "POST",
    "-T",
    "application/json",
    "-H",
    `authorization: Bearer ${key}`,
    "-H",
    "anthropic-version: 2023-06-01",
    "-D",
    bodyFile,
    "-c",
    String(concurrency),
  ];
  if (scenario.requests !== undefined && duration !== null)
    args.push("-n", String(Math.round((scenario.requests * concurrency) / scenario.concurrency)));
  else {
    args.push("-z", duration ?? "3s");
    // Let in-flight requests finish at the deadline. Without this, oha aborts
    // every open request when the clock runs out, which turns each scenario
    // into a disconnect test as well — `client-cancel` is the one that is.
    if (scenario.clientTimeout === undefined) args.push("-w");
    if (flags.rate !== undefined)
      args.push("-q", String(Math.max(1, Math.round(Number(flags.rate) / BASES.length))));
  }
  // A scenario with no timeout of its own gets the per-request one, so one
  // wedged connection is a counted error instead of an `oha -w` that never
  // returns. Held streams (~30 s by design) and the cancel shapes keep theirs.
  const timeout =
    scenario.clientTimeout ??
    (scenario.requests === undefined ? flags["request-timeout"] : undefined);
  if (timeout !== undefined) args.push("-t", timeout);
  args.push(`${base}${scenario.path}`);
  if (flags.matrix) {
    const file = join(root, `${scenario.name}.oha.db`);
    rmSync(file, { force: true });
    args.push("--db-url", file);
    const reportFile = join(root, `${scenario.name}.oha.json`);
    rmSync(reportFile, { force: true });
    args.push("--output", reportFile);
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  if (flags.matrix) {
    const report = readOhaReport<OhaJson>(
      join(root, `${scenario.name}.oha.json`),
      proc.exited,
      (r) => {
        ohaCpuS += procSample(proc.pid)?.cpuS ?? 0;
        matrixLoadEnd?.(r);
      },
    );
    const [result, err, code] = await Promise.all([
      report,
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw Error(`oha failed: ${err}`);
    return result;
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const used = proc.resourceUsage()?.cpuTime.total;
  if (used !== undefined) ohaCpuS += Number(used) / 1e6;
  if (code !== 0) throw new Error(`oha failed for ${scenario.name}: ${err}`);
  return JSON.parse(out) as OhaJson;
}

const ms = (v: number | null | undefined): number => (v == null ? Number.NaN : v * 1000);

/** CPU seconds every finished `oha` used, for telling the bench's own load from the host's. */
let ohaCpuS = 0;
let matrixLoadEnd: ((report: OhaJson) => void) | undefined;
/** The upstream processes, whose CPU is the bench's own too. */
const upstreamPids: number[] = [];

/** Requests the clients got an HTTP status for. */
const answered = (r: OhaJson): number =>
  Object.values(r.statusCodeDistribution).reduce((a, b) => a + b, 0);

/**
 * The request log for `[from, to]` (epoch ms, the rows' `at`): `done` and
 * `pending` rows. Read-only, on its own connection, so the gateway's writer
 * is not held up. `null` where there is no SQLite file (cluster mode).
 */
function logRows(from: number, to: number): { done: number; pending: number } | null {
  const path = env.OMNI_DB_PATH;
  if (CLUSTER || path === undefined || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db
      .query<{ done: number | null; pending: number | null }, [number, number]>(
        "SELECT SUM(state = 'done') AS done, SUM(state = 'pending') AS pending " +
          "FROM request_logs WHERE at BETWEEN ? AND ?",
      )
      .get(from, to);
    return { done: row?.done ?? 0, pending: row?.pending ?? 0 };
  } finally {
    db.close();
  }
}

/**
 * One `oha` per replica, concurrency split evenly, merged.
 *
 * Counts and rates add. Percentiles cannot be merged exactly from summaries,
 * so the merged value is the request-weighted mean of each replica's — honest
 * for p50 when the replicas are alike, and the per-replica tails are kept
 * beside it so a skewed replica is visible rather than averaged away.
 */
async function ohaFleet(
  scenario: Scenario,
  key: string,
  duration: string | null,
): Promise<{ merged: OhaJson; perReplica: OhaJson[] }> {
  const share = Math.max(1, Math.floor(scenario.concurrency / BASES.length));
  const reports = await Promise.all(BASES.map((base) => oha(scenario, key, duration, base, share)));
  if (reports.length === 1) return { merged: reports[0] as OhaJson, perReplica: reports };
  const count = (r: OhaJson): number =>
    Object.values(r.statusCodeDistribution).reduce((a, b) => a + b, 0);
  const total = reports.reduce((a, r) => a + count(r), 0) || 1;
  const blend = (pick: (r: OhaJson) => Record<string, number | null> | undefined) => {
    const out: Record<string, number | null> = {};
    for (const p of ["p50", "p90", "p99", "p99.9", "p99.99"]) {
      let acc = 0;
      let weight = 0;
      for (const r of reports) {
        const v = pick(r)?.[p];
        if (v == null) continue;
        acc += v * count(r);
        weight += count(r);
      }
      out[p] = weight === 0 ? null : acc / weight;
    }
    return out;
  };
  const sum = (pick: (r: OhaJson) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const r of reports)
      for (const [k, v] of Object.entries(pick(r))) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const merged: OhaJson = {
    summary: {
      successRate: reports.reduce((a, r) => a + r.summary.successRate * count(r), 0) / total,
      requestsPerSec: reports.reduce((a, r) => a + r.summary.requestsPerSec, 0),
      total: Math.max(...reports.map((r) => r.summary.total)),
      sizePerRequest: null,
    },
    latencyPercentiles: blend((r) => r.latencyPercentiles),
    firstBytePercentiles: blend((r) => r.firstBytePercentiles),
    statusCodeDistribution: sum((r) => r.statusCodeDistribution),
    errorDistribution: sum((r) => r.errorDistribution),
  };
  return { merged, perReplica: reports };
}

async function runScenario(
  scenario: Scenario,
  pids: number[],
  keys: Record<Scenario["key"], string>,
): Promise<ScenarioResult> {
  const key = keys[scenario.key];
  // Scenarios run one after another with idle gaps, so the rows whose `at`
  // falls between the warmup's start and the settle's end are this one's.
  // Everything before this scenario committed, and the counters to diff from.
  const barrierBefore = await writerBarrier();
  const windowFrom = Date.now();
  let warmAnswered = 0;
  if (scenario.warmup !== false)
    warmAnswered = answered((await ohaFleet(scenario, key, flags.warmup ?? "3s")).merged);
  await sleep(500);

  const measuredFrom = Date.now();
  const refreshCount = () => {
    try {
      return readFileSync(join(root, "refresh.log"), "utf8").length;
    } catch {
      return 0;
    }
  };
  const refreshBefore = flags.matrix ? refreshCount() : 0;
  let verifier: Subprocess | undefined;
  if (flags.matrix) {
    const verifyKey = (await cli(["keys", "create", "--label", `verify-${scenario.name}`])) as {
      key: string;
    };
    const file = join(root, "verify.json");
    writeFileSync(file, JSON.stringify({ base: BASE, key: verifyKey.key, scenario }));
    verifier = Bun.spawn(
      [
        "taskset",
        "-c",
        flags["load-cpus"] ?? "6-7",
        process.execPath,
        join(import.meta.dir, "bench-verify-client.ts"),
        file,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    children.push(verifier);
  }

  const before = fleetSample(pids);
  const backingBefore = backingCpuS();
  const hostBefore = cpuTimes();
  const ownBefore =
    ohaCpuS + process.cpuUsage().user / 1e6 + process.cpuUsage().system / 1e6 + upstreamCpuS();
  let peak = before?.rssKb ?? 0;
  let sampling = true;
  let gatewayMhz: number[] = [];
  let threads: Record<string, { cpu: number; runqueue: number }> | null = null;
  let threadsFrom: Map<string, ThreadTime> | null = null;
  let threadsAt = 0;
  const started = performance.now();
  let boundary:
    | {
        at: number;
        epoch: number;
        sample: ReturnType<typeof fleetSample>;
        host: ReturnType<typeof cpuTimes>;
        own: number;
        reportedSeconds: number;
      }
    | undefined;
  let drain:
    | Promise<{ sample: ReturnType<typeof fleetSample>; at: number; complete: boolean }>
    | undefined;
  if (flags.matrix)
    matrixLoadEnd = (r) => {
      boundary = {
        at: performance.now(),
        epoch: Date.now(),
        sample: fleetSample(pids),
        host: cpuTimes(),
        own:
          ohaCpuS +
          process.cpuUsage().user / 1e6 +
          process.cpuUsage().system / 1e6 +
          upstreamCpuS(),
        reportedSeconds: r.summary.total,
      };
      sampling = false;
      verifier?.kill("SIGTERM");
      drain = (async () => {
        const until = performance.now() + 30000;
        const db = new Database(env.OMNI_DB_PATH, { readonly: true });
        try {
          for (;;) {
            const row = db
              .query(
                "SELECT count(*) n,sum(state='done') done FROM request_logs WHERE at BETWEEN ? AND ? AND api_key_id IN (SELECT id FROM api_keys WHERE label='bench plain')",
              )
              .get(measuredFrom, boundary?.epoch ?? Date.now()) as { n: number; done: number };
            if (row.n === answered(r) && row.done === row.n)
              return { sample: fleetSample(pids), at: performance.now(), complete: true };
            if (performance.now() > until)
              return { sample: fleetSample(pids), at: performance.now(), complete: false };
            await sleep(10);
          }
        } finally {
          db.close();
        }
      })();
    };
  const sampler = (async () => {
    while (sampling) {
      const s = fleetSample(pids);
      if (s !== null && s.rssKb > peak) peak = s.rssKb;
      // Mid-scenario, once: the clock each gateway cpu runs at under load.
      if (gatewayMhz.length === 0 && performance.now() - started > 5000) {
        const mhz = cpuMhz();
        gatewayMhz = CPU_SETS.flatMap(cpuList).map((c) => mhz[c] ?? Number.NaN);
        if (!CLUSTER) {
          threadsFrom = threadTimes(pids[0] as number);
          threadsAt = performance.now();
        }
      }
      if (threadsFrom !== null && threads === null && performance.now() - threadsAt > 5000) {
        const secs = (performance.now() - threadsAt) / 1000;
        threads = threadShare(threadsFrom, threadTimes(pids[0] as number), secs);
      }
      await sleep(100);
    }
  })();

  const { merged: report, perReplica } = await ohaFleet(scenario, key, flags.duration ?? "20s");
  const loadProcessReturnedAt = performance.now();
  matrixLoadEnd = undefined;
  const measuredTo = boundary?.epoch ?? Date.now();
  const drained = await drain;
  let verification: { requests: number; errors: string[]; rate: number } = {
    requests: 0,
    errors: [],
    rate: 4,
  };
  if (verifier) {
    verifier.kill("SIGTERM");
    verification = JSON.parse(await new Response(verifier.stdout as ReadableStream).text());
    await verifier.exited;
  }
  const recoveryStart = performance.now();
  sampling = false;
  await sampler;
  const after = boundary?.sample ?? fleetSample(pids);
  const backingAfter = backingCpuS();
  const hostAfter = boundary?.host ?? cpuTimes();
  const ownAfter =
    ohaCpuS + process.cpuUsage().user / 1e6 + process.cpuUsage().system / 1e6 + upstreamCpuS();
  const windowS = ((boundary?.at ?? performance.now()) - started) / 1000;
  const gatewayCpuS = (after?.cpuS ?? 0) - (before?.cpuS ?? 0);
  const foreignCores = Math.max(
    0,
    busyCores(hostBefore, hostAfter) -
      (gatewayCpuS + ((boundary?.own ?? ownAfter) - ownBefore)) / windowS,
  );
  // Settle before the next scenario, then confirm the process still answers:
  // a scenario that leaves the gateway wedged is a result, not a crash. The
  // settle also lets the writer flush the scenario's last batch (≤ 200 ms).
  let recoverySamples: RecoverySample[] = [];
  if (scenario.clientTimeout !== undefined) {
    recoverySamples = await sampleRecovery(
      recoveryStart,
      () => performance.now(),
      sleep,
      () => {
        const sample = fleetSample(pids);
        return sample === null ? null : sample.rssKb / 1024;
      },
    );
  } else {
    await sleep(1000);
  }
  const settled = fleetSample(pids);
  // The barrier: every row this scenario's requests filed is committed when
  // it answers (the writer may have queued them through a disk stall), and
  // its counters give the scenario's drops exactly.
  const barrierAfter = await writerBarrier();
  const writer = writerDelta(barrierBefore, barrierAfter);
  const log = logRows(windowFrom, Date.now());
  const rowsAnswered = warmAnswered + answered(report);
  const rows: RowCheck | null =
    log === null
      ? null
      : {
          answered: rowsAnswered,
          done: log.done,
          pending: log.pending,
          missing: Math.max(0, rowsAnswered - log.done),
          writer,
        };
  const crashed = pids.filter((pid) => procSample(pid) === null).length;
  const healthyAfter =
    crashed === 0 &&
    (await Promise.all(BASES.map((base) => waitHealthy(5000, base)))).every(Boolean);

  const requests =
    Object.values(report.statusCodeDistribution).reduce((a, b) => a + b, 0) +
    Object.values(report.errorDistribution).reduce((a, b) => a + b, 0);
  const cpuSeconds = (after?.cpuS ?? 0) - (before?.cpuS ?? 0);
  const lp = report.latencyPercentiles;
  const integrityErrors: string[] = [];
  if (flags.matrix && !drained?.complete) integrityErrors.push("common row drain incomplete");
  if (flags.matrix && refreshCount() !== refreshBefore)
    integrityErrors.push("OAuth refresh during measurement");
  if (flags.matrix && (!boundary || Math.abs(windowS - boundary.reportedSeconds) > 0.25))
    integrityErrors.push("load report boundary differs from oha duration by more than 250ms");
  let sizeEvidence: unknown;
  if (flags.matrix) {
    integrityErrors.push(...verification.errors);
    if (!verification.requests) integrityErrors.push("no verifier requests");
    const db = new Database(env.OMNI_DB_PATH, { readonly: true });
    const chunks = Number(/-c(\d+)$/.exec(JSON.parse(scenario.body).model)?.[1] ?? 1);
    const rows = db
      .query(
        "SELECT status,input_tokens,output_tokens,state FROM request_logs WHERE at BETWEEN ? AND ? AND api_key_id IN (SELECT id FROM api_keys WHERE label='bench plain')",
      )
      .all(measuredFrom, measuredTo) as {
      status: number;
      input_tokens: number;
      output_tokens: number;
      state: string;
    }[];
    db.close();
    if (
      rows.length !== (report.statusCodeDistribution["200"] ?? 0) ||
      rows.some(
        (r) =>
          r.status !== 200 ||
          r.state !== "done" ||
          r.input_tokens !== 64 ||
          r.output_tokens !== chunks * 2,
      )
    )
      integrityErrors.push("measured log count/status/usage mismatch");
    const sizes = new Database(join(root, `${scenario.name}.oha.db`), {
      readonly: true,
    });
    const size = sizes
      .query("SELECT min(len_bytes) lo,max(len_bytes) hi,count(*) n FROM oha")
      .get() as { lo: number; hi: number; n: number };
    sizes.close();
    const expected = scenario.smokeBytes ?? 0;
    const slack = Math.max(128, Math.ceil(expected * 0.02));
    sizeEvidence = { ...size, expected, min: expected - slack, max: expected + slack };
    if (
      size.n !== (report.statusCodeDistribution["200"] ?? 0) ||
      size.lo < expected - slack ||
      size.hi > expected + slack
    )
      integrityErrors.push("per-request response size outside smoke band");
  }
  const fb = report.firstBytePercentiles;
  return {
    ...(flags.matrix
      ? {
          cpuMsPerRequestDrained: requests
            ? (((drained?.sample?.cpuS ?? 0) - (before?.cpuS ?? 0)) * 1000) / requests
            : null,
          loadWindow: {
            observedSeconds: windowS,
            reportedSeconds: boundary?.reportedSeconds,
            reportToExitMs: loadProcessReturnedAt - (boundary?.at ?? loadProcessReturnedAt),
            drainMs: (drained?.at ?? 0) - (boundary?.at ?? 0),
          },
        }
      : {}),
    ...(flags.matrix
      ? { integrity: { errors: integrityErrors, verifier: verification, sizes: sizeEvidence } }
      : {}),
    name: scenario.name,
    what: scenario.what,
    concurrency: scenario.concurrency,
    requests,
    successRate: report.summary.successRate,
    rps: report.summary.requestsPerSec,
    latencyMs: {
      p50: ms(lp.p50),
      p90: ms(lp.p90),
      p99: ms(lp.p99),
      p999: ms(lp["p99.9"]),
      p9999: ms(lp["p99.99"]),
    },
    ttfbMs: fb === undefined ? null : { p50: ms(fb.p50), p99: ms(fb.p99) },
    status: report.statusCodeDistribution,
    errors: report.errorDistribution,
    cpuSeconds,
    cpuMsPerRequest: requests === 0 ? Number.NaN : (cpuSeconds * 1000) / requests,
    backingCpuMsPerRequest:
      backingBefore === null || backingAfter === null || requests === 0
        ? null
        : ((backingAfter - backingBefore) * 1000) / requests,
    rssStartMb: (before?.rssKb ?? 0) / 1024,
    rssPeakMb: peak / 1024,
    rssEndMb: (settled?.rssKb ?? 0) / 1024,
    recoverySamples,
    recoveryLatenessToleranceMs: RECOVERY_LATENESS_MS,
    recoveryVerdict:
      scenario.clientTimeout === undefined
        ? null
        : recoveryVerdict(before === null ? null : before.rssKb / 1024, recoverySamples, crashed),
    healthyAfter,
    crashed,
    rows,
    foreignCores: Math.round(foreignCores * 100) / 100,
    windowFrom,
    gatewayMhz,
    threads,
    ...(perReplica.length > 1
      ? {
          perReplica: perReplica.map((r) => ({
            rps: r.summary.requestsPerSec,
            p50: ms(r.latencyPercentiles.p50),
            p99: ms(r.latencyPercentiles.p99),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------- main

const BENCH_MODELS: Record<string, string> = {
  "bench-c1": "mock-c1-d0",
  "bench-c2000": "mock-c2000-d0",
  "bench-long": "mock-c60-d500",
};

function benchModel(id: string, upstream: string): unknown {
  return {
    id,
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "custom",
        endpointId: "bench",
        model: upstream,
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 2 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  };
}

/** Limits high enough never to deny, so the limiter's bookkeeping is measured, not its 429. */
const NEVER_DENY = {
  requests: { "1m": 100_000_000 },
  tokens: { "5h": 100_000_000_000 },
  concurrency: 100_000,
};

/**
 * Cluster setup through the admin API, against a running replica: the CLI
 * opens a SQLite file and cannot reach Postgres, so this is the path an
 * operator of a cluster has as well.
 */
async function setupViaApi(): Promise<Record<"plain" | "limited", string>> {
  return apiSetup(
    BASE,
    ADMIN_PASSWORD,
    {
      provider: "custom",
      apiKey: "sk-bench-upstream",
      label: "bench upstream",
      endpointId: "bench",
      endpointLabel: "Bench",
      origin: `http://127.0.0.1:${UPSTREAM_PORT}`,
      protocol: "chat_completions",
    },
    Object.fromEntries(
      Object.entries(BENCH_MODELS).map(([id, upstream]) => [id, benchModel(id, upstream)]),
    ),
    NEVER_DENY,
  );
}

async function setup(): Promise<Record<"plain" | "limited", string>> {
  if (flags.matrix) {
    if (CLUSTER) throw Error("matrix cluster setup is not implemented");
    for (const provider of providers) {
      if (!matrixScenarios().some((s) => s.provider === provider.id && matches(s.name, flags.only)))
        continue;
      if (provider.provider === "anthropic" && !process.env.OMNI_BENCH_CERT)
        throw Error("Anthropic matrix requires scripts/bench-matrix.sh");
      await cli(
        [
          "credentials",
          "add-key",
          provider.provider,
          "--label",
          provider.id,
          ...(provider.provider === "custom"
            ? [
                "--endpoint-id",
                provider.id,
                "--endpoint-label",
                provider.id,
                "--origin",
                provider.origin,
                "--protocol",
                provider.protocol,
              ]
            : []),
        ],
        "sk-bench-upstream\n",
      );
      if (provider.protocol === "oauth")
        await seedOAuth(env.OMNI_DB_PATH, ENCRYPTION_KEY, provider.id);
      const db = new Database(env.OMNI_DB_PATH);
      const credential = db.query("SELECT id FROM credentials WHERE label=?").get(provider.id) as {
        id: string;
      };
      db.close();
      for (const chunks of [1, 2000]) {
        const id = `${provider.id}-c${chunks}`;
        const model = {
          id,
          strategy: "priority",
          isAlias: false,
          targets: [
            {
              provider: provider.provider,
              ...(provider.provider === "custom"
                ? { endpointId: provider.id }
                : { credentialId: credential.id }),
              model: `mock-c${chunks}-d0`,
              tier: 1,
              weight: 1,
              costPerMTok: { input: 1, output: 2 },
              capabilities: { tools: true, images: true, reasoning: true },
            },
          ],
        };
        const file = join(root, `${id}.model.json`);
        writeFileSync(file, JSON.stringify(model));
        await cli(["models", "put", id, "-f", file]);
      }
    }
    const plain = (await cli(["keys", "create", "--label", "bench plain"])) as { key: string };
    if (process.env.OMNI_BENCH_FAULT === "missing-credential") {
      const db = new Database(env.OMNI_DB_PATH);
      db.run("DELETE FROM credentials");
      db.close();
    }
    return { plain: plain.key, limited: plain.key };
  }
  await cli(
    [
      "credentials",
      "add-key",
      "custom",
      "--label",
      "bench upstream",
      "--endpoint-id",
      "bench",
      "--endpoint-label",
      "Bench",
      "--origin",
      `http://127.0.0.1:${UPSTREAM_PORT}`,
      "--protocol",
      "chat-completions",
    ],
    "sk-bench-upstream\n",
  );
  for (const [id, upstream] of Object.entries(BENCH_MODELS)) {
    const file = join(root, `${id}.model.json`);
    writeFileSync(file, JSON.stringify(benchModel(id, upstream)));
    await cli(["models", "put", id, "-f", file]);
  }
  const plain = (await cli(["keys", "create", "--label", "bench plain"])) as { key: string };
  // Limits high enough never to deny, so the scenario measures the limiter's
  // bookkeeping rather than its 429 path.
  const limited = (await cli([
    "keys",
    "create",
    "--label",
    "bench limited",
    "--limit",
    "requests:1m=100000000",
    "--limit",
    "tokens:5h=100000000000",
    "--limit",
    "concurrency=100000",
  ])) as { key: string };
  return { plain: plain.key, limited: limited.key };
}

function startUpstreams(): void {
  if (flags.matrix) {
    const upstreams = new Map(
      providers
        .filter((p) =>
          matrixScenarios().some((s) => s.provider === p.id && matches(s.name, flags.only)),
        )
        .map((provider) => [provider.origin, provider.script]),
    );
    for (const [origin, script] of upstreams) {
      for (let i = 0; i < 2; i += 1) {
        const proc = Bun.spawn(
          [
            "taskset",
            "-c",
            flags["upstream-cpus"] ?? "4-5",
            process.execPath,
            join(import.meta.dir, script),
            "--port",
            new URL(origin).port || "443",
            ...(script === "bench-gateway-upstream.ts" ? ["--matrix"] : []),
            ...(origin.startsWith("https:")
              ? [
                  "--cert",
                  process.env.OMNI_BENCH_CERT ?? "",
                  "--key",
                  process.env.OMNI_BENCH_TLS_KEY ?? "",
                ]
              : []),
          ],
          { stdout: "ignore", stderr: "inherit" },
        );
        children.push(proc);
        upstreamPids.push(proc.pid);
      }
    }
    return;
  }
  // Two copies on one port: the upstream must never be the ceiling.
  for (let i = 0; i < 2; i += 1) {
    const proc = Bun.spawn(
      [
        "taskset",
        "-c",
        flags["upstream-cpus"] ?? "4-5",
        process.execPath,
        join(import.meta.dir, "bench-gateway-upstream.ts"),
        "--port",
        String(UPSTREAM_PORT),
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    children.push(proc);
    upstreamPids.push(proc.pid);
  }
}

async function smoke(key: string): Promise<void> {
  const cases: [string, string][] = [
    ["/v1/chat/completions", chatBody("bench-c1")],
    ["/v1/messages", anthropicBody("bench-c1", false)],
    ["/v1/messages", agentBody("bench-c1")],
    ["/v1/responses", responsesBody("bench-c1")],
  ];
  await smokeRequests(BASE, key, cases);
}

async function cliTimings(runs: number): Promise<{ p50Ms: number; maxMs: number }> {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await cli(["keys", "list"]);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { p50Ms: percentile(times, 50), maxMs: times[times.length - 1] as number };
}

async function main(): Promise<void> {
  if (flags.matrix) process.env.OMNI_BENCH_REFRESH_LOG = join(root, "refresh.log");
  if (flags.matrix) {
    for (const name of ["OMNI_BENCH_CERT", "OMNI_BENCH_TLS_KEY"]) {
      const value = process.env[name];
      if (value) {
        const path = join(root, name);
        writeFileSync(path, readFileSync(value));
        (env as Record<string, string | undefined>)[name] = path;
      }
    }
  }
  const loadBefore = loadavg()[0];
  let provenance:
    | {
        gatewayBinary: string;
        gatewaySha256: string;
        harnessCommit: string;
        loadBefore: number | undefined;
        loadAfter?: number;
        environment?: Record<string, string>;
      }
    | undefined;
  if (flags.matrix) {
    const launcher = GATEWAY_ARGV.some((arg) => arg.endsWith("/run-rust-gateway.sh"));
    const launcherPath = GATEWAY_ARGV.find((arg) => arg.endsWith("/run-rust-gateway.sh"));
    const program = launcher
      ? (process.env.OMNI_RUST_BINARY ??
        resolve(launcherPath as string, "../../target/release/omnigateway"))
      : (GATEWAY_ARGV[0] as string);
    const binary = program.includes("/") ? resolve(root, program) : Bun.which(program);
    if (!binary) throw Error(`cannot resolve gateway binary: ${program}`);
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO });
    if (commit.exitCode !== 0) throw Error("cannot identify harness commit");
    provenance = {
      gatewayBinary: binary,
      gatewaySha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(binary).arrayBuffer())
        .digest("hex"),
      harnessCommit: commit.stdout.toString().trim(),
      loadBefore,
    };
  }
  mkdirSync(join(root, "no-dashboard"), { recursive: true });
  // `--root` makes the CLI ignore an ambient OMNI_DB_PATH, so the root states
  // its own, which is how a real installation does it.
  writeFileSync(
    join(root, ".env"),
    `OMNI_ENCRYPTION_KEY=${ENCRYPTION_KEY}\nOMNI_DB_PATH=${env.OMNI_DB_PATH}\n`,
  );
  console.error(`bench root ${root}${CLUSTER ? ` · cluster × ${REPLICAS}` : ""}`);
  const calibration = await calibrate();
  console.error(
    `calibration (ms, lower is faster) alone ${JSON.stringify(calibration.alone)} ` +
      `together ${JSON.stringify(calibration.together)} · foreign load ${calibration.foreignCoresBefore} cores`,
  );
  let keys = CLUSTER ? null : await setup();
  startUpstreams();
  await sleep(500);

  // Cold boots: time from spawn to the first 200 on /health, and SIGTERM to exit.
  const boots: number[] = [];
  const shutdowns: number[] = [];
  for (let i = 0; i < Number(flags.boots); i += 1) {
    const started = performance.now();
    const proc = startGateway();
    if (!(await waitHealthy(30_000))) throw new Error("gateway did not become healthy");
    boots.push(performance.now() - started);
    shutdowns.push(await stopGateway(proc));
  }

  const gateways = PORTS.map((_, i) => startGateway(i));
  for (const base of BASES) {
    if (!(await waitHealthy(30_000, base))) throw new Error(`${base} did not become healthy`);
  }
  if (keys === null) keys = await setupViaApi();
  const pids = gateways.map((g) => g.pid);
  if (provenance) provenance.environment = processEnvironment(pids[0] as number);
  await sleep(2000);
  const idle = fleetSample(pids);
  if (!flags.matrix) await smoke(keys.plain);

  const only = flags.only?.split(",");
  const results: ScenarioResult[] = [];
  const matrixResults: (MatrixMeta &
    Verdict & {
      name: string;
      concurrency: number;
      bodySha256: string;
      diagnostics?: unknown;
      metrics: ScenarioResult | null;
    })[] = [];
  for (const scenario of flags.matrix ? matrixScenarios() : scenarios()) {
    if (
      flags.matrix
        ? !matches(scenario.name, flags.only)
        : only !== undefined && !only.includes(scenario.name)
    )
      continue;
    const meta = flags.matrix ? (scenario as Scenario & MatrixMeta) : null;
    if (meta && flags["fresh-process"]) {
      await stopGateway(gateways[0] as Subprocess);
      const replacement = startGateway();
      gateways[0] = replacement;
      pids[0] = replacement.pid;
      if (!(await waitHealthy(30000))) throw Error("fresh gateway did not start");
      if (
        provenance &&
        JSON.stringify(processEnvironment(replacement.pid)) !==
          JSON.stringify(provenance.environment)
      )
        throw Error("effective environment changed after restart");
    }
    if (meta) {
      const verdict = await matrixSmoke(BASE, keys.plain, meta);
      if (verdict.bytes !== undefined) (scenario as Scenario).smokeBytes = verdict.bytes;
      if (verdict.classification !== "supported") {
        matrixResults.push({
          concurrency: scenario.concurrency,
          bodySha256: new Bun.CryptoHasher("sha256").update(scenario.body).digest("hex"),
          name: scenario.name,
          provider: meta.provider,
          ingress: meta.ingress,
          mode: meta.mode,
          ...verdict,
          metrics: null,
        });
        console.error(`${scenario.name}: ${verdict.classification}: ${verdict.reason}`);
        continue;
      }
    }
    console.error(`running ${scenario.name}…`);
    const result = await runScenario(scenario, pids, keys);
    results.push(result);
    if (meta) {
      const failed =
        shed(result) ||
        (result.integrity?.errors.length ?? 0) > 0 ||
        result.requests === 0 ||
        result.rows === null ||
        result.crashed > 0 ||
        !result.healthyAfter ||
        Object.keys(result.errors).length > 0 ||
        Object.keys(result.status).some((status) => status !== "200");
      matrixResults.push({
        concurrency: scenario.concurrency,
        bodySha256: new Bun.CryptoHasher("sha256").update(scenario.body).digest("hex"),
        name: scenario.name,
        provider: meta.provider,
        ingress: meta.ingress,
        mode: meta.mode,
        classification: failed ? "failed" : "supported",
        reason: failed ? "load integrity check failed" : "shape and load integrity passed",
        metrics: failed ? null : result,
        diagnostics: failed
          ? {
              integrity: result.integrity,
              rows: result.rows,
              status: result.status,
              errors: result.errors,
            }
          : undefined,
      });
    }
    // A crash is a result, recorded above; the next scenario still needs a
    // fleet to measure, so a dead replica is replaced before it starts.
    for (let i = 0; i < gateways.length; i += 1) {
      if (procSample(pids[i] as number) !== null) continue;
      console.error(`  replica ${i} died during ${scenario.name}; restarting`);
      const replacement = startGateway(i);
      if (!(await waitHealthy(30_000, BASES[i]))) throw new Error(`replica ${i} did not restart`);
      gateways[i] = replacement;
      pids[i] = replacement.pid;
    }
    if (showPerformance(!!flags.matrix, matrixResults.at(-1)?.classification))
      console.error(
        `  ${result.rps.toFixed(0)} req/s  p50 ${result.latencyMs.p50.toFixed(2)} ms  ` +
          `p99 ${result.latencyMs.p99.toFixed(2)} ms  cpu ${result.cpuMsPerRequest.toFixed(3)} ms/req  ` +
          `rss peak ${result.rssPeakMb.toFixed(0)} MiB  ok ${(result.successRate * 100).toFixed(2)}%` +
          (result.rows === null
            ? ""
            : `  rows ${result.rows.done}/${result.rows.answered} pending ${result.rows.pending}` +
              `  writer ${writerCell(result.rows.writer)}` +
              (shed(result) ? "  ROWS DROPPED" : "")) +
          `  foreign ${result.foreignCores} cores` +
          (result.threads === null ? "" : `  threads ${JSON.stringify(result.threads)}`) +
          (result.crashed > 0 ? `  CRASHED ×${result.crashed}` : ""),
      );
  }
  const final = fleetSample(pids);
  const shutdownMs = Math.max(...(await Promise.all(gateways.map(stopGateway))));
  const writerDropped = writerDrops();
  // The CLI reads SQLite only; a cluster has no file for it to open.
  const cli = CLUSTER ? null : await cliTimings(10);

  boots.sort((a, b) => a - b);
  const gatewayBinary = GATEWAY_ARGV[0] as string;
  let binaryBytes: number | null = null;
  try {
    binaryBytes = statSync(gatewayBinary).size;
  } catch {
    binaryBytes = null;
  }
  const dbBytes = (() => {
    try {
      return statSync(join(root, "omni.db")).size;
    } catch {
      return null;
    }
  })();

  const output = {
    ...(provenance ? { provenance: { ...provenance, loadAfter: loadavg()[0] } } : {}),
    label: flags.label ?? null,
    when: new Date().toISOString(),
    host: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memGb: Math.round(totalmem() / 2 ** 30),
      kernel: release(),
    },
    config: {
      gateway: GATEWAY_ARGV,
      cli: CLI_ARGV,
      duration: flags.duration,
      warmup: flags.warmup,
      gatewayCpus: flags["gateway-cpus"],
      upstreamCpus: flags["upstream-cpus"],
      loadCpus: flags["load-cpus"],
      ...(flags.matrix
        ? {
            rate: flags.rate ?? null,
            freshProcess: flags["fresh-process"],
            processScope: flags["fresh-process"]
              ? "fresh gateway per scenario"
              : "one gateway serves scenarios in order; later RSS includes earlier workload history",
          }
        : {}),
      mode: CLUSTER ? "cluster" : "single",
      replicas: REPLICAS,
      cpuSets: CPU_SETS,
    },
    binaryBytes,
    boot: { p50Ms: percentile(boots, 50), maxMs: boots[boots.length - 1] },
    shutdownMs: {
      idleP50: percentile(
        shutdowns.sort((a, b) => a - b),
        50,
      ),
      afterLoad: shutdownMs,
    },
    idleRssMb: (idle?.rssKb ?? 0) / 1024,
    finalRssMb: (final?.rssKb ?? 0) / 1024,
    dbBytesAfter: dbBytes,
    cliKeysList: cli,
    calibration,
    writerDropped,
    scenarios: flags.matrix ? matrixResults : results,
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (flags.out !== undefined) writeFileSync(resolve(REPO, flags.out), json);
  else process.stdout.write(json);
  if (flags.matrix) {
    for (const provider of providers) {
      console.error(
        `\n### ${provider.id}\n| scenario | result | req/s | p50 | p99 | CPU ms/req load | CPU ms/req drained | RSS MiB |\n|---|---|---:|---:|---:|---:|---:|---:|`,
      );
      for (const r of matrixResults.filter((r) => r.provider === provider.id))
        console.error(
          `| ${r.name} | ${r.classification}: ${r.reason} | ${r.metrics?.rps ?? "–"} | ${r.metrics?.latencyMs.p50 ?? "–"} | ${r.metrics?.latencyMs.p99 ?? "–"} | ${r.metrics?.cpuMsPerRequest ?? "–"} | ${r.metrics?.cpuMsPerRequestDrained ?? "–"} | ${r.metrics?.rssPeakMb ?? "–"} |`,
        );
    }
    if (matrixResults.some((r) => r.classification === "failed")) process.exitCode = 1;
  } else console.error(markdown({ ...output, scenarios: results }));
}

/**
 * A scenario whose request log is missing rows or left rows pending, whose
 * writer dropped or failed events, or whose barrier did not answer.
 */
function shed(r: ScenarioResult): boolean {
  if (r.rows === null) return false;
  const w = r.rows.writer;
  return (
    r.rows.missing > 0 ||
    r.rows.pending > 0 ||
    w === "inconclusive" ||
    (typeof w === "object" && (w.dropped > 0 || w.failed > 0))
  );
}

/** The writer column: drops / failures, or why there are none to show. */
function writerCell(w: RowCheck["writer"]): string {
  if (w === "unsupported") return "n/a";
  if (w === "inconclusive") return "INCONCLUSIVE";
  return `${w.dropped} / ${w.failed}`;
}

/**
 * Events the gateway's writer reported dropping, from its log: the Rust
 * gateway logs the total at shutdown (`request log writer lost events …
 * count=N`). `null` when the log has no such line (TS has no drop path: it
 * writes every row synchronously).
 */
function writerDrops(): number | null {
  let total: number | null = null;
  for (let i = 0; i < REPLICAS; i += 1) {
    let text = "";
    try {
      text = readFileSync(join(root, `gateway-${i}.log`), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/request log writer lost events.*?\bcount=(\d+)/g))
      total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

function markdown(o: {
  boot: { p50Ms: number };
  idleRssMb: number;
  finalRssMb: number;
  binaryBytes: number | null;
  cliKeysList: { p50Ms: number } | null;
  calibration: Calibration;
  writerDropped: number | null;
  scenarios: ScenarioResult[];
}): string {
  const anyShed = o.scenarios.some(shed) || (o.writerDropped ?? 0) > 0;
  const lines = [
    `boot p50 ${o.boot.p50Ms.toFixed(0)} ms · idle RSS ${o.idleRssMb.toFixed(0)} MiB · final RSS ${o.finalRssMb.toFixed(0)} MiB · ` +
      `binary ${o.binaryBytes === null ? "n/a" : `${(o.binaryBytes / 2 ** 20).toFixed(0)} MiB`} · ` +
      `omni keys list p50 ${o.cliKeysList === null ? "n/a" : `${o.cliKeysList.p50Ms.toFixed(0)} ms`}`,
    `calibration ms per vCPU, alone ${JSON.stringify(o.calibration.alone)} · all at once ${JSON.stringify(o.calibration.together)}`,
    `writer drops reported by the gateway: ${o.writerDropped ?? "none logged"}`,
    ...(anyShed
      ? [
          "",
          "**⚠ ROWS DROPPED: the gateway shed request-log rows in this run (rows column). " +
            "Its throughput is not comparable with a run that wrote every row.**",
        ]
      : []),
    "",
    "| scenario | c | req/s | p50 ms | p99 ms | p99.9 ms | TTFB p50 | CPU ms/req | +db ms/req | RSS peak MiB | ok % | crashed | rows missing / pending | writer dropped / failed | foreign cores |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of o.scenarios) {
    const rows =
      r.rows === null
        ? "– | –"
        : `${r.rows.missing} / ${r.rows.pending} | ${writerCell(r.rows.writer)}${shed(r) ? " ⚠ DROPPED" : ""}`;
    lines.push(
      `| ${r.name} | ${r.concurrency} | ${r.rps.toFixed(0)} | ${r.latencyMs.p50.toFixed(2)} | ${r.latencyMs.p99.toFixed(2)} | ` +
        `${r.latencyMs.p999.toFixed(2)} | ${r.ttfbMs === null ? "–" : r.ttfbMs.p50.toFixed(2)} | ` +
        `${r.cpuMsPerRequest.toFixed(3)} | ${r.backingCpuMsPerRequest === null ? "–" : r.backingCpuMsPerRequest.toFixed(3)} | ${r.rssPeakMb.toFixed(0)} | ${(r.successRate * 100).toFixed(2)} | ${r.crashed} | ` +
        `${rows} | ${r.foreignCores.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

try {
  await main();
} finally {
  cleanup();
  if (process.env.OMNI_BENCH_KEEP !== "1") rmSync(root, { recursive: true, force: true });
}
