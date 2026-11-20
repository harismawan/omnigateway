import { parseAnthropicRequest } from "../../../apps/gateway/src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../../apps/gateway/src/ingress/openai.ts";
import { parseResponsesRequest } from "../../../apps/gateway/src/ingress/responses.ts";
import { openaiCodec } from "../../../packages/providers/src/openai/codec.ts";
import { toResponsesWire } from "../../../packages/providers/src/openai/wire.ts";

const rows = [];
let category = "baseline";
const base = {
  model: "pool",
  stream: false,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
function add(input: unknown) {
  const request = JSON.parse(JSON.stringify(input)) as Parameters<typeof toResponsesWire>[0];
  const model = "gpt-5-codex";
  const wire = toResponsesWire(request, model);
  const codec = openaiCodec.buildRequest({
    request,
    model,
    credentials: { apiKey: "sk-oa", accessToken: null, providerData: {} },
    fail: (c, m) => new Error(c + ":" + m),
  });
  rows.push({
    category,
    request,
    model,
    wire: JSON.stringify(wire.body),
    notes: wire.degradations,
    key: wire.cacheKey,
    codec: codec.request,
    state: codec.decodeState,
  });
}
add(base);
for (const stream of [false, true])
  for (const reasoning of [
    undefined,
    { mode: "off" },
    { mode: "betweenTools" },
    { mode: "budget", budgetTokens: 1024 },
    { mode: "adaptive" },
    { mode: "adaptive", effort: "high", display: "omitted" },
    { mode: "adaptive", effort: "max", display: "updates" },
  ])
    for (const key of [
      undefined,
      "",
      7,
      "chosen-by-caller",
      "01a143df-3401-73a0-96db-901f105e1409",
      "bad\r\nx: yes",
      "日本語",
      "x".repeat(1024),
      "x".repeat(1025),
    ]) {
      add({
        ...base,
        stream,
        reasoning,
        system: [{ type: "text", text: "be brief" }],
        maxTokens: 123,
        temperature: 0.2,
        vendor: {
          openai: {
            prompt_cache_key: key,
            session_id: "fallback",
            response_format: { type: "json_object" },
          },
        },
      });
    }
for (const answered of [false, true])
  for (const native of [false, true]) {
    const messages: unknown[] = [
      ...base.messages,
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "toolUse", id: "t", name: "read", input: { z: 1, "2": "two", a: [true] } },
        ],
      },
    ];
    if (answered)
      messages.push({
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: "t",
            content: "done",
            images: [{ mediaType: "image/png", data: "aA==" }],
          },
        ],
      });
    messages.push({
      role: "system",
      content: [
        { type: "text", text: "reminder" },
        { type: "thinking", text: "hidden" },
        { type: "image", mediaType: "image/png", data: "aA==" },
      ],
    });
    if (native)
      messages.push({
        role: "assistant",
        content: [
          {
            type: "providerNative",
            provider: "openai",
            blockType: "reasoning",
            data: { id: "strip", encrypted_content: "abc", summary: [] },
          },
        ],
      });
    for (const choice of ["auto", "any", "none", "tool"])
      add({
        ...base,
        messages,
        tools: [
          {
            kind: "portable",
            name: "read",
            description: "read it",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        toolChoice: { type: choice, name: "read" },
        vendor: { openai: { include: ["reasoning.encrypted_content"] } },
      });
  }
for (const vendor of [
  {},
  { input: [], model: "override", stream: false, store: true },
  { text: 7 },
  {
    response_format: {
      type: "json_schema",
      json_schema: { name: "n", schema: { type: "object" } },
    },
  },
  { text: { verbosity: "high", format: { type: "json_schema", schema: { type: "object" } } } },
])
  for (const conversationId of [undefined, "", "private-id"])
    add({ ...base, conversationId, vendor: { openai: vendor } });
add({ ...base, messages: [] });
for (const stream of [true, false]) {
  for (const [dialect, parse, body] of [
    [
      "anthropic",
      parseAnthropicRequest,
      {
        model: "pool",
        max_tokens: 123,
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
      },
    ],
    [
      "openai",
      parseOpenAIRequest,
      {
        model: "pool",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 123,
      },
    ],
    [
      "responses",
      parseResponsesRequest,
      { model: "pool", input: "hi", instructions: "be brief", max_output_tokens: 123 },
    ],
  ] as const) {
    const client = { ...body, stream };
    add(parse(client));
    Object.assign(rows.at(-1), { dialect, client });
  }
}
for (const mediaType of ["text/plain", "application/pdf", "application/octet-stream"])
  add({
    ...base,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "t", name: "read", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: "t",
            content: "done",
            files: [{ mediaType, data: "aGk=", name: "a.txt" }],
          },
        ],
      },
    ],
  });
