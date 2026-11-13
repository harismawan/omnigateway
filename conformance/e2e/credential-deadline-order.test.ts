import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
test("disable acknowledgment is the last mutation before its routing assertion", () => {
  const s = readFileSync(new URL("admin-routes.ts", import.meta.url), "utf8");
  const end = s.indexOf('name: "disabled credential stops routing"');
  const sql = s.lastIndexOf('name: "live malformed unrelated quota"', end);
  const patch = s.lastIndexOf(
    'steps.push(as("admin", "PATCH", "/api/credentials/{{last}}", \'{"enabled":false}\'));',
    end,
  );
  expect(sql).toBeGreaterThan(0);
  expect(patch).toBeGreaterThan(sql);
});
