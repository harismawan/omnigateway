/** Normalize only gateway-minted IDs and identified gateway-generated timestamps. */
export function canonical(value: any, requestId: string): any {
  const ids = (v: any): any => {
    if (typeof v === "string") return v.replaceAll(requestId, "<request-id>");
    if (Array.isArray(v)) return v.map(ids);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ids(x)]));
    return v;
  };
  function response(v: any): any {
    if (Array.isArray(v)) return v.map(frame);
    if (!v || typeof v !== "object") return v;
    const out = { ...v };
    if (v.object === "chat.completion" || v.object === "chat.completion.chunk") out.created = "<time>";
    if (v.object === "response") out.created_at = "<time>";
    // Responses SSE carries the generated timestamp on the response envelope.
    if (["response.created", "response.in_progress", "response.completed"].includes(v.type))
      out.response = response(v.response);
    return out;
  }
  function frame(v: string): string {
    return v.replace(/^data: (.+)$/gm, (line, data) => {
      if (data === "[DONE]") return line;
      return "data: " + JSON.stringify(response(JSON.parse(data)));
    });
  }
  function artifact(v: any): any {
    return { ...v, at: "<time>", client: { ...v.client, response: response(v.client.response) } };
  }
  const out = ids(value);
  return {
    ...out,
    typedRows: out.typedRows.map((row: any) => ({ ...row, at: "<time>" })),
    artifacts: out.artifacts.map(artifact),
    routes: out.routes.map((route: any) => {
      if (route.role !== "admin" || !route.present) return route;
      return { ...route, body: { ...route.body, at: "<time>",
        artifact: route.body.artifact === null ? null : artifact(route.body.artifact) } };
    }),
    client: out.client === null ? null : /^(?:event|data):/.test(out.client) ? frame(out.client) : JSON.stringify(response(JSON.parse(out.client))),
  };
}