category = "rich-ingress";
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
for (const stream of [false, true])
  for (const media of ["text/plain", "application/pdf", "application/octet-stream"]) {
    const image = "data:image/png;base64,aA==";
    const format = { type: "json_schema", json_schema: { name: "answer", schema } };
    const cases: unknown[] = [
      [
        "anthropic",
        parseAnthropicRequest,
        {
          model: "pool",
          max_tokens: 123,
          tools: [{ name: "read", input_schema: schema }],
          output_config: { format: { type: "json_schema", schema } },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hi" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aA==" },
                },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "c", name: "read", input: { path: "a" } }],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "c",
                  content: [
                    { type: "text", text: "done" },
                    {
                      type: "document",
                      source: { type: "base64", media_type: media, data: "aGk=" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [
        "openai",
        parseOpenAIRequest,
        {
          model: "pool",
          tools: [{ type: "function", function: { name: "read", parameters: schema } }],
          response_format: format,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hi" },
                { type: "image_url", image_url: { url: image } },
              ],
              attachments: [{ url: `data:${media};base64,aGk=`, mediaType: media }],
            },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "c",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"a"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "c", content: "done" },
          ],
        },
      ],
      [
        "responses",
        parseResponsesRequest,
        {
          model: "pool",
          tools: [{ type: "function", name: "read", parameters: schema }],
          text: { format: { type: "json_schema", name: "answer", schema } },
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "hi" },
                { type: "input_image", image_url: image },
              ],
            },
            { type: "function_call", call_id: "c", name: "read", arguments: '{"path":"a"}' },
            {
              type: "function_call_output",
              call_id: "c",
              output: [
                { type: "input_text", text: "done" },
                { type: "input_image", image_url: image },
                { type: "input_file", filename: "a", file_data: `data:${media};base64,aGk=` },
              ],
            },
          ],
        },
      ],
    ];
    for (const [dialect, parse, body] of cases) {
      const client = { ...body, stream };
      add(parse(client));
      Object.assign(rows.at(-1), { dialect, client });
    }
  }
category = "cache-history";
for (const identity of [
  {},
  { conversationId: "private" },
  { vendor: { openai: { prompt_cache_key: "chosen" } } },
  { vendor: { openai: { session_id: "session" } } },
]) {
  const first = { ...base, ...identity, system: [{ type: "text", text: "system" }] };
  const pair = rows.length;
  for (const change of ["original", "grow", "system", "opening"]) {
    const request = JSON.parse(JSON.stringify(first));
    if (change === "grow")
      request.messages.push(
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      );
    if (change === "system") request.system[0].text = "changed";
    if (change === "opening") request.messages[0].content[0].text = "changed";
    add(request);
    Object.assign(rows.at(-1), { pair, change });
  }
}
category = "foreign-drops";
for (const stream of [false, true])
  add({
    ...base,
    stream,
    betas: ["context-1m-2025-08-07"],
    tools: [
      {
        kind: "provider",
        provider: "anthropic",
        type: "web_search_20250305",
        name: "search",
        wire: { max_uses: 1 },
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "web_search_tool_result",
            data: { tool_use_id: "s" },
          },
        ],
      },
    ],
  });
category = "effort-ladder";
for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  for (const display of [undefined, "omitted", "updates"])
    add({ ...base, reasoning: { mode: "adaptive", effort, display } });
category = "literal-edges";
for (const vendor of [
  { session_id: "sess-77" },
  { prompt_cache_key: "pck-1", session_id: "sess-77" },
  { prompt_cache_key: "pck-1" },
  { session_id: 42 },
  { prompt_cache_key: 7 },
  { prompt_cache_key: "" },
  { service_tier: "priority" },
])
  add({ ...base, conversationId: "conv-a", vendor: { openai: vendor } });
for (const conversationId of ["conv-a", "conv-b"]) add({ ...base, conversationId });
for (const key of ["has space", "\t", "\x7f", "bad\r\nx: yes", "日本語"])
  for (const name of ["prompt_cache_key", "session_id"])
    add({ ...base, vendor: { openai: { [name]: key } } });
for (const messages of [[], base.messages])
  add({ ...base, system: [{ type: "text", text: "be brief" }], messages });
add({
  ...base,
  tools: [
    {
      kind: "portable",
      name: "apply_patch",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
    },
  ],
  messages: [
    {
      role: "assistant",
      content: [
        { type: "toolUse", id: "c1", name: "apply_patch", input: { input: "*** Begin Patch" } },
      ],
    },
  ],
});
console.log(JSON.stringify(rows));
