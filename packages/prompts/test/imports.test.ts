import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bareImportsOf,
  type ForbiddenImport,
  forbiddenImportsIn,
} from "../../../scripts/lib/imports.ts";

test("prompt sources stay pure and the catalog stays a leaf", () => {
  const forbidden: ForbiddenImport[] = [
    { pattern: /^(?:node:|bun(?::|$))/, why: "no runtime I/O", alsoTypeOnly: true },
    {
      pattern: /^@omni\/(?:store|router|control|providers|coord)(?:\/|$)/,
      why: "pure transforms only",
      alsoTypeOnly: true,
    },
  ];
  const result = forbiddenImportsIn(resolve(import.meta.dir, "../src"), forbidden);
  expect(result.files.length).toBeGreaterThanOrEqual(3);
  expect(result.violations).toEqual([]);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const file of result.files) {
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...transpiler.scanImports(source).map((record) => record.path),
      ...[...source.matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1] ?? ""),
    ];
    expect(specifiers.filter((specifier) => specifier.startsWith("../"))).toEqual([]);
    if (file.endsWith("/catalog.ts")) {
      expect(specifiers).toEqual([]);
      expect(bareImportsOf(file).any).toEqual([]);
    }
  }
});
