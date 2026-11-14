#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkManifest } from "./bench-manifest";

type Metrics = {
  integrity?: { verifier?: VerifierCounts };
  rps: number;
  latencyMs: { p50: number; p99: number };
  cpuMsPerRequest: number;
  cpuMsPerRequestDrained?: number;
  rssPeakMb: number;
};
export type Round = {
  provenance: {
    gatewaySha256: string;
    harnessCommit?: string;
    environment?: Record<string, string>;
  };
  config?: Record<string, unknown>;
  scenarios: {
    name: string;
    provider: string;
    classification: string;
    metrics: Metrics | null;
    concurrency?: number;
    bodySha256?: string;
    diagnostics?: { integrity?: { verifier?: VerifierCounts } };
  }[];
};
type VerifierCounts = {
  started?: number;
  completed?: number;
  skippedTicks?: number;
  violations?: number;
};
const metrics = [
  { name: "req/s", higher: true, get: (m: Metrics) => m.rps },
  { name: "p50 ms", higher: false, get: (m: Metrics) => m.latencyMs.p50 },
  { name: "p99 ms", higher: false, get: (m: Metrics) => m.latencyMs.p99 },
  { name: "CPU ms/req", higher: false, get: (m: Metrics) => m.cpuMsPerRequest },
  {
    name: "CPU ms/req through row drain",
    higher: false,
    get: (m: Metrics) => m.cpuMsPerRequestDrained ?? Number.NaN,
  },
  { name: "RSS peak MiB", higher: false, get: (m: Metrics) => m.rssPeakMb },
];
function spread(values: number[]) {
  values.sort((a, b) => a - b);
  const min = values[0],
    max = values.at(-1);
  if (min === undefined || max === undefined) return null;
  return {
    min,
    max,
    median:
      ((values[Math.floor((values.length - 1) / 2)] ?? 0) +
        (values[Math.floor(values.length / 2)] ?? 0)) /
      2,
  };
}
export function overlaps(a: { min: number; max: number }, b: { min: number; max: number }) {
  return a.min <= b.max && b.min <= a.max;
}
function hash(rounds: Round[]) {
  const hashes = new Set(rounds.map((r) => r.provenance?.gatewaySha256));
  if (!rounds.length || hashes.size !== 1 || !/^[a-f0-9]{64}$/.test([...hashes][0] ?? ""))
    throw Error("each side requires one consistent gateway binary SHA256 across all rounds");
  return [...hashes][0];
}
export function compare(
  base: Round[],
  head: Round[],
  options: { requireSameEnv?: boolean } = {},
): string {
  hash(base);
  hash(head);
  const canonical = (value: unknown): string =>
    JSON.stringify(
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    );
  const reference = base[0] as Round;
  const fresh = [...base, ...head].every((r) => r.config?.freshProcess === true);
  const selection = (r: Round) => r.scenarios.map((s) => s.name);
  const fields = [
    "duration",
    "warmup",
    "gatewayCpus",
    "upstreamCpus",
    "loadCpus",
    "cpuSets",
    "rate",
    "freshProcess",
  ];
  for (const [side, rounds] of [
    ["base", base],
    ["head", head],
  ] as const)
    for (const [i, r] of rounds.entries()) {
      if (!fresh && canonical(selection(reference)) !== canonical(selection(r)))
        throw Error(
          `${side} round ${i + 1}: ordered selection differs: ${canonical(selection(reference))} vs ${canonical(selection(r))}`,
        );
      for (const field of fields) {
        const expected = reference.config?.[field],
          actual = r.config?.[field];
        if (
          !["rate", "freshProcess"].includes(field) &&
          (expected === undefined || actual === undefined)
        )
          throw Error(`missing config.${field}`);
        if (canonical(expected) !== canonical(actual))
          throw Error(
            `${side} round ${i + 1}: config.${field} differs: ${canonical(expected)} vs ${canonical(actual)}`,
          );
      }
      for (const field of ["harnessCommit"] as const) {
        if (reference.provenance[field] === undefined || r.provenance[field] === undefined)
          throw Error(`missing provenance.${field}`);
        if (canonical(reference.provenance[field]) !== canonical(r.provenance[field]))
          throw Error(
            `${side} round ${i + 1}: provenance.${field} differs: ${canonical(reference.provenance[field])} vs ${canonical(r.provenance[field])}`,
          );
      }
      for (const s of r.scenarios) {
        const ref = [...base, ...head].flatMap((x) => x.scenarios).find((x) => x.name === s.name);
        if (s.concurrency === undefined || s.bodySha256 === undefined)
          throw Error(`missing ${s.name} concurrency/bodySha256`);
        for (const field of ["concurrency", "bodySha256"] as const)
          if (ref?.[field] !== s[field])
            throw Error(
              `${side} round ${i + 1}: ${s.name}.${field} differs: ${ref?.[field]} vs ${s[field]}`,
            );
      }
    }
  const environment = (r: Round) => {
    const env = r.provenance.environment;
    if (!env) throw Error("missing environment");
    const root = env.OMNI_ROOT;
    return Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        root && (v === root || v.startsWith(`${root}/`)) ? `<scratch>${v.slice(root.length)}` : v,
      ]),
    );
  };
  const differences = (a: Record<string, string>, b: Record<string, string>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  for (const [side, rs] of [
    ["base", base],
    ["head", head],
  ] as const) {
    const first = environment(rs[0] as Round);
    for (const r of rs) {
      const diff = differences(first, environment(r));
      if (diff.length) throw Error(`${side} environment differs: ${diff.join(", ")}`);
    }
  }
  const be = environment(base[0] as Round),
    he = environment(head[0] as Round),
    diff = differences(be, he);
  if (options.requireSameEnv && diff.length) throw Error(`environment differs: ${diff.join(", ")}`);
  const header = [
    `Base SHA256: \`${hash(base)}\``,
    `Head SHA256: \`${hash(head)}\``,
    `Effective base environment: ${JSON.stringify(base[0]?.provenance.environment)}`,
    `Effective head environment: ${JSON.stringify(head[0]?.provenance.environment)}`,
    "Rust's production launcher defaults MIMALLOC_PURGE_DELAY=1; this is not an allocator-neutral comparison.",
    "CPU covers the gateway process and its threads only (children excluded). Memory is resident memory sampled every 100 ms.",
    fresh
      ? "--fresh-process was used; database history is retained."
      : "One process serves all scenarios; later scenarios include earlier process and database history.",
    "The load interval ends at oha's report file, with a 250 ms tolerance.",
    "Verifier requests are extra gateway work, not counted in the request rate.",
    "Measured traffic integrity uses status, usage, per-request size and a sampling full-body verifier; this is not a proof that every response was correct.",
    fresh
      ? "All rounds use --fresh-process; differing ordered selections allowed for shared scenarios (database state retained)."
      : "All rounds have the same ordered scenario selection.",
    "### environment differences between sides",
    "| variable | base | head |",
    "|---|---|---|",
    ...diff.map((k) => `| ${k} | ${be[k] ?? "<unset>"} | ${he[k] ?? "<unset>"} |`),
    ...(diff.length ? [] : ["None."]),
    "",
    "Values: successful/total rounds; median [min–max]. Ratios are head/base. Range overlap is descriptive, not a significance test. Directional labels require at least three successful observations per side. RSS is per-scenario peak resident memory.",
    "",
  ];
  header.push("Verifier counts by round (started/completed/skipped ticks/violations):");
  for (const [side, rounds] of [
    ["base", base],
    ["head", head],
  ] as const)
    for (const [i, r] of rounds.entries())
      header.push(
        `${side} round ${i + 1}: ${r.scenarios
          .map((s) => {
            const v = s.metrics?.integrity?.verifier ?? s.diagnostics?.integrity?.verifier;
            return `${s.name}=${v?.started ?? "unknown"}/${v?.completed ?? "unknown"}/${v?.skippedTicks ?? "unknown"}/${v?.violations ?? "unknown"}`;
          })
          .join(", ")}`,
      );
  const names = [...new Set([...base, ...head].flatMap((r) => r.scenarios.map((s) => s.name)))];
  const tables = new Map<string, string[]>();
  const counts = metrics.map(() => ({ better: 0, worse: 0, inside: 0 }));
  for (const name of names) {
    const sides = [base, head].map((rounds) => {
      const rows = rounds.map((r) => r.scenarios.find((s) => s.name === name));
      const successful = rows.filter(
        (r) => r?.classification === "supported" && r.metrics !== null,
      );
      const statuses = [
        ...new Set(
          rows.filter((r) => r && r.classification !== "supported").map((r) => r?.classification),
        ),
      ];
      if (rows.some((r) => r === undefined)) statuses.push("missing observation");
      return { rows, successful, statuses, total: rounds.length };
    });
    const provider = sides.flatMap((s) => s.rows).find(Boolean)?.provider ?? "unknown";
    if (!tables.has(provider))
      tables.set(provider, [
        `### ${provider}`,
        "| scenario | metric | base | head | head/base |",
        "|---|---|---|---|---|",
      ]);
    for (const [i, metric] of metrics.entries()) {
      const stats = sides.map((side) =>
        spread(
          side.successful.map((r) => metric.get(r?.metrics as Metrics)).filter(Number.isFinite),
        ),
      );
      const cells = sides.map((side, j) => {
        const s = stats[j];
        return `${side.successful.length}/${side.total}; ${side.statuses.length ? `${side.statuses.join(", ")}; ` : ""}${s ? `${s.median.toFixed(3)} [${s.min.toFixed(3)}–${s.max.toFixed(3)}]` : "n/a"}`;
      });
      const [a, b] = stats;
      let ratio = "n/a";
      if (
        a &&
        b &&
        a.median > 0 &&
        sides.every((s) => s.statuses.length === 0) &&
        stats.every(
          (s, j) =>
            s &&
            sides[j]?.successful.every((r) => Number.isFinite(metric.get(r?.metrics as Metrics))),
        )
      ) {
        const inside = overlaps(a, b);
        const sufficient = sides.every((s) => s.successful.length >= 3);
        const verdict = !sufficient
          ? "insufficient rounds"
          : inside
            ? "inside spread"
            : b.median > a.median === metric.higher
              ? "better"
              : "worse";
        const count = counts[i];
        if (count && sufficient) {
          if (inside) count.inside++;
          else if (verdict === "better") count.better++;
          else count.worse++;
        }
        ratio = `${(b.median / a.median).toFixed(3)} — ${verdict}`;
      }
      tables
        .get(provider)
        ?.push(`| ${name} | ${metric.name} | ${cells[0]} | ${cells[1]} | ${ratio} |`);
    }
  }
  header.push("| metric | better | worse | inside spread |", "|---|---:|---:|---:|");
  for (const [i, metric] of metrics.entries())
    header.push(
      `| ${metric.name} | ${counts[i]?.better} | ${counts[i]?.worse} | ${counts[i]?.inside} |`,
    );
  return [...header, "", ...[...tables.values()].flatMap((lines) => [...lines, ""])].join("\n");
}
async function load(path: string): Promise<Round[]> {
  if (statSync(path).isDirectory()) await checkManifest(path);
  const paths = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((p) => /^\d+\.json$/.test(p))
        .sort()
        .map((p) => join(path, p))
    : [path];
  return Promise.all(paths.map((p) => Bun.file(p).json()));
}
if (import.meta.main) {
  const [a, b] = process.argv.slice(2).filter((a) => a !== "--require-same-env");
  if (!a || !b) throw Error("usage: bench-compare.ts <base.json|directory> <head.json|directory>");
  console.log(
    compare(await load(a), await load(b), {
      requireSameEnv: process.argv.includes("--require-same-env"),
    }),
  );
}
