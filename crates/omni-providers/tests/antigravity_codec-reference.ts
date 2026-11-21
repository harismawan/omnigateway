import { antigravityCodec } from "../../../packages/providers/src/antigravity/codec.ts";

type BuildInput = Parameters<typeof antigravityCodec.buildRequest>[0];
type Request = BuildInput["request"];
const rows: unknown[] = [];
for (const project of [undefined, 1, null, {}, [], "", " \t\ufeff ", " project ", "p"])
  for (const token of [null, "", "token"])
    for (const requestId of [undefined, "", "explicit", " "]) {
      const request: Request = {
        model: "m",
        stream: true,
        messages: [],
        tools: [{ kind: "portable", name: "read file", inputSchema: {} }],
      };
      const input: BuildInput = {
        request,
        model: "gemini-3.6-flash-high",
        credentials: { accessToken: token, apiKey: null, providerData: { projectId: project } },
        ...(requestId === undefined ? {} : { requestId }),
        fail: (code: string, message: string) => ({ code, message }),
      };
      try {
        const r = antigravityCodec.buildRequest(input);
        rows.push({
          project,
          token,
          requestId,
          request,
          expected: {
            request: r.request,
            degradations: r.degradations,
            cloakedTools: r.cloakedTools,
          },
        });
      } catch (e) {
        rows.push({ project, token, requestId, request, error: e });
      }
    }
for (const schema of [null, [1], "x", [], "", 1, true, [[1]], "🙂"]) {
  const request: Request = {
    model: "m",
    stream: true,
    messages: [],
    tools: [{ kind: "portable", name: "read file", inputSchema: schema }],
  };
  const input: BuildInput = {
    request,
    model: "gemini-3.6-flash-high",
    credentials: { accessToken: "token", apiKey: null, providerData: { projectId: "p" } },
    requestId: "r",
    fail: (code: string, message: string) => ({ code, message }),
  };
  try {
    const r = antigravityCodec.buildRequest(input);
    rows.push({
      project: "p",
      token: "token",
      requestId: "r",
      request,
      expected: { request: r.request, degradations: r.degradations, cloakedTools: r.cloakedTools },
    });
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    rows.push({
      project: "p",
      token: "token",
      requestId: "r",
      request,
      rawThrow: String(e),
      error: { code: "UPSTREAM", message: "antigravity codec buildRequest threw" },
    });
  }
}
{
  const request: Request = {
    model: "m",
    stream: true,
    messages: [],
    tools: [
      { kind: "portable", name: "read file", inputSchema: {} },
      { kind: "portable", name: "read file", inputSchema: null },
    ],
  };
  const r = antigravityCodec.buildRequest({
    request,
    model: "gemini-3.6-flash-high",
    credentials: { accessToken: "token", apiKey: null, providerData: { projectId: "p" } },
    requestId: "r",
    fail: (code, message) => ({ code, message }),
  });
  rows.push({
    project: "p",
    token: "token",
    requestId: "r",
    request,
    expected: { request: r.request, degradations: r.degradations, cloakedTools: r.cloakedTools },
  });
}
console.log(JSON.stringify(rows));
