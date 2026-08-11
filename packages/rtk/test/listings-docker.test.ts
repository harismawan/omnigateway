import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function run(command: string, lines: string[], name = "bash") {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "x", name, input: { command } }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "x", content: lines.join("\n") }],
      },
    ],
  };
  const result = transformRequest(request, { enabled: true });
  const block = result.request.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return { result, content: block.content };
}

const padding = Array.from({ length: 120 }, (_, i) => `progress ${i}`);

describe("tree and listings", () => {
  test("compresses command-gated tree output and preserves hierarchy and summary", () => {
    const children = Array.from(
      { length: 40 },
      (_, index) => `│   ├── descriptive-file-${index}.ts`,
    );
    const output = run("tree -F", [
      "project",
      "├── src/",
      ...children,
      "└── link@ -> src",
      "2 directories, 40 files",
    ]);
    expect(output.result.report.filters).toContain("tree-output");
    for (const anchor of ["project", "├── src/", "└── link@ -> src", "2 directories, 40 files"])
      expect(output.content).toContain(anchor);
  });

  test("compresses POSIX long listing but fails open on unparsed locale rows", () => {
    const rows = Array.from(
      { length: 120 },
      (_, i) => `-rw-r--r-- 1 u g 10 Aug 10 12:00 file-${i}.ts`,
    );
    const valid = run("ls -la", [
      "total 120",
      ...rows,
      "drwxr-xr-x 2 u g 4096 Aug 10 12:00 dir",
      "lrwxrwxrwx 1 u g 3 Aug 10 12:00 link -> dir",
    ]);
    expect(valid.result.report.filters).toContain("tree-output");
    expect(valid.content).toContain("link -> dir");
    const malformed = run("ls -la", [
      "total 120",
      ...rows,
      "locale-specific row impossible to count",
    ]);
    expect(malformed.result.report.filters).not.toContain("tree-output");
  });

  test("unknown path inference requires density and rejects prose conflicts", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `./src/file-${i}.ts`);
    expect(run("ignored", paths, "mystery").result.report.filters).toContain("path-list");
    expect(
      run(
        "ignored",
        [...paths.slice(0, 8), ...Array.from({ length: 92 }, () => "This is prose.")],
        "mystery",
      ).result.report.filters,
    ).not.toContain("path-list");
  });
});

describe("Docker builds", () => {
  test.each(["docker build .", "docker buildx build .", "docker compose build"])(
    "compresses %s while preserving artifacts and errors",
    (command) => {
      const anchors = [
        "#1 [1/3] FROM alpine@sha256:abc",
        "Dockerfile:4",
        "ERROR: process exited with code 1",
        "naming to docker.io/acme/app:latest",
        "digest: sha256:def",
      ];
      const progress = Array.from({ length: 120 }, () => "#1 1.0 50% transferring");
      const output = run(command, [anchors[0] ?? "", ...progress, ...anchors.slice(1)]);
      expect(output.result.report.filters).toContain("docker-build");
      for (const anchor of anchors) expect(output.content).toContain(anchor);
    },
  );

  test("never activates Docker filtering for unknown origin", () => {
    expect(
      run("docker build .", ["#1 [1/3] FROM alpine", ...padding, "exporting image"], "mystery")
        .result.report.filters,
    ).not.toContain("docker-build");
  });
});
