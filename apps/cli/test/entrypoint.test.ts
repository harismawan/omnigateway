import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayEntrypoint } from "../src/runtime.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omni-entry-"));
}

/** A root laid out like a checkout: the gateway is source under apps/. */
function checkout(root: string): string {
  const path = join(root, "apps", "gateway", "src", "index.ts");
  mkdirSync(join(root, "apps", "gateway", "src"), { recursive: true });
  writeFileSync(path, "// gateway\n");
  return path;
}

/** A published layout: bin/omni.js and gateway.js are siblings. */
function published(dir: string): { cliDir: string; gateway: string } {
  const cliDir = join(dir, "bin");
  mkdirSync(cliDir, { recursive: true });
  const gateway = join(dir, "gateway.js");
  writeFileSync(gateway, "// bundled gateway\n");
  return { cliDir, gateway };
}

test("a checkout runs its own gateway source", () => {
  const root = tempDir();
  const source = checkout(root);

  expect(gatewayEntrypoint(root, join(tempDir(), "bin"))).toBe(source);
});

test("an installed package runs the server bundled beside its CLI", () => {
  const root = tempDir();
  const { cliDir, gateway } = published(tempDir());

  expect(gatewayEntrypoint(root, cliDir)).toBe(gateway);
});

test("a checkout wins over the bundled server", () => {
  // The root names the installation being managed. If it holds source, that is
  // the code the operator means — not whatever version happens to be installed.
  const root = tempDir();
  const source = checkout(root);
  const { cliDir } = published(tempDir());

  expect(gatewayEntrypoint(root, cliDir)).toBe(source);
});

test("a root with neither has no gateway to run", () => {
  expect(gatewayEntrypoint(tempDir(), join(tempDir(), "bin"))).toBeNull();
});
