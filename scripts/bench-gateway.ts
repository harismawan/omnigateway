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
 * `--load-cpus 6-7` `--streams 1000` `--boots 5` `--only <scenario,...>`.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";

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
    label: { type: "string" },
    cluster: { type: "boolean", default: false },
    replicas: { type: "string", default: "1" },
    "database-url": { type: "string" },
    "redis-url": { type: "string" },
    containers: { type: "string" },
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

async function waitHealthy(timeoutMs: number, base = BASE): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
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
  healthyAfter: boolean;
  /** Replicas whose process was gone after the scenario. Each is restarted. */
  crashed: number;
  perReplica?: { rps: number; p50: number; p99: number }[];
};

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
  }
  if (scenario.clientTimeout !== undefined) args.push("-t", scenario.clientTimeout);
  args.push(`${base}${scenario.path}`);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`oha failed for ${scenario.name}: ${err}`);
  return JSON.parse(out) as OhaJson;
}

const ms = (v: number | null | undefined): number => (v == null ? Number.NaN : v * 1000);

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
  if (scenario.warmup !== false) await ohaFleet(scenario, key, flags.warmup ?? "3s");
  await sleep(500);

  const before = fleetSample(pids);
  const backingBefore = backingCpuS();
  let peak = before?.rssKb ?? 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const s = fleetSample(pids);
      if (s !== null && s.rssKb > peak) peak = s.rssKb;
      await sleep(100);
    }
  })();

  const { merged: report, perReplica } = await ohaFleet(scenario, key, flags.duration ?? "20s");
  sampling = false;
  await sampler;
  const after = fleetSample(pids);
  const backingAfter = backingCpuS();
  // Settle before the next scenario, then confirm the process still answers:
  // a scenario that leaves the gateway wedged is a result, not a crash.
  await sleep(scenario.clientTimeout === undefined ? 1000 : 5000);
  const settled = fleetSample(pids);
  const crashed = pids.filter((pid) => procSample(pid) === null).length;
  const healthyAfter =
    crashed === 0 &&
    (await Promise.all(BASES.map((base) => waitHealthy(5000, base)))).every(Boolean);

  const requests =
    Object.values(report.statusCodeDistribution).reduce((a, b) => a + b, 0) +
    Object.values(report.errorDistribution).reduce((a, b) => a + b, 0);
  const cpuSeconds = (after?.cpuS ?? 0) - (before?.cpuS ?? 0);
  const lp = report.latencyPercentiles;
  const fb = report.firstBytePercentiles;
  return {
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
    healthyAfter,
    crashed,
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
  const call = async (method: string, path: string, body: unknown, cookie?: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return { res, json: text.length === 0 ? null : (JSON.parse(text) as unknown) };
  };
  const { res } = await call("POST", "/api/setup", { password: ADMIN_PASSWORD });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  await call(
    "POST",
    "/api/credentials",
    {
      provider: "custom",
      apiKey: "sk-bench-upstream",
      label: "bench upstream",
      endpointId: "bench",
      endpointLabel: "Bench",
      origin: `http://127.0.0.1:${UPSTREAM_PORT}`,
      protocol: "chat_completions",
    },
    cookie,
  );
  for (const [id, upstream] of Object.entries(BENCH_MODELS)) {
    await call("PUT", `/api/models/${id}`, benchModel(id, upstream), cookie);
  }
  const plain = (await call("POST", "/api/keys", { label: "bench plain" }, cookie)).json as {
    key: string;
  };
  const limited = (
    await call("POST", "/api/keys", { label: "bench limited", limits: NEVER_DENY }, cookie)
  ).json as { key: string };
  return { plain: plain.key, limited: limited.key };
}

async function setup(): Promise<Record<"plain" | "limited", string>> {
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
  }
}

