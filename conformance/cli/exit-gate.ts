import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { assertCoversFrozenLoader, configDiagnostic } from "./config-diagnostics.ts";

const pending: Promise<void>[] = [];
const observed: Record<string, number> = {};
// Explicit wrapper, rather than monkeypatching Bun.spawn (which Bun optimizes).
export function goldenSpawn(argv: string[], options: Bun.SpawnOptions.OptionsObject) {
  const child = Bun.spawn(argv, options);
  if (!argv.some((a) => /(?:index|setup-seam|password-seam)\.ts$/.test(a))) return child;
  const [out, auditOut] = child.stdout.tee();
  const [err, auditErr] = child.stderr.tee();
  pending.push(
    (async () => {
      let stdout = await new Response(auditOut).text();
      const stderr = await new Response(auditErr).text();
      let code = await child.exited;
      if (argv.some((a) => a.endsWith("/pty.py"))) {
        const nested = JSON.parse(stdout);
        code = nested.code;
        stdout = Buffer.from(nested.bytes, "hex").toString();
      }
      const key = `exit ${code}`;
      observed[key] = (observed[key] ?? 0) + 1;
      for (const line of (stderr + stdout).split(/\r?\n/)) {
        const kind =
          configDiagnostic(line) ??
          line.match(/ENOENT(?=:)|EACCES(?=:)|unable to open database|database is locked/)?.[0];
        if (kind !== undefined) {
          const key = `environment ${kind}`;
          observed[key] = (observed[key] ?? 0) + 1;
        }
      }
    })(),
  );
  return {
    stdout: out,
    stderr: err,
    stdin: child.stdin,
    exited: child.exited,
    pid: child.pid,
    kill: child.kill.bind(child),
  };
}
export async function verifyGoldenExits(suite: string) {
  await Promise.all(pending);
  console.log(`EXIT HISTOGRAM ${suite} ${JSON.stringify(observed)}`);
  assertCoversFrozenLoader();
  if (process.env.OMNI_RECORD_HISTOGRAM === "1") return;
  const pinned = JSON.parse(
    readFileSync(new URL("./exit-histograms.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(observed, pinned[suite], `${suite}: frozen exits/environment failures changed`);
}
