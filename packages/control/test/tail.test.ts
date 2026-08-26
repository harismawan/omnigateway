import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists, fileSize, readFrom, tailFile } from "../src/tail.ts";

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

describe("readFrom", () => {
  test("returns null for a file that does not exist", () => {
    expect(readFrom(join(tmpdir(), "omni-tail-absent", "nope.log"), 0)).toBeNull();
  });

  test("reads from the offset to the end, and reports where to resume", () => {
    const path = scratch("forward.log", "a\nb\n");
    const first = readFrom(path, 0);
    expect(first).toEqual({ text: "a\nb\n", offset: 4, gap: false });

    appendFileSync(path, "c\n");
    // The delta, not the tail. A reader that took the last N lines instead
    // would repeat everything it had already shown.
    expect(readFrom(path, first?.offset ?? 0)).toEqual({ text: "c\n", offset: 6, gap: false });
  });

  test("reads nothing at the end of a file, which is not a gap", () => {
    const path = scratch("quiet.log", "a\n");
    expect(readFrom(path, 2)).toEqual({ text: "", offset: 2, gap: false });
  });

  test("reports a gap and restarts at zero when the file shrank below the offset", () => {
    const path = scratch("rotated.log", "one\ntwo\nthree\n");
    const before = readFrom(path, 0);
    expect(before?.gap).toBe(false);

    // Truncated in place, or rotated away and replaced. Either way the bytes at
    // the offset held are not the bytes that were there.
    writeFileSync(path, "fresh\n");
    expect(readFrom(path, before?.offset ?? 0)).toEqual({ text: "fresh\n", offset: 6, gap: true });
  });

  test("reports a gap for a file that shrank to nothing, rather than reading past its end", () => {
    const path = scratch("emptied.log", "one\ntwo\n");
    writeFileSync(path, "");
    // No bytes to hand back, but the reader still lost its place, and a caller
    // told otherwise would go on believing its buffer continues this file.
    expect(readFrom(path, 8)).toEqual({ text: "", offset: 0, gap: true });
  });

  test("reports a gap rather than allocating a delta larger than the ceiling", () => {
    // 9 MiB written between two reads — a caller that stopped polling, or a
    // burst nothing coalesced. The head is skipped rather than allocated, and
    // saying so is what stops the skip being silent.
    const path = scratch("flood.log", `${"x".repeat(1023)}\n`.repeat(9 * 1024));
    const read = readFrom(path, 0);

    expect(read?.gap).toBe(true);
    expect(read?.text.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(read?.offset).toBe(9 * 1024 * 1024);
    // The end of the file is what survives, never the beginning.
    expect(read?.text.endsWith("x\n")).toBe(true);
  });
});

describe("fileSize", () => {
  test("is the byte count of a regular file, and null for anything else", () => {
    expect(fileSize(scratch("sized.log", "abcd"))).toBe(4);
    expect(fileSize(join(tmpdir(), "omni-tail-absent", "nope.log"))).toBeNull();
    expect(fileSize(tmpdir())).toBeNull();
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