async function smoke(key: string): Promise<void> {
  const cases: [string, string][] = [
    ["/v1/chat/completions", chatBody("bench-c1")],
    ["/v1/messages", anthropicBody("bench-c1", false)],
    ["/v1/messages", agentBody("bench-c1")],
    ["/v1/responses", responsesBody("bench-c1")],
  ];
  for (const [path, body] of cases) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    const text = await res.text();
    if (res.status !== 200 || !text.includes("lorem ipsum")) {
      throw new Error(`smoke ${path} failed: ${res.status} ${text.slice(0, 400)}`);
    }
  }
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
  mkdirSync(join(root, "no-dashboard"), { recursive: true });
  // `--root` makes the CLI ignore an ambient OMNI_DB_PATH, so the root states
  // its own, which is how a real installation does it.
  writeFileSync(
    join(root, ".env"),
    `OMNI_ENCRYPTION_KEY=${ENCRYPTION_KEY}\nOMNI_DB_PATH=${env.OMNI_DB_PATH}\n`,
  );
  console.error(`bench root ${root}${CLUSTER ? ` · cluster × ${REPLICAS}` : ""}`);
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
  await sleep(2000);
  const idle = fleetSample(pids);
  await smoke(keys.plain);

  const only = flags.only?.split(",");
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios()) {
    if (only !== undefined && !only.includes(scenario.name)) continue;
    console.error(`running ${scenario.name}…`);
    const result = await runScenario(scenario, pids, keys);
    results.push(result);
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
    console.error(
      `  ${result.rps.toFixed(0)} req/s  p50 ${result.latencyMs.p50.toFixed(2)} ms  ` +
        `p99 ${result.latencyMs.p99.toFixed(2)} ms  cpu ${result.cpuMsPerRequest.toFixed(3)} ms/req  ` +
        `rss peak ${result.rssPeakMb.toFixed(0)} MiB  ok ${(result.successRate * 100).toFixed(2)}%` +
        (result.crashed > 0 ? `  CRASHED ×${result.crashed}` : ""),
    );
  }
  const final = fleetSample(pids);
  const shutdownMs = Math.max(...(await Promise.all(gateways.map(stopGateway))));
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
    scenarios: results,
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (flags.out !== undefined) writeFileSync(resolve(REPO, flags.out), json);
  else process.stdout.write(json);
  console.error(markdown(output));
}

function markdown(o: {
  boot: { p50Ms: number };
  idleRssMb: number;
  finalRssMb: number;
  binaryBytes: number | null;
  cliKeysList: { p50Ms: number } | null;
  scenarios: ScenarioResult[];
}): string {
  const lines = [
    `boot p50 ${o.boot.p50Ms.toFixed(0)} ms · idle RSS ${o.idleRssMb.toFixed(0)} MiB · final RSS ${o.finalRssMb.toFixed(0)} MiB · ` +
      `binary ${o.binaryBytes === null ? "n/a" : `${(o.binaryBytes / 2 ** 20).toFixed(0)} MiB`} · ` +
      `omni keys list p50 ${o.cliKeysList === null ? "n/a" : `${o.cliKeysList.p50Ms.toFixed(0)} ms`}`,
    "",
    "| scenario | c | req/s | p50 ms | p99 ms | p99.9 ms | TTFB p50 | CPU ms/req | +db ms/req | RSS peak MiB | ok % | crashed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of o.scenarios) {
    lines.push(
      `| ${r.name} | ${r.concurrency} | ${r.rps.toFixed(0)} | ${r.latencyMs.p50.toFixed(2)} | ${r.latencyMs.p99.toFixed(2)} | ` +
        `${r.latencyMs.p999.toFixed(2)} | ${r.ttfbMs === null ? "–" : r.ttfbMs.p50.toFixed(2)} | ` +
        `${r.cpuMsPerRequest.toFixed(3)} | ${r.backingCpuMsPerRequest === null ? "–" : r.backingCpuMsPerRequest.toFixed(3)} | ${r.rssPeakMb.toFixed(0)} | ${(r.successRate * 100).toFixed(2)} | ${r.crashed} |`,
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
