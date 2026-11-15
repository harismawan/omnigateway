let calls = 0;
export function faultResponse(): Response | null {
  const mode = process.env.OMNI_BENCH_FAULT;
  if (!mode?.endsWith("-after-first") || calls++ === 0) return null;
  if (mode === "500-after-first")
    return Response.json({ error: { message: "injected 500" } }, { status: 500 });
  return new Response(
    mode === "error-frame-after-first"
      ? 'event: error\ndata: {"type":"error","error":{"message":"injected"}}\n\n'
      : "",
    { headers: { "content-type": "text/event-stream" } },
  );
}
