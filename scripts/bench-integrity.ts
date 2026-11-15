import type { MatrixMeta } from "./bench-matrix";
export function completeBody(meta: MatrixMeta, text: string, chunks: number): void {
  const frames =
    meta.mode === "json"
      ? [JSON.parse(text)]
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter((l) => l !== "[DONE]")
          .map((l) => JSON.parse(l));
  let content = "",
    input = 0,
    output = 0;
  for (const b of frames) {
    if (b.error || b.type === "error" || b.type === "response.failed") throw Error("error frame");
    if (meta.ingress === "chat") {
      content +=
        (meta.mode === "json"
          ? b.choices?.[0]?.message?.content
          : b.choices?.[0]?.delta?.content) ?? "";
      if (b.usage) {
        input = b.usage.prompt_tokens;
        output = b.usage.completion_tokens;
      }
    } else if (meta.ingress === "messages") {
      content +=
        meta.mode === "json"
          ? (b.content
              ?.filter((p: { type: string }) => p.type === "text")
              .map((p: { text: string }) => p.text)
              .join("") ?? "")
          : (b.delta?.text ?? "");
      input = b.usage?.input_tokens ?? b.message?.usage?.input_tokens ?? input;
      output = b.usage?.output_tokens ?? output;
    } else {
      content +=
        meta.mode === "json"
          ? (b.output
              ?.flatMap((p: { content?: { text: string }[] }) => p.content ?? [])
              .map((p: { text: string }) => p.text ?? "")
              .join("") ?? "")
          : b.type === "response.output_text.delta"
            ? b.delta
            : "";
      const u = b.usage ?? b.response?.usage;
      if (u) {
        input = u.input_tokens;
        output = u.output_tokens;
      }
    }
  }
  if (content !== "lorem ipsum ".repeat(chunks)) throw Error("aggregate text mismatch");
  if (input !== 64 || output !== chunks * 2) throw Error(`usage mismatch ${input}/${output}`);
}
