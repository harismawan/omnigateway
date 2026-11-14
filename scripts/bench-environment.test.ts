import { expect, test } from "bun:test";
import { performanceEnvironment } from "./bench-environment";

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
