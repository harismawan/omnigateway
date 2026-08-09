import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists, tailFile } from "../src/tail.ts";

function scratch(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "omni-tail-")), name);
  writeFileSync(path, contents);
  return path;
}

describe("tailFile", () => {
  test("returns null for a file that does not exist", () => {
    expect(tailFile(join(tmpdir(), "omni-tail-absent", "nope.log"), 10)).toBeNull();
  });

  test("returns an empty string for an empty file, which is not the same as absent", () => {
    expect(tailFile(scratch("empty.log", ""), 10)).toBe("");
  });

  test("returns the whole of a file shorter than the request", () => {
    const path = scratch("short.log", "a\nb\nc\n");
    expect(tailFile(path, 100)).toBe("a\nb\nc\n");
  });

  test("always includes the end of the file", () => {
    // A file smaller than one chunk comes back whole, which is correct and
    // cheap; what matters is that the newest lines are never the ones dropped.
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const tail = tailFile(scratch("long.log", `${lines}\n`), 5) ?? "";

    expect(tail).toContain("line-499");
    expect(tail.trimEnd().endsWith("line-499")).toBe(true);
  });

  test("does not read the whole of a large file to return its tail", () => {
    // 8 MiB of padding ahead of the interesting part. A reader that slurped
    // the file would return all of it; this one seeks from the end.
    const padding = `${"x".repeat(1024)}\n`.repeat(8 * 1024);
    const path = scratch("big.log", `${padding}needle-at-the-end\n`);

    const tail = tailFile(path, 2) ?? "";
    expect(tail).toContain("needle-at-the-end");
    expect(tail.length).toBeLessThan(1024 * 1024);
  });

  test("survives a line longer than one chunk", () => {
    const path = scratch("wide.log", `${"y".repeat(200_000)}\nlast\n`);
    expect(tailFile(path, 1) ?? "").toContain("last");
  });
});

describe("fileExists", () => {
  test("is true for a regular file and false for anything else", () => {
    expect(fileExists(scratch("here.log", "x"))).toBe(true);
    expect(fileExists(join(tmpdir(), "omni-tail-absent", "nope.log"))).toBe(false);
    // A directory is not a log file, and reading one would throw.
    expect(fileExists(tmpdir())).toBe(false);
  });
});
