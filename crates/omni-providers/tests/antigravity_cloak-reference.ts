import {
  buildToolCloak,
  cloakName,
  uncloakName,
} from "../../../packages/providers/src/antigravity/cloak.ts";

const names = [
  "",
  "_",
  "a",
  "mcp__srv__tool",
  "a.b-c",
  "1abc",
  ".abc",
  "-abc",
  "read file",
  "read/file",
  "read_file",
  "🔥",
  "é",
  "a🔥🔥b",
  "a".repeat(128),
  "a".repeat(129),
  " ".repeat(200),
  "a".repeat(127) + "!",
  "a".repeat(128) + "!",
];
const rows = [];
for (const group of [
  ...names.map((n) => [n]),
  names,
  [...names].reverse(),
  ["read file", "read file"],
]) {
  for (const source of ["tools", "calls", "results", "choice", "provider", "matched-result"]) {
    const request = { model: "m", stream: true, messages: [] };
    if (source === "tools")
      request.tools = group.map((name) => ({ kind: "portable", name, inputSchema: {} }));
    if (source === "provider")
      request.tools = group.map((name) => ({
        kind: "provider",
        provider: "antigravity",
        type: "x",
        name,
        wire: {},
      }));
    if (source === "choice") request.toolChoice = { type: "tool", name: group[0] };
    if (source === "calls")
      request.messages = [
        {
          role: "assistant",
          content: group.map((name, i) => ({ type: "toolUse", id: String(i), name, input: {} })),
        },
      ];
    if (source === "results" || source === "matched-result")
      request.messages = [
        {
          role: "user",
          content: group.map((name) => ({ type: "toolResult", toolUseId: name, content: "" })),
        },
      ];
    if (source === "matched-result")
      request.messages.push({
        role: "assistant",
        content: group.map((id) => ({ type: "toolUse", id, name: "valid", input: {} })),
      });
    const cloak = buildToolCloak(request);
    rows.push({
      request,
      toWire: [...(cloak?.toWire ?? [])],
      lookups: names.map((name) => [
        name,
        cloakName(cloak, name),
        uncloakName(cloak, cloakName(cloak, name)),
      ]),
    });
  }
}
console.log(JSON.stringify(rows));
