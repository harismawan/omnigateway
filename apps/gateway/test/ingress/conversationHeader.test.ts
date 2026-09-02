import { expect, test } from "bun:test";
import { readConversationHeader } from "../../src/ingress/schemas.ts";

test("Codex's own session-id header names the conversation", () => {
  expect(readConversationHeader(new Headers({ "session-id": "codex-thread-1" }))).toBe(
    "codex-thread-1",
  );
});

test("a client sending both spellings is read by the one listed first", () => {
  const both = new Headers({ "x-session-id": "explicit", "session-id": "bare" });
  expect(readConversationHeader(both)).toBe("explicit");
});
