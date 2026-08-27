import { expect, test } from "bun:test";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

/**
 * Reads `PROFILES` and `BODY_ORDER` in a fresh process under a given environment.
 *
 * A subprocess rather than a mutated `Bun.env`, because both tables are built at
 * module scope: by the time a test could set a variable, the module has already
 * read it, and re-importing gets the cached instance.
 *
 * The entry point imports `body.ts` **before** `profile.ts` deliberately. That is
 * the order `<id>/index.ts` uses, and module initialisation order is exactly what
 * this file exists to protect.
 */
async function readUnderEnv(env: Record<string, string>): Promise<{
  anthropicOrder: string[];
  kiloBodyOrderLength: number;
}> {
  const entry = resolve(SRC, "../test/fixtures/profileProbe.ts");
  const proc = Bun.spawn(["bun", entry], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Surfaced rather than swallowed: the failure this guards against is a module
  // that throws on import, and an empty stdout alone would not say why.
  expect({ code, err }).toEqual({ code: 0, err: "" });
  return JSON.parse(out);
}

test("header order is the profile's own when no override is set", async () => {
  const read = await readUnderEnv({});
  expect(read.anthropicOrder.length).toBeGreaterThan(0);
  expect(read.anthropicOrder).not.toEqual(["x-one", "x-two"]);
  expect(read.kiloBodyOrderLength).toBeGreaterThan(0);
});

/**
 * The regression this file was added for.
 *
 * `env`, `envOrNull` and `envOrder` all test the value against a module-scope
 * regex, and they return their fallback **before** touching it when the variable
 * is unset. So a module-initialisation cycle involving that regex fails only on
 * installations that set an `OMNI_ORDER_*` variable: the whole suite stays green
 * while every operator who configures a header order gets a gateway that will
 * not boot.
 *
 * That is not hypothetical — it is what an intermediate arrangement of these
 * modules actually did, and no existing test saw it.
 */
test("an OMNI_ORDER_* override is applied, and importing under one still works", async () => {
  const read = await readUnderEnv({ OMNI_ORDER_ANTHROPIC: "x-one,x-two" });
  expect(read.anthropicOrder).toEqual(["x-one", "x-two"]);
});

test("a malformed override falls back rather than failing the import", async () => {
  // Names outside the printable-ASCII range the safety regex allows, so every
  // part is rejected and the profile's own order stands. This is the branch
  // that reads the regex *and then* falls back, which the accepted-value test
  // above does not reach.
  const clean = await readUnderEnv({});
  const read = await readUnderEnv({ OMNI_ORDER_ANTHROPIC: "é,ü" });
  expect(read.anthropicOrder).toEqual(clean.anthropicOrder);
});
