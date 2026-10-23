import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../lib/subprocess.ts";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omni subprocess "));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("synchronous script subprocesses", () => {
  test("returns UTF-8 text without trimming and preserves literal argv and cwd", () => {
    const root = scratch();
    const out = runSync(
      [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify([process.cwd(), ...process.argv.slice(1)]) + '\\n雪🦕\\n')",
        "two words",
        "$(echo unsafe); * ' \"",
      ],
      { cwd: root },
    );
    expect(out).toBe(`${JSON.stringify([root, "two words", "$(echo unsafe); * ' \""])}\n雪🦕\n`);
  });

  test("ignored stdin reaches EOF instead of inheriting the caller's input", () => {
    expect(
      runSync([process.execPath, "-e", "console.log(require('node:fs').readFileSync(0).length)"], {
        cwd: scratch(),
      }),
    ).toBe("0\n");
  });

  test("consumes the full previous 64 MiB output allowance including Unicode", () => {
    const out = runSync(
      [process.execPath, "-e", "process.stdout.write('雪'.repeat(22369621) + '!')"],
      { cwd: scratch(), maxBuffer: 64 * 1024 * 1024 },
    );
    expect(Buffer.byteLength(out)).toBe(64 * 1024 * 1024);
    expect(out.length).toBe(22369622);
    expect(out.startsWith("雪雪")).toBe(true);
    expect(out.endsWith("雪!")).toBe(true);
  });

  test("nonzero exit throws rather than returning partial stdout", () => {
    expect(() =>
      runSync([process.execPath, "-e", "process.stdout.write('partial'); process.exit(7)"], {
        cwd: scratch(),
      }),
    ).toThrow(/7/);
  });

  test("output beyond 64 MiB throws instead of returning a truncated success", () => {
    expect(() =>
      runSync([process.execPath, "-e", "process.stdout.write('x'.repeat(64 * 1024 * 1024 + 1))"], {
        cwd: scratch(),
        maxBuffer: 64 * 1024 * 1024,
      }),
    ).toThrow();
  });

  test("the default 1 MiB budget accepts the exact boundary", () => {
    const out = runSync([process.execPath, "-e", "process.stdout.write('x'.repeat(1024 * 1024))"], {
      cwd: scratch(),
    });
    expect(out.length).toBe(1024 * 1024);
  });

  test("the default 1 MiB budget rejects one extra byte", () => {
    expect(() =>
      runSync([process.execPath, "-e", "process.stdout.write('x'.repeat(1024 * 1024 + 1))"], {
        cwd: scratch(),
      }),
    ).toThrow();
  });

  test("64 MiB overflow throws even when the child handles SIGTERM and exits zero", () => {
    expect(() =>
      runSync(
        [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('x'.repeat(64 * 1024 * 1024 + 1)); setInterval(() => {}, 1000)",
        ],
        { cwd: scratch(), maxBuffer: 64 * 1024 * 1024 },
      ),
    ).toThrow();
  });

  test("signal termination throws rather than returning partial stdout", () => {
    expect(() =>
      runSync([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], { cwd: scratch() }),
    ).toThrow(/SIGTERM/);
  });

  test("a missing executable throws", () => {
    const root = scratch();
    expect(() => runSync([join(root, "not-an-executable")], { cwd: root })).toThrow();
  });

  test("a missing working directory throws", () => {
    expect(() =>
      runSync([process.execPath, "-e", "console.log('wrong cwd')"], {
        cwd: join(scratch(), "missing"),
      }),
    ).toThrow();
  });

  test("stderr is forwarded on success and failure unless explicitly ignored", () => {
    const root = scratch();
    const helper = join(import.meta.dir, "../lib/subprocess.ts");
    for (const [exitCode, quiet, wantStderr] of [
      [0, false, "diagnostic\n"],
      [0, true, ""],
      [7, false, "diagnostic\n"],
      [7, true, ""],
    ] as const) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { runSync } from ${JSON.stringify(helper)};
           try { runSync([process.execPath, '-e', ${JSON.stringify(`console.error('diagnostic'); process.exit(${exitCode})`)}],
             {cwd: ${JSON.stringify(root)}, stderr: ${JSON.stringify(quiet ? "ignore" : "pipe")}}); }
           catch { process.exit(23); }`,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(exitCode === 0 ? 0 : 23);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe(wantStderr);
    }
  });
});
