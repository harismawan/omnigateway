/** Synchronous argv-only execution for repository checks; never invokes a shell. */
export function runSync(
  argv: string[],
  options: { cwd: string; stderr?: "pipe" | "ignore"; maxBuffer?: number },
): string {
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: options.stderr ?? "pipe",
    // Preserve execFileSync's default; large diff/blob callers opt into 64 MiB.
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  // Bun's execFileSync forwards stderr on success too; quiet callers opt out.
  if (result.stderr?.length) process.stderr.write(result.stderr);
  if (!result.success || result.exitedDueToMaxBuffer) {
    throw new Error(`${argv[0]} failed (${result.signalCode ?? result.exitCode})`);
  }
  return result.stdout.toString("utf8");
}
