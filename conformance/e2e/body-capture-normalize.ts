type JsonObject = Record<string, unknown>;
type Artifact = JsonObject & { client: { response: unknown } };
type Route = {
  role: string;
  present: boolean;
  body: unknown;
};
type Capture = {
  typedRows: object[];
  artifacts: Artifact[];
  routes: Route[];
  client: string | null;
};

/** Normalize only gateway-minted IDs and identified gateway-generated timestamps. */
export function canonical(value: Capture, requestId: string) {
  const ids = (v: unknown): unknown => {
    if (typeof v === "string") return v.replaceAll(requestId, "<request-id>");
    if (Array.isArray(v)) return v.map(ids);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ids(x)]));
    return v;
  };
  function response(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(frame);
    if (!v || typeof v !== "object") return v;
    const out: JsonObject = { ...v };
    if (out.object === "chat.completion" || out.object === "chat.completion.chunk")
      out.created = "<time>";
    if (out.object === "response") out.created_at = "<time>";
    // Responses SSE carries the generated timestamp on the response envelope.
    if (
      out.type === "response.created" ||
      out.type === "response.in_progress" ||
      out.type === "response.completed"
    )
      out.response = response(out.response);
    return out;
  }
  function frame(v: string): string {
    return v.replace(/^data: (.+)$/gm, (line, data) => {
      if (data === "[DONE]") return line;
      return `data: ${JSON.stringify(response(JSON.parse(data)))}`;
    });
  }
  function artifact(v: Artifact) {
    return { ...v, at: "<time>", client: { ...v.client, response: response(v.client.response) } };
  }
  // The recursor preserves shape and only substitutes portions of string values.
  const out = ids(value) as Capture;
  return {
    ...out,
    typedRows: out.typedRows.map((row) => ({ ...row, at: "<time>" })),
    artifacts: out.artifacts.map(artifact),
    routes: out.routes.map((route) => {
      if (route.role !== "admin" || !route.present) return route;
      const body = route.body as JsonObject & { artifact: Artifact | null };
      return {
        ...route,
        body: {
          ...body,
          at: "<time>",
          artifact: body.artifact === null ? null : artifact(body.artifact),
        },
      };
    }),
    client:
      out.client === null
        ? null
        : /^(?:event|data):/.test(out.client)
          ? frame(out.client)
          : JSON.stringify(response(JSON.parse(out.client))),
  };
}
