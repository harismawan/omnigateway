import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The export worker's modules are importable only from the worker. Design:
 * docs/superpowers/specs/2026-10-24-log-export-design.md (*Testing* → "the
 * export cursor query, record builder, encoders, artifact reader and
 * `export_state` repository are importable only from
 * `apps/gateway/src/export/worker*` (a lint/test that fails if the
 * main-thread module graph reaches them)").
 *
 * So: walk the runtime module graph from the main thread's entry points —
 * following relative imports and `@omni/*` workspace imports into their
 * sources — and fail if it reaches any worker-only module. `new Worker(new
 * URL("./worker.ts", …))` is not an import, so the spawn helper does not pull
 * the worker in. `Bun.Transpiler.scanImports` drops type-only imports, which
 * is right: a type crosses no thread.
 *
 * A positive control walks the worker entry and must reach every one of them,
 * so a walk that silently stopped resolving would fail here rather than pass.
 */

const ROOT = resolve(import.meta.dir, "../../../..");
const SRC = join(ROOT, "apps/gateway/src");

/** Reachable only from the worker. */
const WORKER_ONLY = [
  "apps/gateway/src/export/backoff.ts",
  "apps/gateway/src/export/batch.ts",
  "apps/gateway/src/export/deliver.ts",
  "apps/gateway/src/export/encoders/elasticsearch.ts",
  "apps/gateway/src/export/encoders/otlp.ts",
  "apps/gateway/src/export/encoders/webhook.ts",
  "apps/gateway/src/export/gap.ts",
  "apps/gateway/src/export/loop.ts",
  "apps/gateway/src/export/record.ts",
  "apps/gateway/src/export/state.ts",
  "apps/gateway/src/export/state/postgres.ts",
  "apps/gateway/src/export/state/sql.ts",
  "apps/gateway/src/export/state/sqlite.ts",
  "apps/gateway/src/export/transport.ts",
  "packages/store/src/exportReader.ts",
];

/** What the main thread may import from `export/`. */
const MAIN_ENTRIES = ["apps/gateway/src/index.ts", "apps/gateway/src/export/spawn.ts"];

test("body sealing and the writer entry stay off the main-thread graph", () => {
  for (const entry of [...MAIN_ENTRIES, "apps/gateway/src/bodies/spawn.ts"]) {
    const graph = graphOf(entry);
    expect(graph.has("apps/gateway/src/bodies/seal.ts")).toBe(false);
    expect(graph.has("apps/gateway/src/bodies/writer.ts")).toBe(false);
  }
  expect(graphOf("apps/gateway/src/bodies/writer.ts").has("apps/gateway/src/bodies/seal.ts")).toBe(
    true,
  );
});

function graphOf(entry: string): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const record of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const spec = record.path;
      if (spec.startsWith("bun:") || spec.startsWith("node:") || spec === "bun") continue;
      if (!spec.startsWith(".") && !spec.startsWith("@omni/")) continue;
      let target: string;
      try {
        target = spec.startsWith(".")
          ? resolve(dirname(file), spec)
          : Bun.resolveSync(spec, dirname(file));
      } catch {
        continue;
      }
      if (target.includes("/node_modules/") || !target.startsWith(ROOT)) continue;
      if (!/\.(ts|tsx)$/.test(target)) continue;
      walk(target);
    }
  };
  walk(join(ROOT, entry));
  return new Set([...seen].map((file) => relative(ROOT, file)));
}

test("the worker entry reaches every worker-only module (the walk works)", () => {
  const graph = graphOf("apps/gateway/src/export/worker.ts");
  for (const module of WORKER_ONLY) expect(graph.has(module)).toBe(true);
});

test("the main thread's module graph reaches no worker-only module", () => {
  for (const entry of MAIN_ENTRIES) {
    const graph = graphOf(entry);
    expect(graph.has(entry)).toBe(true);
    expect(graph.has("apps/gateway/src/export/worker.ts")).toBe(false);
    expect(WORKER_ONLY.filter((module) => graph.has(module))).toEqual([]);
  }
});

test("outside export/, nothing in the gateway imports an export module but spawn and protocol", () => {
  const glob = new Bun.Glob("**/*.ts");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const offenders: string[] = [];
  for (const file of glob.scanSync(SRC)) {
    if (file.startsWith("export/")) continue;
    for (const record of transpiler.scanImports(readFileSync(join(SRC, file), "utf8"))) {
      const spec = record.path;
      if (spec === "@omni/store/exportReader") offenders.push(`${file} → ${spec}`);
      if (!spec.includes("export/")) continue;
      const target = relative(SRC, resolve(SRC, dirname(file), spec));
      if (target !== "export/spawn.ts" && target !== "export/protocol.ts") {
        offenders.push(`${file} → ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
