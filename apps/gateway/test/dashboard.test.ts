import { expect, test } from "bun:test";
import { resolve } from "node:path";

const dashboardDirectory = resolve(import.meta.dir, "../../dashboard");

test("dashboard tests pass in an isolated DOM process", async () => {
  const process = Bun.spawn(["bun", "run", "test"], {
    cwd: dashboardDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  const output = `${stdout}${stderr}`;
  if (exitCode !== 0) {
    throw new Error(`Dashboard test process failed with exit code ${exitCode}\n${output}`);
  }

  console.log(output.trim());
  expect(output).toContain("15 pass");
  expect(output).toContain("0 fail");
});
