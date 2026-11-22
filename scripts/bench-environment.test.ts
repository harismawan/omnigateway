import { expect, test } from "bun:test";
import { performanceEnvironment } from "./bench-environment";

test("credentials inside URLs are redacted without losing comparable settings", () => {
  for (const [value, expected] of [
    ["postgres://user:password@localhost/db", "postgres://<set>@localhost/db"],
    ["redis://:password@localhost/0", "redis://<set>@localhost/0"],
    [
      "https://host/path?token=private&mode=fast&api_key=hidden",
      "https://host/path?token=<set>&mode=fast&api_key=<set>",
    ],
    ["ordinary non-URL value", "ordinary non-URL value"],
  ])
    expect(performanceEnvironment(`OMNI_URL=${value}\0`).OMNI_URL).toBe(expected);
});

test("effective environment preserves settings but masks credentials", () => {
  expect(
    performanceEnvironment(
      "PATH=secret\0OMNI_PORT=18200\0OMNI_ENCRYPTION_KEY=secret\0OMNI_ACCESS_TOKEN=secret\0MIMALLOC_PURGE_DELAY=1\0",
    ),
  ).toEqual({
    OMNI_PORT: "18200",
    OMNI_ENCRYPTION_KEY: "<set>",
    OMNI_ACCESS_TOKEN: "<set>",
    MIMALLOC_PURGE_DELAY: "1",
  });
});
