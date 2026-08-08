import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { OMNI_ENCRYPTION_KEY: "a-key-that-is-long-enough-000000" };

test("applies defaults for everything but the encryption key", () => {
  const config = loadConfig(base);
  expect(config.port).toBe(9000);
  expect(config.host).toBe("127.0.0.1");
  expect(config.databasePath).toBe("./omnigateway.db");
  expect(config.baseUrl).toBe("http://127.0.0.1:9000");
});

test("refuses to boot without an encryption key", () => {
  expect(() => loadConfig({})).toThrow(/OMNI_ENCRYPTION_KEY/);
});

test("refuses a short encryption key", () => {
  expect(() => loadConfig({ OMNI_ENCRYPTION_KEY: "short" })).toThrow(/OMNI_ENCRYPTION_KEY/);
});

test("reads overrides from the environment", () => {
  const config = loadConfig({
    ...base,
    OMNI_PORT: "9100",
    OMNI_HOST: "0.0.0.0",
    OMNI_DB_PATH: "/data/omni.db",
    OMNI_BASE_URL: "https://gw.example.com",
  });
  expect(config.port).toBe(9100);
  expect(config.host).toBe("0.0.0.0");
  expect(config.databasePath).toBe("/data/omni.db");
  expect(config.baseUrl).toBe("https://gw.example.com");
});

test.each([
  ["8787", true],
  ["0", false],
  ["65536", false],
  ["", false],
  ["http", false],
  ["0x1f91", false],
  ["1e4", false],
  [" 8787", false],
  ["+8787", false],
] as const)("%s is %s a valid plain decimal port", (port, valid) => {
  const load = () => loadConfig({ ...base, OMNI_PORT: port });
  if (valid) expect(load().port).toBe(8787);
  else expect(load).toThrow(/OMNI_PORT/);
});

test.each(["", "  \t"])('treats blank OMNI_BASE_URL "%s" as unset', (baseUrl) => {
  expect(loadConfig({ ...base, OMNI_BASE_URL: baseUrl }).baseUrl).toBe("http://127.0.0.1:9000");
});

test("treats blank optional host and database path as unset", () => {
  const config = loadConfig({ ...base, OMNI_HOST: "  ", OMNI_DB_PATH: "\t" });
  expect(config.host).toBe("127.0.0.1");
  expect(config.databasePath).toBe("./omnigateway.db");
});

test("does not collapse an all-slash base url to an empty string", () => {
  expect(loadConfig({ ...base, OMNI_BASE_URL: "/" }).baseUrl).toBe("http://127.0.0.1:9000");
});

test("derives the base url from host and port when not set", () => {
  expect(loadConfig({ ...base, OMNI_HOST: "0.0.0.0", OMNI_PORT: "9100" }).baseUrl).toBe(
    "http://0.0.0.0:9100",
  );
});

test("strips a trailing slash from an explicit base url", () => {
  expect(loadConfig({ ...base, OMNI_BASE_URL: "https://gw.example.com/" }).baseUrl).toBe(
    "https://gw.example.com",
  );
});
