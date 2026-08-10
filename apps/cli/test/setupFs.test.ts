import { expect, test } from "bun:test";
import { atomicWriteFile } from "../src/setupFs.ts";

test("atomic setup write preserves the destination when replacement fails", () => {
  const files = new Map<string, string>([["/config/settings.json", "original"]]);

  expect(() =>
    atomicWriteFile("/config/settings.json", "replacement", {
      mkdir: () => {},
      write: (path, contents) => files.set(path, contents),
      rename: () => {
        throw new Error("replacement failed");
      },
      remove: (path) => files.delete(path),
    }),
  ).toThrow("replacement failed");

  expect(files.get("/config/settings.json")).toBe("original");
  expect([...files.keys()]).toEqual(["/config/settings.json"]);
});
