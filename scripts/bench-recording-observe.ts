#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync } from "node:fs";

const out = process.argv[2];
if (!out) throw Error("output directory required");
mkdirSync(out, { recursive: true });
const upstream = Bun.spawn(
  [
    "taskset",
    "-c",
    "4-5",
    process.execPath,
    `${import.meta.dir}/bench-gateway-upstream.ts`,
    "--matrix",
    "--port",
    "18129",
  ],
  { stdout: "ignore", stderr: "inherit" },
);
try {
  await Bun.sleep(500);
  for (const c of [64, 1])
    for (const round of [1, 2, 3])
      for (const recording of round % 2 ? [false, true] : [true, false]) {
        const prefix = `${out}/${c}-${round}-${recording ? "on" : "off"}`,
          db = `${prefix}.db`;
        const start = performance.now();
        let reportAt = 0;
        const observations: { ms: number; bytes: number | null }[] = [];
        let running = true;
        const proc = Bun.spawn(
          [
            "taskset",
            "-c",
            "6-7",
            "oha",
            "--no-tui",
            "--output-format",
            "json",
            "-w",
            "-z",
            "4s",
            "-c",
            String(c),
            "-m",
            "POST",
            "-H",
            "content-type: application/json",
            "-d",
            '{"model":"mock-c1-d0","stream":true}',
            ...(recording ? ["--db-url", db] : []),
            "--output",
            `${prefix}.report.json`,
            "http://127.0.0.1:18129/v1/chat/completions",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const poll = (async () => {
          while (running) {
            observations.push({
              ms: performance.now() - start,
              bytes: existsSync(db) ? statSync(db).size : null,
            });
            await Bun.sleep(100);
          }
        })();
        let report: unknown;
        while (report === undefined) {
          try {
            report = await Bun.file(`${prefix}.report.json`).json();
            reportAt = performance.now() - start;
          } catch {
            await Bun.sleep(5);
          }
        }
        const code = await proc.exited;
        const exitAt = performance.now() - start;
        running = false;
        await poll;
        await Bun.write(
          `${prefix}.json`,
          JSON.stringify(
            { c, round, recording, reportAt, exitAt, code, observations, report },
            null,
            2,
          ),
        );
      }
} finally {
  upstream.kill();
  await upstream.exited;
}
