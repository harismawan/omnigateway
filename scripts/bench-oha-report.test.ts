import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOhaReport } from "./bench-oha-report";

test("complete report file sampled before process exit", async () => {
  const path = join(tmpdir(), `oha-report-${crypto.randomUUID()}.json`);
  let exit: (n: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  let observed = false;
  try {
    await Bun.write(path, '{"summary":');
    const pending = readOhaReport(path, exited, () => {
      observed = true;
    });
    await Bun.sleep(10);
    expect(observed).toBe(false);
    await Bun.write(path, '{"summary":{"total":2}}');
    await pending;
    expect(observed).toBe(true);
  } finally {
    exit(0);
    rmSync(path, { force: true });
  }
});
