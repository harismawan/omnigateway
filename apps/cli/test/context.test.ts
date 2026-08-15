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

/** The ambient environment of a checkout: Bun preloads the repository's .env. */
const AMBIENT = {
  OMNI_ENCRYPTION_KEY: "ambient-key-0123456789",
  OMNI_DB_PATH: "/home/operator/.config/omnigateway/omnigateway.db",
};

test("an ambient OMNI_DB_PATH never follows --root into another installation", () => {
  // The incident: `omni --root /tmp/x settings set …` run from the repository
  // wrote to the operator's real database, because Bun had preloaded the
  // repository's .env and the temp root had no .env to displace it. The flag
  // names the installation; an absolute path from somewhere else cannot outrank
  // it, or --root selects a root and a stranger selects its data.
  const dir = tempDir();

  const ctx = createContext(parse(["--root", dir]), { env: { ...AMBIENT }, cwd: "/cwd" });

  expect(ctx.databasePath).toBe(join(dir, "omnigateway.db"));
  expect(ctx.databasePath).not.toBe(AMBIENT.OMNI_DB_PATH);
  // Whatever the CLI refused to obey, a gateway it starts must refuse too.
  expect(ctx.env.OMNI_DB_PATH).toBeUndefined();
});

test("suppressing an ambient OMNI_DB_PATH is said out loud, naming both paths", () => {
  const dir = tempDir();

  const ctx = createContext(parse(["--root", dir]), { env: { ...AMBIENT }, cwd: "/cwd" });

  expect(ctx.warnings).toHaveLength(1);
  expect(ctx.warnings[0]).toContain(AMBIENT.OMNI_DB_PATH);
  expect(ctx.warnings[0]).toContain(join(dir, "omnigateway.db"));
  expect(ctx.warnings[0]).toContain("--root");
});

test("a root's own .env still outranks an ambient OMNI_DB_PATH, silently", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, ".env"),
    "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef\nOMNI_DB_PATH=/srv/omni/omnigateway.db",
  );

  const ctx = createContext(parse(["--root", dir]), { env: { ...AMBIENT }, cwd: "/cwd" });

  // The root spoke for itself, so nothing was ignored and there is nothing to
  // warn about.
  expect(ctx.databasePath).toBe("/srv/omni/omnigateway.db");
  expect(ctx.warnings).toEqual([]);
});

test("a relative OMNI_DB_PATH in a root's .env still resolves against that root", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, ".env"),
    "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef\nOMNI_DB_PATH=./data/omnigateway.db",
  );

  const ctx = createContext(parse(["--root", dir]), { env: { ...AMBIENT }, cwd: "/cwd" });

  expect(ctx.databasePath).toBe(join(dir, "data", "omnigateway.db"));
  expect(ctx.warnings).toEqual([]);
});

test("--db still outranks everything, including an ambient path under --root", () => {
  const dir = tempDir();

  const ctx = createContext(parse(["--root", dir, "--db", "/tmp/chosen.db"]), {
    env: { ...AMBIENT },
    cwd: "/cwd",
  });

  expect(ctx.databasePath).toBe("/tmp/chosen.db");
  expect(ctx.warnings).toEqual([]);
});

test("without --root an ambient OMNI_DB_PATH is still obeyed", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef");

  // The cwd holds an installation, so the root is not an explicit statement and
  // the environment is the only thing that spoke about the database.
  const ctx = createContext(parse([]), { env: { ...AMBIENT }, cwd: dir });

  expect(ctx.root.source).toBe("cwd");
  expect(ctx.databasePath).toBe(AMBIENT.OMNI_DB_PATH);
  expect(ctx.warnings).toEqual([]);
});

test("OMNI_ROOT and an ambient OMNI_DB_PATH are the same tier, so neither is refused", () => {
  const dir = tempDir();

  const ctx = createContext(parse([]), { env: { ...AMBIENT, OMNI_ROOT: dir }, cwd: "/cwd" });

  expect(ctx.root.source).toBe("env");
  expect(ctx.databasePath).toBe(AMBIENT.OMNI_DB_PATH);
  expect(ctx.warnings).toEqual([]);
});

test("a blank --db reads as an absent flag, not as the root directory itself", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef");

  // `omni --db "$DB"` with an unset variable is a shell handing us "", and an
  // empty configured path resolves to the root *directory*, which the store
  // then tries to open as a database file.
  for (const blank of ["", "   "]) {
    const ctx = createContext(parse(["--root", dir, "--db", blank]), { env: {}, cwd: "/cwd" });
    expect(ctx.databasePath).toBe(join(dir, "omnigateway.db"));
  }
});

test("a --db value of 0 is still a path, not a blank", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "OMNI_ENCRYPTION_KEY=root-key-0123456789abcdef");

  const ctx = createContext(parse(["--root", dir, "--db", "0"]), { env: {}, cwd: "/cwd" });
  expect(ctx.databasePath).toBe(join(dir, "0"));
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
