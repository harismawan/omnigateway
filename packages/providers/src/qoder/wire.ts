import type { CodecInput } from "../codec.ts";
import { systemText } from "../system.ts";
import { splitFiles, withFileText } from "../toolResultFiles.ts";
import type { QoderCredentialBundle } from "./credential.ts";
import { syntheticUuid } from "./device.ts";

export function toQoderWire(input: CodecInput, bundle: QoderCredentialBundle) {
  const req = input.request;
  const degradations: string[] = [];
  const note = (s: string) => {
    if (!degradations.includes(s)) degradations.push(s);
  };
  const messages: Record<string, unknown>[] = [];
  const model = bundle.models.find((m) => m.key === input.model);
  for (const message of req.messages) {
    const content: unknown[] = [];
    const calls: unknown[] = [];
    let reasoning = "";
    for (const b of message.content) {
      if ("cacheControl" in b && b.cacheControl) note("qoder:cache-control-dropped");
      switch (b.type) {
        case "text":
          content.push({ type: "text", text: b.text });
          break;
        case "image":
          if (model?.images)
            content.push({
              type: "image_url",
              image_url: { url: `data:${b.mediaType};base64,${b.data}` },
            });
          else note("qoder:images-dropped");
          break;
        case "thinking":
          reasoning += b.text;
          if (b.signature) note("qoder:thinking-signature-dropped");
          break;
        case "toolUse":
          calls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
          break;
        case "toolResult": {
          const files = splitFiles(b.files ?? [], () => false);
          messages.push({
            role: "tool",
            tool_call_id: b.toolUseId,
            content: withFileText(b.content, files.text),
            ...(b.isError ? { is_error: true } : {}),
          });
          if (b.images?.length) note("qoder:tool-result-images-dropped");
          if (files.text.length) note("qoder:tool-result-files-inlined");
          if (files.dropped) note("qoder:tool-result-files-dropped");
          if (b.native?.length) note("qoder:native-block-dropped");
          break;
        }
        default:
          note("qoder:unsupported-block-dropped");
      }
    }
    if (content.length || calls.length || reasoning) {
      const hasImage = content.some((v) => (v as { type: string }).type === "image_url");
      messages.push({
        role: message.role,
        content: hasImage ? content : content.map((v) => (v as { text: string }).text).join(""),
        ...(hasImage ? { contents: content } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
    }
  }
  const system = systemText(req.system, "qoder", note) ?? "";
  const requestId = syntheticUuid(input.requestId ?? `${bundle.machineId}:${JSON.stringify(req)}`);
  const sessionId = req.conversationId
    ? syntheticUuid(`${bundle.machineId}:${req.conversationId}`)
    : requestId;
  const parameters: Record<string, unknown> = {};
  if (req.maxTokens ?? input.maxOutputTokens)
    parameters.max_tokens = req.maxTokens ?? input.maxOutputTokens;
  if (req.temperature !== undefined) parameters.temperature = req.temperature;
  if (req.stopSequences) parameters.stop = req.stopSequences;
  if (req.toolChoice)
    parameters.tool_choice =
      req.toolChoice.type === "any"
        ? "required"
        : req.toolChoice.type === "tool"
          ? { type: "function", function: { name: req.toolChoice.name } }
          : req.toolChoice.type;
  if (req.reasoning) note("qoder:reasoning-config-dropped");
  if (req.betas?.length) note("qoder:betas-dropped");
  if (req.vendor && Object.keys(req.vendor).length) note("qoder:vendor-options-dropped");
  const tools = [];
  for (const tool of req.tools ?? []) {
    if (tool.kind === "provider") {
      note("qoder:provider-tool-dropped");
      continue;
    }
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      },
    });
  }
  const lastText =
    [...req.messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.content.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "";
  return {
    degradations,
    body: {
      request_id: requestId,
      chat_record_id: requestId,
      request_set_id: requestId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      agent_id: "agent_common",
      aliyun_user_type: "",
      chat_context: {
        text: lastText,
        features: [],
        extra: {
          context: [],
          modelConfig: { key: input.model, is_reasoning: model?.reasoning ?? false },
          originalContent: lastText,
        },
        chatPrompt: "",
        imageUrls: null,
      },
      session_type: "qodercli",
      task_id: "common",
      system,
      messages,
      tools,
      parameters,
      model_config: {
        key: input.model,
        display_name: model?.displayName ?? input.model,
        model: "",
        is_vl: model?.images ?? false,
        is_reasoning: model?.reasoning ?? false,
        ...(model?.maxInputTokens ? { max_input_tokens: model.maxInputTokens } : {}),
        source: "system",
        format: "openai",
        api_key: "",
        url: "",
      },
    },
  };
}
