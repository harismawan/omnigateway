import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifest } from "./bench-manifest";

test("manifest refuses absent and incomplete rounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  try {
    await expect(checkManifest(dir)).rejects.toThrow("missing");
    await Bun.write(
      `${dir}/manifest.json`,
      JSON.stringify({ expected: ["1.json", "2.json"], present: ["1.json"] }),
    );
    await Bun.write(`${dir}/1.json`, "{}");
    await expect(checkManifest(dir)).rejects.toThrow("incomplete");
    await Bun.write(`${dir}/2.json`, "{}");
    await Bun.write(
      `${dir}/manifest.json`,
      JSON.stringify({ expected: ["1.json", "2.json"], present: ["1.json", "2.json"] }),
    );
    await checkManifest(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
