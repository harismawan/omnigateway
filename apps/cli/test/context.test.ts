import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/args.ts";
import { createContext, parseEnvFile, resolveRoot } from "../src/context.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omni-root-"));
}

test("an explicit --root wins over everything else", () => {
  const dir = tempDir();
  const resolution = resolveRoot({ root: dir }, { OMNI_ROOT: "/elsewhere" }, "/cwd");
  expect(resolution).toMatchObject({ root: dir, source: "flag" });
});

test("OMNI_ROOT is used when no flag is given", () => {
  const dir = tempDir();
  expect(resolveRoot({}, { OMNI_ROOT: dir }, "/cwd")).toMatchObject({ root: dir, source: "env" });
});

test("the current directory is used only when it holds an installation", () => {
  const dir = tempDir();
  expect(resolveRoot({}, {}, dir)).toMatchObject({ source: "default" });

  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=x");
  expect(resolveRoot({}, {}, dir)).toMatchObject({ root: dir, source: "cwd" });
});

test("a root's .env file is reported when it exists", () => {
  const dir = tempDir();
  expect(resolveRoot({ root: dir }, {}, "/cwd").envFile).toBeNull();

  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=x");
  expect(resolveRoot({ root: dir }, {}, "/cwd").envFile).toBe(join(dir, ".env"));
});

test("env files accept comments, export prefixes, and quotes", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      "OMNI_PORT=9000",
      "export OMNI_HOST=0.0.0.0",
      'OMNI_BASE_URL="https://gw.example"',
      "MALFORMED",
    ].join("\n"),
  );

  expect(parsed).toEqual({
    OMNI_PORT: "9000",
    OMNI_HOST: "0.0.0.0",
    OMNI_BASE_URL: "https://gw.example",
  });
});

test("the root's .env wins over an ambient value for the same key", () => {
  // Bun loads the *current directory's* .env into the environment before this
  // process starts, so an ambient key routinely belongs to a different
  // installation than the one --root names.
  const dir = tempDir();
  writeFileSync(
    join(dir, ".env"),
    "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef\nOMNI_DB_PATH=root.db",
  );

  const ctx = createContext(parse(["--root", dir]), {
    env: { OMNI_ENCRYPTION_KEY: "ambient-key-0123456789", OMNI_DB_PATH: "ambient.db" },
    cwd: "/cwd",
  });

  expect(ctx.config().encryptionKey).toBe("root-key-0123456789abcdef");
  expect(ctx.databasePath).toBe(join(dir, "root.db"));
});

test("--db overrides the configured database path", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef");

  const ctx = createContext(parse(["--root", dir, "--db", "other.db"]), { env: {}, cwd: "/cwd" });
  expect(ctx.databasePath).toBe(join(dir, "other.db"));
});

test("a missing encryption key is reported rather than thrown at construction", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "empty"), { recursive: true });

  const ctx = createContext(parse(["--root", join(dir, "empty")]), { env: {}, cwd: "/cwd" });
  expect(ctx.configError).toMatch(/OMNI_ENCRYPTION_KEY/);
  expect(() => ctx.config()).toThrow(/OMNI_ENCRYPTION_KEY/);
});

test("NO_COLOR disables colour even on a terminal", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef");

  const ctx = createContext(parse(["--root", dir]), {
    env: { NO_COLOR: "1" },
    cwd: "/cwd",
    isTty: true,
  });
  expect(ctx.color).toBe(false);
});
