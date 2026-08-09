import { describe, expect, test } from "bun:test";
import { formatLine, type LogLevel } from "@omni/ir";
import {
  type ConsoleDeps,
  type ConsoleSource,
  readConsole,
  resolveConsoleSource,
  UNIT_NAME,
} from "../src/console.ts";

const AT = Date.parse("2026-08-09T04:12:03.114Z");

function line(level: LogLevel, msg: string, offsetMs = 0): string {
  return formatLine(level, AT + offsetMs, msg, undefined, false);
}

/** A reader over a fake filesystem and a fake `journalctl`. */
function deps(input: { files?: Record<string, string>; journal?: string } = {}): ConsoleDeps & {
  argv: string[][];
} {
  const argv: string[][] = [];
  return {
    argv,
    readFile: (path) => input.files?.[path] ?? null,
    run: async (args) => {
      argv.push([...args]);
      return { code: 0, stdout: input.journal ?? "", stderr: "" };
    },
  };
}

describe("resolveConsoleSource", () => {
  test("prefers an explicit log file over an installed unit", () => {
    expect(
      resolveConsoleSource({ logFile: "/var/log/omni.log", unitInstalled: true, scope: "user" }),
    ).toEqual({ kind: "file", path: "/var/log/omni.log" });
  });

  test("falls back to the journal when a unit is installed", () => {
    expect(resolveConsoleSource({ unitInstalled: true, scope: "system" })).toEqual({
      kind: "journal",
      unit: UNIT_NAME,
      scope: "system",
    });
  });

  test("reports that nothing captured stdout, which is the dev case and not an error", () => {
    expect(resolveConsoleSource({ unitInstalled: false, scope: "user" })).toEqual({ kind: "none" });
  });

  test("treats a blank OMNI_LOG_FILE as unset", () => {
    expect(resolveConsoleSource({ logFile: "   ", unitInstalled: false, scope: "user" })).toEqual({
      kind: "none",
    });
  });
});

describe("readConsole from a file", () => {
  const source: ConsoleSource = { kind: "file", path: "/tmp/gateway.log" };
  const contents = [line("info", "a"), line("warn", "b"), line("error", "c")].join("\n");

  test("returns the tail, newest last, and names the file it read", async () => {
    const read = await readConsole(deps({ files: { "/tmp/gateway.log": contents } }), source, {
      lines: 2,
    });
    expect(read.source).toBe("file");
    expect(read.path).toBe("/tmp/gateway.log");
    expect(read.lines.map((l) => l.msg)).toEqual(["b", "c"]);
  });

  test("reads an absent file as empty rather than throwing", async () => {
    const read = await readConsole(deps(), source, { lines: 10 });
    expect(read.lines).toEqual([]);
    expect(read.path).toBe("/tmp/gateway.log");
  });

  test("drops blank lines, which a trailing newline always produces", async () => {
    const read = await readConsole(
      deps({ files: { "/tmp/gateway.log": `${contents}\n\n` } }),
      source,
      { lines: 10 },
    );
    expect(read.lines).toHaveLength(3);
  });

  test("filters to a level and above", async () => {
    const read = await readConsole(deps({ files: { "/tmp/gateway.log": contents } }), source, {
      lines: 10,
      level: "warn",
    });
    expect(read.lines.map((l) => l.msg)).toEqual(["b", "c"]);
  });

  test("returns only what is newer than `since`", async () => {
    const contents = [line("info", "old", 0), line("info", "new", 1_000)].join("\n");
    const read = await readConsole(deps({ files: { "/tmp/gateway.log": contents } }), source, {
      lines: 10,
      since: AT,
    });
    expect(read.lines.map((l) => l.msg)).toEqual(["new"]);
  });

  test("applies the tail after filtering, so a level filter still fills the page", async () => {
    const contents = [
      line("info", "a"),
      line("error", "b"),
      line("info", "c"),
      line("error", "d"),
    ].join("\n");
    const read = await readConsole(deps({ files: { "/tmp/gateway.log": contents } }), source, {
      lines: 2,
      level: "error",
    });
    expect(read.lines.map((l) => l.msg)).toEqual(["b", "d"]);
  });
});

describe("readConsole from the journal", () => {
  const source: ConsoleSource = { kind: "journal", unit: UNIT_NAME, scope: "user" };

  test("asks journalctl for the unit, with --user under a user-scope unit", async () => {
    const d = deps({ journal: line("info", "a") });
    await readConsole(d, source, { lines: 25 });
    expect(d.argv[0]).toEqual(["journalctl", "--user", "-u", UNIT_NAME, "-n", "25", "--no-pager"]);
  });

  test("omits --user for a system unit", async () => {
    const d = deps({ journal: "" });
    await readConsole(d, { kind: "journal", unit: UNIT_NAME, scope: "system" }, { lines: 5 });
    expect(d.argv[0]).not.toContain("--user");
  });

  test("keeps a line the gateway did not write, since that is often the crash", async () => {
    const foreign = "Aug 09 04:12:03 host systemd[1]: Started omnigateway.service.";
    const d = deps({ journal: [foreign, line("info", "omnigateway booting")].join("\n") });
    const read = await readConsole(d, source, { lines: 10 });
    expect(read.lines.map((l) => l.raw)).toEqual([foreign, line("info", "omnigateway booting")]);
    expect(read.lines[0]).toMatchObject({ at: null, level: null, msg: null });
  });

  test("keeps an unparsable line through a level filter rather than swallowing it", async () => {
    const foreign = "systemd[1]: omnigateway.service: Main process exited, code=dumped";
    const d = deps({ journal: [foreign, line("info", "quiet")].join("\n") });
    const read = await readConsole(d, source, { lines: 10, level: "error" });
    expect(read.lines.map((l) => l.raw)).toEqual([foreign]);
  });

  test("reports no path, because the journal is not a file the operator can open", async () => {
    const read = await readConsole(deps({ journal: "" }), source, { lines: 10 });
    expect(read.source).toBe("journal");
    expect(read.path).toBeUndefined();
  });

  test("reads a failed journalctl as empty rather than throwing", async () => {
    const d: ConsoleDeps = {
      readFile: () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "No journal files were found." }),
    };
    const read = await readConsole(d, source, { lines: 10 });
    expect(read.lines).toEqual([]);
  });
});

describe("readConsole with no source", () => {
  test("returns nothing, and does not shell out or touch the disk", async () => {
    const d = deps({ journal: "should not be read" });
    const read = await readConsole(d, { kind: "none" }, { lines: 10 });
    expect(read).toEqual({ source: "none", lines: [] });
    expect(d.argv).toEqual([]);
  });
});
